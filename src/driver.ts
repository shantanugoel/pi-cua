/**
 * Thin, defensive wrapper around the `cua-driver` CLI.
 *
 * Why the CLI and not MCP or the npm SDK:
 *   - The bundled Cua skill names the CLI as the default agent surface ("Use the CLI
 *     by default when a shell is available"), and one-shot CLI calls are daemon-backed.
 *   - On macOS, Accessibility + Screen Recording are attributed to a responsible app
 *     identity. The supported standalone identity is /Applications/CuaDriver.app
 *     (com.trycua.driver). Spawning a raw `cua-driver serve` outside that bundle is
 *     documented as unsupported, so we never do it.
 *   - Staying in-process here gives us the caller-side policy seam that Cua's own docs
 *     require the caller to own (capture_id discipline, precondition re-check, consent).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter } from "node:path";

export interface CuaError {
	ok: false;
	code: string;
	message: string;
	retryable: boolean;
	hint?: string;
	raw?: string;
}

export interface CuaOk<T = unknown> {
	ok: true;
	data: T;
	/** Parsed JSON payload when the CLI emitted one. */
	json?: unknown;
	raw: string;
}

export type CuaResult<T = unknown> = CuaOk<T> | CuaError;

/** Best available human-readable output for either result shape. */
export function outputOf(result: CuaResult): string {
	return result.raw ?? (result.ok ? "" : result.message);
}

/** Re-type an untyped result as a text result, using its raw output. */
function asText(result: CuaResult): CuaResult<string> {
	if (!result.ok) return result;
	return { ...result, data: result.raw ?? "" };
}

