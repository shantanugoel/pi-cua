/**
 * Persistent MCP stdio connection to `cua-driver mcp`.
 *
 * Why this exists: capture state lives in a per-connection registry. Verified on
 * driver 0.30.4 — the same capture_id that a second one-shot CLI process reports as
 * "capture id is unknown" resolves fine on a persistent MCP connection. So
 * capture-bound `parse_visual_regions` and capture-bound pixel clicks are only
 * reachable through a long-lived connection like this one (or the typed SDK).
 *
 * Protocol: legacy `2025-06-18`, negotiated via initialize.params.protocolVersion,
 * then metadata-free requests. The modern `2026-07-28` revision needs per-request
 * _meta and is not required here.
 *
 * This connection is also the ONLY session that owns our captures and screenshots.
 * Measured on 0.30.4: `zoom` and a window-local `click x,y` both answer
 * `screenshot_context_missing` over a fresh one-shot CLI transport even when issued
 * immediately after a snapshot, and succeed on the transport that took it. So every
 * call that consumes snapshot state has to arrive here, not just capture-bound ones.
 *
 * Lifecycle: start lazily from the command or tool that needs it, never in the
 * extension factory, and stop idempotently from session_shutdown.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_STDERR_KEPT = 4000;

export interface McpCallResult {
	ok: boolean;
	isError: boolean;
	/** MCP `structuredContent` — the typed payload, preferred. */
	structured?: unknown;
	/** Concatenated text content blocks. */
	text: string;
	/**
	 * MCP `image` content blocks. These are NOT metadata: for a capture the driver puts
	 * the screenshot HERE and keeps only `screenshot_width/height/mime_type` in
	 * structuredContent. A client that reads text + structuredContent only will report a
	 * screenshot it never received, and will lose the session's screenshot context for
	 * `zoom` / `from_zoom` / window-local `x,y`.
	 */
	images: Array<{ data: string; mimeType: string }>;
	raw: unknown;
}

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
}

export class CuaMcp {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private stderrTail = "";
	private dead = false;
	toolNames: string[] = [];

	private constructor(readonly binary: string) {}

	static async start(
		binary: string,
		opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
	): Promise<CuaMcp> {
		const conn = new CuaMcp(binary);
		await conn.launch(opts.timeoutMs ?? 30_000, opts.env);
		return conn;
	}

	private async launch(timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
		this.child = spawn(this.binary, ["mcp"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		}) as ChildProcessWithoutNullStreams;

		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_KEPT);
		});
		this.child.on("exit", (code) => this.failAll(`cua-driver mcp exited (code ${code})`));
		this.child.on("error", (error: Error) => this.failAll(`cua-driver mcp failed: ${error.message}`));

		const init = await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-cua", version: "0.1.0" },
			},
			timeoutMs,
		);
		if (init.error) throw new Error(`mcp initialize failed: ${init.error.message ?? "unknown"}`);
		this.notify("notifications/initialized", {});

		const tools = await this.request("tools/list", {}, timeoutMs);
		const list: Array<{ name?: string }> = tools.result?.tools ?? [];
		this.toolNames = list.map((t) => t.name).filter((n): n is string => typeof n === "string");
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.id !== undefined && this.pending.has(message.id)) {
				const entry = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				clearTimeout(entry.timer);
				entry.resolve(message);
			}
			// Notifications (no id) are not needed for this integration.
		}
	}

	private request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
		if (!this.child || this.dead) return Promise.reject(new Error("mcp connection is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
				if (error) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	private notify(method: string, params: unknown): void {
		this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}

	private failAll(reason: string): void {
		this.dead = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.pending.clear();
	}

	alive(): boolean {
		return !this.dead && this.child !== null && this.child.exitCode === null;
	}

	lastStderr(): string {
		return this.stderrTail.trim();
	}

	async call(tool: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<McpCallResult> {
		const response = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs);
		if (response.error) {
			return {
				ok: false,
				isError: true,
				text: response.error.message ?? "mcp tool error",
				structured: response.error,
				images: [],
				raw: response,
			};
		}
		const result = response.result ?? {};
		const blocks: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> = Array.isArray(result.content)
			? result.content
			: [];
		const text = blocks
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
		const images = blocks
			.filter((b) => b.type === "image" && typeof b.data === "string" && b.data.length > 0)
			.map((b) => ({ data: b.data as string, mimeType: b.mimeType ?? "image/png" }));
		const structured = result.structuredContent;
		const isError = result.isError === true;
		return { ok: !isError, isError, structured, text, images, raw: response };
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = null;
		this.dead = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("mcp connection closed"));
		}
		this.pending.clear();
		if (!child || child.exitCode !== null) return;
		try {
			child.stdin.end();
		} catch {
			/* already gone */
		}
		child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

/** Pull the useful payload out of an MCP result, tolerating both shapes. */
export function mcpPayload(result: McpCallResult): Record<string, unknown> {
	if (result.structured && typeof result.structured === "object") return result.structured as Record<string, unknown>;
	const text = result.text.trim();
	if (text.startsWith("{")) {
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			/* fall through */
		}
	}
	return { message: result.text };
}