export interface RunOptions {
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

const CANDIDATE_PATHS = [
	process.env.CUA_DRIVER_PATH,
	`${homedir()}/.local/bin/cua-driver`,
	"/usr/local/bin/cua-driver",
	"/opt/homebrew/bin/cua-driver",
	"/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
].filter((p): p is string => typeof p === "string" && p.length > 0);

/** Resolve the driver binary. Prefers PATH so a user's own install wins. */
export function resolveBinary(configured: string | null): { path: string | null; source: string } {
	if (configured) {
		return existsSync(configured)
			? { path: configured, source: "config.driver.binary" }
			: { path: null, source: `config.driver.binary (missing: ${configured})` };
	}
	if (process.env.CUA_DRIVER_PATH && existsSync(process.env.CUA_DRIVER_PATH)) {
		return { path: process.env.CUA_DRIVER_PATH, source: "env CUA_DRIVER_PATH" };
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = `${dir}/cua-driver`;
		if (existsSync(candidate)) return { path: candidate, source: "PATH" };
	}
	for (const candidate of CANDIDATE_PATHS) {
		if (existsSync(candidate)) return { path: candidate, source: "known location" };
	}
	return { path: null, source: "not found" };
}

/**
 * The CLI does not always emit JSON on failure. Observed on 0.30.4 with TCC grants
 * still pending, every `call` returns a plain-text line on stdout:
 *   permissions_pending: macOS Accessibility or Screen Recording permission is still
 *   pending; no action started, retry after the permission gate completes
 * So we must never assume stdout parses.
 */
/**
 * Classify a non-JSON failure. Driver error tokens are lowercase snake_case
 * (`permissions_pending`, `error`, `invalid_png`). Human headings such as
 * `name: get_window_state`, `bring_to_front: Persistently activate...` and
 * `Extension: cua-perception 0.2.1` are NOT error codes, so this match is
 * deliberately case-sensitive and snake_case-only.
 */
function classifyText(text: string, code: number): CuaError {
	const trimmed = text.trim();
	const first = trimmed.split("\n")[0] ?? trimmed;
	const colon = first.indexOf(":");
	const maybeCode = colon > 0 && colon < 40 ? first.slice(0, colon) : "";
	const looksLikeCode = /^[a-z][a-z0-9_]*$/.test(maybeCode);

	if (looksLikeCode) {
		const hint =
			maybeCode === "permissions_pending"
				? "Grant permissions to CuaDriver.app: `cua-driver permissions grant` (Accessibility + Screen Recording), then retry."
				: undefined;
		return {
			ok: false,
			code: maybeCode,
			message: first.slice(colon + 1).trim() || first,
			retryable: maybeCode === "permissions_pending",
			hint,
			raw: trimmed,
		};
	}
	return {
		ok: false,
		code: "driver_exit",
		message: first || `cua-driver exited with code ${code}`,
		retryable: false,
		raw: trimmed,
	};
}

/**
 * Exit status is the authority. Verified on driver 0.30.4: every success (`doctor`,
 * `status`, `describe`, `list-tools`, `extension inspect|status`) exits 0 with plain
 * text, and every genuine failure exits nonzero. `call --json` failures are FLAT JSON
 * carrying a `code` (e.g. {"code":"window_id_not_found","suggestion":...}), not the
 * {"ok":false,"error":{...}} envelope — that envelope belongs to `perception parse`
 * local mode. Assuming otherwise makes plain-text successes look like errors.
 */
function toResult<T>(code: number, stdout: string, stderr: string, timedOut: boolean): CuaResult<T> {
	if (timedOut) {
		return {
			ok: false,
			code: "timeout",
			message: "cua-driver did not finish in time",
			retryable: true,
			hint: "Raise driver.callTimeoutMs, or narrow the capture (max_image_dimension).",
		};
	}

	let parsed: unknown;
	let parsedOk = false;
	if (stdout.trim()) {
		try {
			parsed = JSON.parse(stdout);
			parsedOk = true;
		} catch {
			parsedOk = false;
		}
	}

	if (parsedOk && parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		if (obj.ok === false && obj.error && typeof obj.error === "object") {
			const err = obj.error as Record<string, unknown>;
			return {
				ok: false,
				code: typeof err.code === "string" ? err.code : "driver_error",
				message: typeof err.message === "string" ? err.message : "driver error",
				retryable: err.retryable === true,
				raw: stdout,
			};
		}
		if (code !== 0 && typeof obj.code === "string") {
			const message =
				typeof obj.message === "string"
					? obj.message
					: typeof obj.suggestion === "string"
						? `${obj.code} — ${obj.suggestion}`
						: obj.code;
			return { ok: false, code: obj.code, message, retryable: false, raw: stdout };
		}
		if (code === 0) return { ok: true, data: obj as T, json: obj, raw: stdout };
		return {
			ok: false,
			code: "driver_exit",
			message: typeof obj.message === "string" ? obj.message : (stderr.trim().split("\n")[0] ?? `exit ${code}`),
			retryable: false,
			raw: stdout,
		};
	}

	// Plain text: exit status decides. Success here is normal, not an error.
	if (code === 0) return { ok: true, data: stdout as unknown as T, raw: stdout };
	return classifyText(stdout || stderr || `cua-driver exited with code ${code}`, code);
}

/** Run one cua-driver invocation. Never throws for driver-level failures. */
export async function runCuaDriver(
	binary: string,
	args: string[],
	opts: RunOptions = {},
): Promise<CuaResult> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	return new Promise((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...opts.env },
			});
		} catch (error) {
			resolvePromise({
				ok: false,
				code: "spawn_failed",
				message: String(error instanceof Error ? error.message : error),
				retryable: false,
				hint: `Is the binary executable? Tried: ${binary}`,
			});
			return;
		}

		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let settled = false;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const abort = () => {
			timedOut = false;
			child.kill("SIGKILL");
		};
		opts.signal?.addEventListener("abort", abort, { once: true });

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", abort);
			const stdout = Buffer.concat(chunks).toString("utf8");
			const stderr = Buffer.concat(errChunks).toString("utf8");
			resolvePromise(toResult(code, stdout, stderr, timedOut));
		};

		child.stdout?.on("data", (d: Buffer) => chunks.push(d));
		child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
		child.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", abort);
			resolvePromise({
				ok: false,
				code: "spawn_error",
				message: error.message,
				retryable: false,
				hint: `Cannot exec ${binary}`,
			});
		});
		child.on("close", (code) => finish(code ?? 1));

		if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
		else child.stdin?.end();
	});
}

/** `cua-driver call <tool> [json] --json` — JSON goes via stdin to survive quoting. */
export async function callTool(
	binary: string,
	tool: string,
	args: Record<string, unknown>,
	opts: RunOptions & { session?: string } = {},
): Promise<CuaResult> {
	const payload = opts.session ? { ...args, session: opts.session } : args;
	return runCuaDriver(binary, ["call", tool, JSON.stringify(payload), "--json"], opts);
}

export async function driverVersion(binary: string, opts?: RunOptions): Promise<CuaResult<{ version: string }>> {
	const result = await runCuaDriver(binary, ["--version"], opts);
	if (!result.ok) return result;
	return { ...result, data: { version: result.raw.trim() } };
}

/**
 * `permissions status --json` has two observed shapes on 0.30.4:
 *   pending: { "daemon_running": true, "status": "unknown", "reason": "..." }
 *   granted: { "accessibility": true, "screen_recording": true, "source": {...} }
 * Normalise both into one shape instead of guessing.
 */
export async function permissionsStatus(
	binary: string,
	opts?: RunOptions,
): Promise<CuaResult<{ status: string; accessibility?: boolean; screenRecording?: boolean; daemonRunning?: boolean; reason?: string; raw: unknown }>> {
	const result = await runCuaDriver(binary, ["permissions", "status", "--json"], opts);
	if (!result.ok) return result;
	const json = (result.json ?? {}) as Record<string, unknown>;
	const accessibility = typeof json.accessibility === "boolean" ? json.accessibility : undefined;
	const screenRecording = typeof json.screen_recording === "boolean" ? json.screen_recording : undefined;
	const daemonRunning = typeof json.daemon_running === "boolean" ? json.daemon_running : undefined;
	const declared = typeof json.status === "string" ? json.status : undefined;
	const status =
		accessibility !== undefined && screenRecording !== undefined
			? accessibility && screenRecording
				? "granted"
				: "incomplete"
			: (declared ?? "unknown");
	return {
		...result,
		data: {
			status,
			accessibility,
			screenRecording,
			daemonRunning,
			reason: typeof json.reason === "string" ? json.reason : undefined,
			raw: json,
		},
	};
}

export async function daemonStatus(binary: string, opts?: RunOptions): Promise<CuaResult<{ running: boolean; raw: string }>> {
	const result = await runCuaDriver(binary, ["status"], opts);
	// `status` exits non-zero when the daemon is down, and says so in text.
	const raw = outputOf(result);
	return { ok: true, data: { running: /daemon is running/i.test(raw), raw }, raw };
}

/**
 * `cua-driver list-tools` prints `name: first line of description`. It works without
 * TCC grants, so it is a safe capability probe.
 */
export async function listTools(
	binary: string,
	opts?: RunOptions,
): Promise<CuaResult<Array<{ name: string; summary: string }>>> {
	const result = await runCuaDriver(binary, ["list-tools"], opts);
	if (!result.ok) return result;
	const tools = result.raw
		.split("\n")
		.map((line) => {
			const idx = line.indexOf(":");
			if (idx <= 0) return null;
			const name = line.slice(0, idx).trim();
			if (!/^[a-z0-9_]+$/i.test(name)) return null;
			return { name, summary: line.slice(idx + 1).trim() };
		})
		.filter((t): t is { name: string; summary: string } => t !== null);
	return { ...result, data: tools };
}

/** Full parameter/semantics text for one tool, for on-demand model self-service. */
export async function describeTool(binary: string, tool: string, opts?: RunOptions): Promise<CuaResult<string>> {
	if (!/^[a-z0-9_]+$/i.test(tool)) {
		return { ok: false, code: "bad_tool_name", message: `invalid tool name: ${tool}`, retryable: false };
	}
	const result = await runCuaDriver(binary, ["describe", tool], opts);
	if (!result.ok) return result;
	return { ...result, data: (result.raw ?? "").trim() };
}

/**
 * Start the daemon through LaunchServices so TCC attribution lands on
 * com.trycua.driver. We never spawn a raw `cua-driver serve`.
 */
export async function startDaemon(permissionMode: "standard" | "bounded"): Promise<CuaResult<string>> {
	if (process.platform !== "darwin") {
		return {
			ok: false,
			code: "unsupported_platform",
			message: `auto-start is only implemented for macOS, not ${process.platform}`,
			retryable: false,
			hint: "Start the driver daemon yourself, then re-run /cua status.",
		};
	}
	const args = ["-n", "-g", "-a", "CuaDriver", "--args", "serve"];
	if (permissionMode === "bounded") {
		return {
			ok: false,
			code: "bounded_requires_manifest",
			message: 'permissionMode "bounded" needs a reviewed capability manifest passed to `serve`',
			retryable: false,
			hint: "Start it yourself: cua-driver serve --permission-mode bounded --capability-manifest <file> --approve-capability-manifest, or set driver.permissionMode to \"standard\".",
		};
	}
	return asText(await runCuaDriver("/usr/bin/open", args, { timeoutMs: 30_000 }));
}

/** Ask the driver itself how to grant; this is the documented correct path. */
export async function grantPermissions(binary: string, opts?: RunOptions): Promise<CuaResult<string>> {
	return asText(await runCuaDriver(binary, ["permissions", "grant"], { timeoutMs: 300_000, ...opts }));
}