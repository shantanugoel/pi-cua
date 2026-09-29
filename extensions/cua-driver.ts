/**
 * pi-cua: Cua Driver computer-use tools for Pi.
 *
 * OFF by default. Tools are always registered but stay inactive until the user opts
 * in, so a fresh install costs nothing in context or permissions:
 *   - set `driver.enabled: true` in ~/.pi/agent/pi-cua.json, or
 *   - run `pi` with PI_CUA=1, or
 *   - run `/cua on` in a session.
 *
 * Design notes:
 *   - Five tools instead of mirroring the driver's 58. The driver's own skill defines
 *     the loop (observe -> act once -> verify), so we expose that loop and let
 *     `cua_describe` serve parameter details on demand. This keeps Pi's context lean.
 *   - Mutating actions prompt only when the user asks for it: `policy.confirmActions`
 *     defaults to false, and `policy.autoMode` (the "never prompt me" switch) overrides
 *     it. When prompting IS on and there is no UI to consent through, we fail closed.
 *   - The caller (us) owns capture_id discipline and preconditions. Cua's docs are
 *     explicit that a decision or a successful exit is not proof of task success.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONFIG_PATH, expandPath, loadConfig, saveConfig, type PiCuaConfig } from "../src/config.ts";
import {
	callTool,
	daemonStatus,
	describeTool,
	driverVersion,
	grantPermissions,
	listTools,
	permissionsStatus,
	resolveBinary,
	runCuaDriver,
	outputOf,
	startDaemon,
	type CuaError,
	type CuaResult,
} from "../src/driver.ts";
import { CaptureLedger, checkApp, checkTool, consentLabel } from "../src/policy.ts";
import { CuaMcp, mcpPayload, type McpCallResult } from "../src/mcp.ts";
import {
	collectImages,
	overByteBudget,
	overDimensionProfile,
	DEFAULT_LIMITS,
	finalizeImage,
	imageMeta,
	suggestLongEdge,
	type DeliveredImage,
	type InlineLimits,
} from "../src/image.ts";
import { PERCEPTION_NOTICE, classifyPerception, findRelease, installPerception, removePerception } from "../src/perception.ts";

const TOOL_NAMES = ["cua_status", "cua_observe", "cua_act", "cua_verify", "cua_describe"] as const;

/**
 * The one always-active tool. pi documents exactly this pattern
 * (docs/extensions.md: "Register every tool first, keep optional tools inactive, and
 * use pi.setActiveTools() from a loader tool"). Without it a model cannot self-enable:
 * an inactive tool is absent from the tool list entirely, so calling it throws
 * "Unknown tool name"; extension commands are not model-invocable; and ctx.reload()
 * lives on the command context, not the tool context.
 */
const LOADER_TOOL = "cua_enable";

const MAX_MODEL_BYTES = 24_000;

/** Pi requires tool content as content blocks, not a bare string. */
function tc(value: string): TextContent[] {
	return [{ type: "text", text: value }];
}

/**
 * Text plus REAL image blocks. A screenshot that only exists as a `bytes_b64` count in a
 * JSON string is not perception: the model sees metadata and nothing else, which is how a
 * canvas app becomes undrivable. This is the model-facing delivery point.
 */
function resultContent(text: string, images: DeliveredImage[]): (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [{ type: "text", text }];
	for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return blocks;
}

/** One-line provenance for an attached screenshot, so the model can bind to it. */
function imageLead(image: DeliveredImage, label: string): string {
	return (
		`${label} attached as an image block: ${image.width}x${image.height} ${image.mimeType}, sha256 ${image.sha256
			.slice(0, 16)}… . Read x,y straight off this image — that is the space the driver expects.\n`
	);
}

/** Inline-image ceiling for the current model, falling back to Pi's own defaults. */
function limitsFor(ctx: ExtensionContext): InlineLimits {
	const resize = ctx.model?.inputLimits?.images?.resize as Partial<InlineLimits> | undefined;
	return {
		maxBytes: resize?.maxBytes ?? DEFAULT_LIMITS.maxBytes,
		maxWidth: resize?.maxWidth ?? DEFAULT_LIMITS.maxWidth,
		maxHeight: resize?.maxHeight ?? DEFAULT_LIMITS.maxHeight,
	};
}

/**
 * A capture only reaches the model if the current model accepts image input — the same
 * check Pi's own `read` tool makes. Attaching one to a text-only model risks a rejected
 * request, and the model would still be blind to it. The capture itself stays valid, so
 * capture-bound actions remain legal; what is lost is the model's own eyes, and it has
 * to be told that in as many words.
 */
function forModel(ctx: ExtensionContext, image: DeliveredImage | null): { images: DeliveredImage[]; omitted?: string } {
	if (!image) return { images: [] };
	const input = (ctx.model as { input?: string[] } | undefined)?.input;
	if (ctx.model && Array.isArray(input) && !input.includes("image")) {
		return { images: [], omitted: `the current model (${ctx.model.id}) does not accept image input` };
	}
	return { images: [image] };
}

/** Normalise an MCP tool error into our error shape (a CuaError, ready for fail()). */
function mcpFailure(call: McpCallResult): { ok: false; code: string; message: string; retryable: boolean } {
	const payload = mcpPayload(call);
	return {
		ok: false,
		code: String(payload.code ?? "driver_error"),
		message: call.text || (typeof payload.message === "string" ? payload.message : "driver error"),
		retryable: payload.retryable === true,
	};
}

/** Keep large AX trees out of model context; hand the model a file instead. */
function bounded(label: string, payload: string): { content: string; truncated: boolean; file?: string } {
	if (payload.length <= MAX_MODEL_BYTES) return { content: payload, truncated: false };
	const dir = join(tmpdir(), "pi-cua");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${label}-${Date.now()}.json`);
	writeFileSync(file, payload, "utf8");
	return {
		content: `${payload.slice(0, MAX_MODEL_BYTES)}\n\n[truncated: ${payload.length} bytes total. Full output: ${file}]`,
		truncated: true,
		file,
	};
}

/**
 * Mode-independent capture target key. A capture belongs to a (pid, window_id) or a
 * display, not to whichever tool happened to take it, so observe and act must agree.
 */
function targetKey(pid?: number, windowId?: number, displayId?: string): string {
	if (displayId) return `desktop:${displayId}`;
	return `win:${pid ?? "-"}:${windowId ?? "-"}`;
}

function fail(result: CuaError): never {
	const hint = result.hint ? `\nhint: ${result.hint}` : "";
	throw new Error(`[${result.code}] ${result.message}${hint}`);
}

const Target = Type.Object(
	{
		pid: Type.Optional(Type.Number({ description: "Owning process id of the exact target app." })),
		window_id: Type.Optional(Type.Number({ description: "Exact window id from list_windows / get_window_state." })),
		element_token: Type.Optional(
			Type.String({ description: "Fresh element token returned by the latest snapshot. PREFERRED over element_index." }),
		),
		element_index: Type.Optional(Type.Number({ description: "Index from the latest snapshot. Replaced by the next snapshot." })),
		x: Type.Optional(Type.Number({ description: "Window-local screenshot pixel x, read off the attached screenshot of a fresh capture of the same target." })),
		y: Type.Optional(Type.Number({ description: "Window-local screenshot pixel y." })),
		snapshot_id: Type.Optional(
			Type.String({
				description: "snapshot_id from the latest observation. Required by element actions when addressing by element_index rather than element_token.",
			}),
		),
		display_id: Type.Optional(Type.String({ description: 'Desktop target display, e.g. "primary".' })),
	},
	{ description: "Exact target. A session is lifecycle metadata, not capture scope or permission authority." },
);

const StatusParams = Type.Object({ diagnose: Type.Optional(Type.Boolean({ description: "Include `cua-driver doctor` output." })) });

const ObserveParams = Type.Object({
	mode: Type.Union(
		[
			Type.Literal("apps"),
			Type.Literal("windows"),
			Type.Literal("window"),
			Type.Literal("desktop"),
			Type.Literal("screen"),
			Type.Literal("regions"),
		],
		{
			description:
				"apps | windows | window (AX tree) | desktop (full display) | screen (size) | regions (OCR+icon regions from a capture_id; needs the optional cua-perception extension).",
		},
	),
	pid: Type.Optional(Type.Number({ description: "Required for mode=windows filtering and mode=window." })),
	window_id: Type.Optional(Type.Number({ description: "Required for mode=window." })),
	capture_id: Type.Optional(
		Type.String({ description: "mode=regions only: capture_id from a get_window_state / get_desktop_state observation." }),
	),
	kinds: Type.Optional(
		Type.Array(Type.Union([Type.Literal("text"), Type.Literal("icon")]), {
			description: "mode=regions only: restrict region kinds. Defaults to both.",
		}),
	),
	min_confidence: Type.Optional(Type.Number({ description: "mode=regions only: drop low-confidence regions." })),
	max_regions: Type.Optional(Type.Number({ description: "mode=regions only: bound the result set." })),
	max_image_dimension: Type.Optional(Type.Number({ description: "Cap capture size; large captures are slow to score downstream." })),
	include_markdown: Type.Optional(Type.Boolean({ description: "Also return the legacy tree_markdown rendering (verbose)." })),
	include_screenshot: Type.Optional(
		Type.Boolean({
			description:
				"mode=window: set false for the cheap tree-only re-index before an element action. Default true. Caution: a snapshot without a screenshot REPLACES the session's screenshot context, so zoom and x,y actions fail with screenshot_context_missing until you re-observe with it on.",
		}),
	),
	include_accessibility_tree: Type.Optional(
		Type.Boolean({
			description:
				"mode=window: set false to skip the AX walk entirely and get the screenshot only — the right call on canvas surfaces (Blender, Figma, DAWs, games) where the tree is empty anyway and the walk is the expensive part.",
		}),
	),
	timeout_ms: Type.Optional(Type.Number({ description: "mode=window: bound the AX walk (driver default 1000)." })),
});

const ActParams = Type.Object({
	action: Type.String({
		description:
			"Driver tool name to dispatch, e.g. click, type_text, press_key, hotkey, scroll, invoke_menu, set_value, launch_app. Run cua_describe first for its exact parameters.",
	}),
	target: Type.Optional(Target),
	args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Extra parameters for the action, verbatim." })),
	capture_id: Type.Optional(
		Type.String({ description: "capture_id from the observation this action is grounded on, when the action accepts one." }),
	),
	note: Type.String({ description: "One sentence: which app/window, what you are changing, and why. Shown in the consent prompt." }),
});

const VerifyParams = Type.Object({
	pid: Type.Number({ description: "Target pid." }),
	window_id: Type.Optional(Type.Number({ description: "Target window id." })),
	expect: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Expectation object for verify_state." })),
	snapshot_fallback: Type.Optional(Type.Boolean({ description: "If verify_state is unavailable, return a fresh snapshot instead." })),
});

const DescribeParams = Type.Object({
	tool: Type.Optional(Type.String({ description: "Driver tool to describe. Omit to list all tools." })),
});

export default function (pi: ExtensionAPI) {
	let config: PiCuaConfig = loadConfig();
	const captures = new CaptureLedger();
	const consentedApps = new Set<string>();
	let sessionLabel = `${config.driver.sessionLabelPrefix}-unknown`;
	let toolsCache: { at: number; data: Array<{ name: string; summary: string }> } | null = null;
	/** Set by cua_enable without persisting, so a model can opt in for one session. */
	let sessionEnabled = false;
	/** Effective enablement: persisted config OR this session's cua_enable. */
	function enabled(): boolean {
		return config.driver.enabled || sessionEnabled;
	}
	/**
	 * Capture state AND screenshot context are per-connection, so every call that produces
	 * or consumes a capture, a snapshot, or a zoom must share one long-lived MCP child.
	 * Started lazily, never in the factory, and stopped from session_shutdown.
	 */
	let mcp: CuaMcp | null = null;

	async function ensureMcp(_ctx: ExtensionContext): Promise<CuaMcp> {
		if (mcp?.alive()) return mcp;
		// A replaced connection is a new driver session, so every capture_id issued on the old
		// one is already dead there. Drop them locally and let our own stale_capture hint
		// explain it instead of forwarding a cryptic driver error.
		captures.forget();
		const bin = binary();
		try {
			mcp = await CuaMcp.start(bin, { timeoutMs: Math.min(60_000, config.driver.callTimeoutMs) });
			return mcp;
		} catch (error) {
			mcp = null;
			throw new Error(
				`could not open a persistent cua-driver mcp connection: ${String(error instanceof Error ? error.message : error)}`,
			);
		}
	}

	/**
	 * One capture, delivered at a size the model can actually receive.
	 *
	 * The pixels handed to the model must BE the image the reported geometry describes:
	 * the driver translates window-local screenshot pixels using ITS snapshot (measured:
	 * x=99999 px -> 121937.6 pt at the driver's own scale), so rescaling bytes after the
	 * fact would mis-aim every click while reporting a healthy result. An oversized frame
	 * is therefore re-requested from the driver at a smaller long edge, which keeps
	 * `screenshot_width/height` and the delivered pixels the same image. If it still
	 * cannot fit we omit the image and say why — a missing screenshot is a reportable
	 * failure, a silently rescaled one is not.
	 */
	async function grab(
		conn: CuaMcp,
		tool: string,
		args: Record<string, unknown>,
		limits: InlineLimits,
	): Promise<
		| { ok: true; payload: Record<string, unknown>; image: DeliveredImage | null; note?: string }
		| { ok: false; code: string; message: string; retryable: boolean }
	> {
		const call = await conn.call(tool, args, config.driver.callTimeoutMs);
		if (!call.ok) return mcpFailure(call);
		let split = collectImages(mcpPayload(call), call.images);
		let image = split.images.length ? finalizeImage(split.images[0]) : null;
		let note = image ? undefined : "the driver returned no image for this capture";

		let attempts = 0;
		while (image) {
			// Only the byte ceiling is worth a re-capture: it can get the whole request
			// rejected. Oversized dimensions are a token-cost note, not a failure.
			const problem = overByteBudget(image, limits);
			if (!problem) break;
			const longEdge = Math.max(
				Number(split.payload.screenshot_width ?? 0),
				Number(split.payload.screenshot_height ?? 0),
				image.width ?? 0,
				image.height ?? 0,
			);
			const next = attempts < 2 ? suggestLongEdge(longEdge, image, limits) : 0;
			if (!next) {
				note = `${problem}; re-observe with max_image_dimension:${Math.max(512, Math.floor(longEdge / 2))}`;
				image = null;
				break;
			}
			attempts++;
			const retry = await conn.call(tool, { ...args, max_image_dimension: next }, config.driver.callTimeoutMs);
			if (!retry.ok) {
				note = `${problem}; the smaller re-capture at max_image_dimension:${next} failed (${retry.text.slice(0, 160)})`;
				image = null;
				break;
			}
			split = collectImages(mcpPayload(retry), retry.images);
			image = split.images.length ? finalizeImage(split.images[0]) : null;
			note = image ? `re-captured at max_image_dimension:${next} to fit the inline-image budget` : "the driver returned no image for this capture";
		}
		return { ok: true, payload: split.payload, image, note };
	}

	const runOpts = (ctx: ExtensionContext) => ({ timeoutMs: config.driver.callTimeoutMs, signal: ctx.signal });

	function binary(): string {
		const resolved = resolveBinary(config.driver.binary);
		if (!resolved.path) {
			throw new Error(
				`cua-driver not found (${resolved.source}). Install it:\n  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"\nThen: open -n -g -a CuaDriver --args serve`,
			);
		}
		return resolved.path;
	}

	function setActive(active: boolean): void {
		const current = pi.getActiveTools();
		// The loader stays resident in both directions: it is the entry point a model
		// uses to turn the rest on, so removing it would strand the capability.
		if (active) {
			pi.setActiveTools([...new Set([...current, LOADER_TOOL, ...TOOL_NAMES])]);
		} else {
			pi.setActiveTools(
				[...new Set([...current, LOADER_TOOL])].filter(
					(name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]),
				),
			);
		}
	}

	// ---------------------------------------------------------------- tools

	const LoaderParams = Type.Object({
		persist: Type.Optional(
			Type.Boolean({
				description: "Also write driver.enabled=true to ~/.pi/agent/pi-cua.json so it survives restart. Default false: this session only.",
			}),
		),
	});

	// ------------------------------------------------------------------ loader

	pi.registerTool({
		name: LOADER_TOOL,
		label: "Enable Cua",
		description:
			"Activate the Cua computer-use tools (cua_status, cua_observe, cua_act, cua_verify, cua_describe) for this session. Use when a task needs to drive a native GUI app. Performs no desktop access and no GUI action itself.",
		promptSnippet: "Call first if the cua_observe/cua_act tools are not available.",
		promptGuidelines: [
			"To drive a native GUI app, call cua_enable, then cua_status, then cua_observe. Never infer window state from memory.",
		],
		parameters: LoaderParams,
		async execute(_id, params: Static<typeof LoaderParams>, _signal, _u, ctx) {
			const bin = resolveBinary(config.driver.binary);
			if (!bin.path) {
				return {
					content: tc(
						"Cua Driver is not installed, so there is nothing to enable. Ask the user to install it:\n" +
							'  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"\n' +
							"Then start the daemon: open -n -g -a CuaDriver --args serve",
					),
					details: { enabled: false, reason: "driver_missing" },
				};
			}
			sessionEnabled = true;
			if (params.persist) {
				config.driver.enabled = true;
				saveConfig(config);
			}
			setActive(true);
			const perms = await permissionsStatus(bin.path);
			const lines = [
				`Cua enabled ${params.persist ? "(persisted)" : "for this session only"}.`,
				`tools: ${TOOL_NAMES.join(", ")}`,
				`permissions: ${perms.ok ? JSON.stringify(perms.json).slice(0, 200) : "unknown: " + perms.message}`,
			];
			lines.push(`Next: cua_status, then cua_observe. Consent posture: ${consentLabel(config)}.`);
			if (!params.persist) lines.push("Stays on until `/cua off` or a new session. Use persist:true to survive restarts and /reload.");
			return {
				content: tc(lines.join("\n")),
				details: { enabled: true, persisted: params.persist === true, permissions: perms.ok ? perms.json : perms.code },
			};
		},
	});

	pi.registerTool({
		name: "cua_status",
		label: "Cua status",
		description:
			"Report Cua Driver install, daemon, permission and capability state. Read-only, no desktop access. Call this before any other cua_* tool.",
		promptSnippet: "Check Cua Driver install/daemon/TCC permission state.",
		promptGuidelines: [
			"Call cua_status once before driving a GUI; do not retry actions while permissions_pending is reported.",
			"Never treat a successful tool exit as task success: verify the postcondition with cua_verify or a fresh cua_observe.",
		],
		parameters: StatusParams,
		async execute(_id, params: Static<typeof StatusParams>, signal, _u, ctx) {
			const bin = resolveBinary(config.driver.binary);
			const out: Record<string, unknown> = {
				binary: bin,
				configPath: CONFIG_PATH,
				driverEnabled: enabled(),
				s1Enabled: config.s1.enabled,
				permissionMode: config.driver.permissionMode,
				sessionLabel,
			};
			if (!bin.path) {
				out.installHint =
					'/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)" then: open -n -g -a CuaDriver --args serve';
				return { content: tc(JSON.stringify(out, null, 2)), details: out };
			}
			const [version, daemon, perms] = await Promise.all([
				driverVersion(bin.path, runOpts(ctx)),
				daemonStatus(bin.path, runOpts(ctx)),
				permissionsStatus(bin.path, runOpts(ctx)),
			]);
			out.version = version.ok ? version.data.version : { error: version.message };
			out.daemonRunning = daemon.ok ? daemon.data.running : false;
			out.permissions = perms.ok ? perms.data : { status: "unknown", error: perms.message };
			if (!out.daemonRunning && config.driver.autoStartDaemon) {
				const started = await startDaemon(config.driver.permissionMode);
				out.daemonStart = started.ok ? "requested via LaunchServices (attributed to com.trycua.driver)" : { error: started.message };
				const recheck = await daemonStatus(bin.path, runOpts(ctx));
				out.daemonRunning = recheck.ok && recheck.data.running;
			}
			if (params.diagnose && bin.path) {
				const doctor = await runCuaDriver(bin.path, ["doctor"], runOpts(ctx));
				out.doctor = outputOf(doctor).trim();
			}
			// Perception is an optional, separately licensed extension (its OmniParser
			// icon detector is AGPL-3.0-only). We only ever DETECT it; this package never
			// installs it, and install_extension stays in policy.denyTools.
			if (bin.path) {
				const perception = await runCuaDriver(bin.path, ["extension", "status", "cua-perception"], runOpts(ctx));
				const text = outputOf(perception);
				const perc = classifyPerception(text);
				out.perception = perc.state;
				if (perc.version) out.perceptionVersion = perc.version;
				if (perc.detail) out.perceptionDetail = perc.detail;
				if (out.perception === "not_installed") {
					out.perceptionNote =
						"parse_visual_regions is unavailable, so non-AX surfaces (Chromium content, canvas apps) fall back to the accessibility tree, typed browser state, or screenshot reasoning. Enable it with `/cua perception install` (fetches the signed artifact from Cua's release; includes an AGPL-3.0-only component).";
				}
				const release = await findRelease();
				out.perceptionRelease = release.ok ? release.data.tag : `unavailable: ${release.message}`;
			}
			out.mcpConnection = mcp?.alive()
				? { alive: true, tools: mcp.toolNames.length }
				: {
						alive: false,
						note:
							"opens on first capture or action; captures, visual regions and EVERY cua_act action share it, because capture and screenshot context are per-connection, not per-daemon",
				  };
			const body = JSON.stringify(out, null, 2);
			return { content: tc(body), details: out };
		},
	});

	pi.registerTool({
		name: "cua_observe",
		label: "Cua observe",
		description:
			"Read-only observation of the desktop: apps, windows, one window's accessibility tree, or the full display. Always observe before acting; a fresh snapshot replaces prior element handles.",
		promptSnippet: "Observe apps, windows, or one window's accessibility tree before acting.",
		promptGuidelines: [
			"Call cua_observe mode=window once per (pid, window_id) per turn before any element-indexed action; the index map is replaced by the next snapshot.",
			"Prefer element_token over element_index plus snapshot_id, and never invent indices.",
			"An empty accessibility tree and a failed capture are different failures; do not infer pixels from a missing image.",
		],
		parameters: ObserveParams,
		async execute(_id, params: Static<typeof ObserveParams>, _signal, _u, ctx) {
			const bin = binary();
			let tool = "list_apps";
			const args: Record<string, unknown> = {};
			if (params.mode === "windows") {
				// `list_windows` returns every layer-0 window WindowServer knows about, including
				// off-Space and stale ones, and its FIRST entry is often not the visible window.
				// Feeding such an id to get_window_state yields ax_window_unresolved with 0
				// elements, which is indistinguishable from a broken Accessibility grant. So mark
				// each entry with whether get_accessibility_tree sees it on screen, and sort those
				// first. Measured here: list_windows[0] matched the visible window for 1 of 3 pids.
				const tree = await callTool(bin, "get_accessibility_tree", {}, runOpts(ctx));
				const onScreen = new Map<string, Record<string, unknown>>();
				if (tree.ok && tree.json && typeof tree.json === "object") {
				const wins = (tree.json as Record<string, unknown>).windows;
				if (Array.isArray(wins)) {
				for (const w of wins) {
				const rec = w as Record<string, unknown>;
				const id = Number(rec.window_id);
				if (Number.isFinite(id)) onScreen.set(`${Number(rec.owner_pid ?? rec.pid)}:${id}`, rec);
				}
				}
				}
				const listed = await callTool(bin, "list_windows", params.pid ? { pid: params.pid } : {}, runOpts(ctx));
				const rows: Array<Record<string, unknown>> = [];
				const seen = new Set<string>();
				const listedJson = listed.ok && listed.json && typeof listed.json === "object" ? (listed.json as Record<string, unknown>).windows : undefined;
				if (Array.isArray(listedJson)) {
				for (const w of listedJson) {
				const rec = w as Record<string, unknown>;
				const pid = Number(rec.owner_pid ?? rec.pid ?? params.pid ?? 0);
				const id = Number(rec.window_id);
				if (!Number.isFinite(id)) continue;
				const key = `${pid}:${id}`;
				seen.add(key);
				rows.push({ pid, window_id: id, title: rec.title ?? rec.name ?? "", layer: rec.layer, on_screen: onScreen.has(key) });
				}
				}
				for (const [key, rec] of onScreen) {
				if (seen.has(key)) continue;
				const [pidStr, idStr] = key.split(":");
				const pid = Number(pidStr);
				if (params.pid && pid !== params.pid) continue;
				rows.push({ pid, window_id: Number(idStr), title: rec.title ?? rec.name ?? "", on_screen: true });
				}
				rows.sort((a, b) => Number(b.on_screen) - Number(a.on_screen));
				const usable = rows.filter((r) => r.on_screen).length;
				return {
				content: [
				{
				type: "text",
				text:
				`On-screen-confirmed windows: ${usable} of ${rows.length}. Use only on_screen=true ids for get_window_state; the rest are off-Space or stale and will report ax_window_unresolved.\n` +
				JSON.stringify(rows.slice(0, 60), null, 1),
				},
				],
				details: { mode: "windows", on_screen: usable, total: rows.length, rows },
				};
			} else if (params.mode === "window") {
				tool = "get_window_state";
				if (!params.pid || !params.window_id) fail({ ok: false, code: "bad_request", message: "mode=window needs pid and window_id", retryable: false });
				args.pid = params.pid;
				args.window_id = params.window_id;
				if (params.max_image_dimension) args.max_image_dimension = params.max_image_dimension;
				if (params.include_markdown) args.include_markdown = true;
				if (params.include_screenshot !== undefined) args.include_screenshot = params.include_screenshot;
				if (params.include_accessibility_tree !== undefined) args.include_accessibility_tree = params.include_accessibility_tree;
				if (params.timeout_ms !== undefined) args.timeout_ms = params.timeout_ms;
			} else if (params.mode === "desktop") {
				tool = "get_desktop_state";
				if (params.max_image_dimension) args.max_image_dimension = params.max_image_dimension;
			} else if (params.mode === "screen") {
				tool = "get_screen_size";
			} else if (params.mode === "regions") {
				tool = "parse_visual_regions";
				if (!params.capture_id) {
					fail({
						ok: false,
						code: "capture_required",
						message: "mode=regions needs the capture_id from a prior cua_observe mode=window|desktop",
						retryable: false,
					});
				}
				const check = captures.check(params.capture_id, targetKey(params.pid, params.window_id));
				if (!check.ok) {
					fail({ ok: false, code: "stale_capture", message: check.reason ?? "stale capture", retryable: true });
				}
				const options: Record<string, unknown> = {};
				if (params.kinds?.length) options.kinds = params.kinds;
				if (params.min_confidence !== undefined) options.min_confidence = params.min_confidence;
				if (params.max_regions !== undefined) options.max_regions = params.max_regions;

				// Capture state is per-connection: this MUST go over the persistent MCP
				// child, because a one-shot CLI process cannot resolve the capture_id.
				const conn = await ensureMcp(ctx);
				const mcpResult = await conn.call(
					"parse_visual_regions",
					Object.keys(options).length ? { capture_id: params.capture_id, options } : { capture_id: params.capture_id },
					config.driver.callTimeoutMs,
				);
				const regions = mcpPayload(mcpResult);
				if (mcpResult.isError) {
					const code = typeof regions.code === "string" ? regions.code : "parse_failed";
					fail({
						ok: false,
						code,
						message: typeof regions.message === "string" ? regions.message : "parse_visual_regions failed",
						retryable: regions.retryable === true,
						hint:
							code === "not_installed"
								? "Ask the user to run `/cua perception install`. Do not install it yourself, and do not fall back to guessing coordinates."
								: undefined,
					});
				}
				const body = JSON.stringify({ tool, capture_id: params.capture_id, regions }, null, 1);
				const boundedRegions = bounded("observe-regions", body);
				return {
					content: tc(boundedRegions.content),
					details: { tool, captureId: params.capture_id, truncated: boundedRegions.truncated, file: boundedRegions.file },
				};
			}

			// Capture state AND screenshot context belong to the MCP *connection*, not the driver
			// daemon. A one-shot CLI process registers its capture and then closes the
			// connection, so the capture_id it prints is already dead and its implicit session
			// owns no screenshot. Every capture-PRODUCING call therefore shares the persistent
			// child's connection, which is the only way the capture-consuming side
			// (parse_visual_regions, zoom, window-local x,y) can ever resolve it.
			const producesCapture = tool === "get_window_state" || tool === "get_desktop_state";
			if (!producesCapture) {
				const listed = await callTool(bin, tool, args, {
					...runOpts(ctx),
					session: config.driver.passSessionLabel ? sessionLabel : undefined,
				});
				if (!listed.ok) fail(listed);
				const body = JSON.stringify({ tool, result: listed.json ?? listed.raw }, null, 1);
				const boundedList = bounded(`observe-${tool}`, body);
				return {
					content: tc(boundedList.content),
					details: { tool, truncated: boundedList.truncated, file: boundedList.file },
				};
			}

			const conn = await ensureMcp(ctx);
			const grabbed = await grab(conn, tool, args, limitsFor(ctx));
			if (!grabbed.ok) fail({ ok: false, code: grabbed.code, message: grabbed.message, retryable: grabbed.retryable });

			const json = grabbed.payload;
			const image = grabbed.image;
			const captureId = typeof json.capture_id === "string" ? json.capture_id : undefined;
			const target = targetKey(params.pid, params.window_id);
			// mode=="regions" returns earlier, so anything reaching here issued a fresh capture
			// that later actions may bind to.
			if (captureId) captures.remember(captureId, target);

			// Surface degradation explicitly: an empty AX tree and a failed capture are
			// different failures, and the model must be able to tell them apart.
			const degraded = json.degraded === true;
			const deliverable = forModel(ctx, image);
			const dimNote = image ? overDimensionProfile(image, limitsFor(ctx)) : null;
			// A missing picture must never be ambiguous with an empty tree: say exactly why.
			const missingImageReason =
				params.include_screenshot === false
					? "include_screenshot:false was requested, so no capture exists and there is no capture_id to bind to"
					: (grabbed.note ?? "the driver returned no image for this capture");
			const shaped: Record<string, unknown> = {
				tool,
				capture_id: captureId,
				snapshot_id: json.snapshot_id,
				degraded,
				...(degraded
					? {
							degraded_reason: json.degraded_reason,
							background_input: json.background_input,
							escalation: json.escalation,
							note:
								"The accessibility tree is EMPTY but the screenshot is valid. This is `ax_window_unresolved`, not a capture failure. Background input is refused until it resolves: re-snapshot, or use delivery_mode:\"foreground\" only with the user's authorization.",
					  }
					: {}),
				element_count: json.element_count,
				total_element_count: json.total_element_count,
				truncated: json.truncated,
				window_bounds: json.window_bounds,
				screenshot_scale: json.screenshot_scale,
				screenshot: image
					? {
							...imageMeta(image),
							attached: deliverable.images.length > 0,
							...(deliverable.omitted ? { attach_note: deliverable.omitted } : {}),
							frame_valid: json.screenshot_frame_valid,
							...(grabbed.note ? { note: grabbed.note } : {}),
							...(dimNote ? { size_note: dimNote } : {}),
					  }
					: { present: false, reason: missingImageReason },
			};
			if (Array.isArray(json.elements)) shaped.elements = json.elements;
			if (params.include_markdown && json.tree_markdown) shaped.tree_markdown = json.tree_markdown;
			// Keep the rest of what the driver reported (desktop geometry, original size,
			// counts) rather than dropping it. The base64 is already gone: collectImages
			// removed it from `json` and delivered it as an image block instead.
			for (const [key, value] of Object.entries(json)) {
				if (!(key in shaped) && key !== "elements" && key !== "tree_markdown" && key !== "structuredContent" && key !== "_note") {
					shaped[key] = value;
				}
			}

			const boundedResult = bounded(`observe-${tool}`, JSON.stringify(shaped, null, 1));
			const forModelOmittedNote = deliverable.omitted ?? "not attached";
			const lead = deliverable.images.length
				? imageLead(image as DeliveredImage, "Screenshot")
				: `NO screenshot you can see (${image ? forModelOmittedNote : missingImageReason}). Do not guess coordinates from a screen you cannot see.\n`;
			return {
				content: resultContent(lead + boundedResult.content, deliverable.images),
				details: {
					tool,
					captureId,
					snapshotId: json.snapshot_id,
					degraded,
					truncated: boundedResult.truncated,
					file: boundedResult.file,
					screenshot: image ? imageMeta(image) : { present: false, reason: missingImageReason },
				},
			};
		},
	});

	pi.registerTool({
		name: "cua_act",
		label: "Cua act",
		description:
			"Dispatch exactly one authorized action to an exact target through Cua Driver. Observe first, act once, then verify. Never replay a partial, cancelled, or unknown-effect action.",
		promptSnippet: "Perform one GUI action on an exact target, then verify the outcome.",
		promptGuidelines: [
			"Observe with cua_observe before acting and verify with cua_verify after; effect:\"unverifiable\" and a zero exit are not task success.",
			"If a background route is unavailable, stop and ask; an unavailable route is not permission to escalate to foreground or desktop input.",
			"Keep one controller for a shared desktop; do not run cua_act calls concurrently against the same desktop.",
		],
		executionMode: "sequential",
		parameters: ActParams,
		async execute(_id, params: Static<typeof ActParams>, _signal, _u, ctx) {
			// Fail fast with the install hint, before any consent prompt.
			binary();
			const action = params.action.trim();
			const policy = checkTool(action, config);
			if (!policy.allowed) fail({ ok: false, code: "policy_blocked", message: policy.reason ?? "blocked", retryable: false });

			const args: Record<string, unknown> = { ...(params.args ?? {}) };
			for (const [key, value] of Object.entries(params.target ?? {})) {
				if (value !== undefined) args[key] = value;
			}
			if (params.capture_id) args.capture_id = params.capture_id;

			// App gating, when we can name the app at all.
			const appName = (args.app as string | undefined) ?? (args.bundle_id as string | undefined) ?? (args.name as string | undefined);
			const appGate = checkApp(appName, config);
			if (!appGate.allowed) fail({ ok: false, code: "app_denied", message: appGate.reason ?? "app denied", retryable: false });

			// Stale-capture guard.
			if (params.capture_id) {
				const target = targetKey(params.target?.pid, params.target?.window_id, params.target?.display_id);
				const check = captures.check(params.capture_id, target);
				if (!check.ok) {
					fail({ ok: false, code: "stale_capture", message: check.reason ?? "stale capture", retryable: true });
				}
			}

			// Consent. Fail closed with no UI: this reaches into someone's desktop.
			if (policy.requiresConsent) {
				const appKey = appName ?? `pid:${params.target?.pid ?? "?"}`;
				const alreadyKnown = config.policy.confirmPerApp && consentedApps.has(appKey);
				if (!alreadyKnown) {
					if (!ctx.hasUI) {
						fail({
							ok: false,
							code: "consent_required",
							message: `mutating action "${action}" needs confirmation and no UI is available`,
							retryable: false,
							hint: 'Run `/cua auto on` (or set policy.autoMode / policy.confirmActions to false in ~/.pi/agent/pi-cua.json) to stop prompting for actions.',
						});
					}
					const title = `Cua: ${action} → ${appKey}`;
					const message = `${params.note}\n\nparams: ${JSON.stringify(args).slice(0, 400)}\n\nAllow this action?`;
					const ok = await ctx.ui.confirm(title, message);
					if (!ok) fail({ ok: false, code: "user_denied", message: `user declined "${action}"`, retryable: false });
					consentedApps.add(appKey);
				}
			}

			// EVERY action goes over the one persistent connection, not just capture-bound
			// ones. The driver scopes screenshot context to the session that owns the latest
			// snapshot, and a one-shot CLI process gets a fresh implicit session per call.
			// Measured on 0.30.4: `zoom` and a window-local `click` with x,y both answer
			// `screenshot_context_missing` over a fresh CLI transport even when issued
			// immediately after a snapshot, and succeed on the transport that took it. Element
			// tokens resolve connection-independently, so this only ever adds capability.
			const conn = await ensureMcp(ctx);
			const call = await conn.call(action, args, config.driver.callTimeoutMs);
			// The driver admits and consumes a capture atomically only when it dispatches
			// pixels. A read-only zoom or a region parse must leave the capture usable, so
			// don't burn it here for actions that cannot have consumed it.
			const dispatchesPixels = args.x !== undefined || args.y !== undefined || args.from_x !== undefined || args.from_zoom === true;
			if (params.capture_id && dispatchesPixels) captures.consume(params.capture_id);
			if (!call.ok) fail(mcpFailure(call));

			const collected = collectImages(mcpPayload(call), call.images);
			const json = collected.payload;
			const image = collected.images.length ? finalizeImage(collected.images[0]) : null;
			const deliverable = forModel(ctx, image);
			const effect = typeof json.effect === "string" ? json.effect : undefined;
			const summary = {
				action,
				effect,
				...(image
					? {
							screenshot: {
								...imageMeta(image),
								attached: deliverable.images.length > 0,
								...(deliverable.omitted ? { attach_note: deliverable.omitted } : {}),
							},
						}
					: {}),
				result: json,
			};
			const warning =
				effect === "unverifiable"
					? "\n\nWARNING: effect is \"unverifiable\". This is NOT proof the action worked. Verify with cua_verify."
					: "\n\nVerify the postcondition with cua_verify or a fresh cua_observe before continuing.";
			const zoomHint =
				action === "zoom" && deliverable.images.length
					? "Pass from_zoom:true with x,y read off this crop to click it; the driver maps the point back to window space.\n"
					: "";
			const lead = deliverable.images.length
				? imageLead(image as DeliveredImage, `${action} image`) + zoomHint
				: image
					? `${action} captured an image that was NOT attached (${deliverable.omitted}). You cannot see it.\n`
					: "";
			const boundedResult = bounded(`act-${action}`, JSON.stringify(summary, null, 1));
			return {
				content: resultContent(lead + boundedResult.content + warning, deliverable.images),
				details: {
					action,
					effect,
					truncated: boundedResult.truncated,
					screenshot: image ? imageMeta(image) : undefined,
				},
			};
		},
	});

	pi.registerTool({
		name: "cua_verify",
		label: "Cua verify",
		description:
			"Verify an action's postcondition from independent fresh state. Required after every mutating action before you may claim success.",
		promptSnippet: "Verify a GUI action's outcome from a fresh observation.",
		promptGuidelines: ["Never claim a GUI task succeeded without a cua_verify or fresh cua_observe confirming the user's postcondition."],
		parameters: VerifyParams,
		async execute(_id, params: Static<typeof VerifyParams>, _signal, _u, ctx) {
			const bin = binary();
			const result: CuaResult = params.expect
				? await callTool(bin, "verify_state", { pid: params.pid, window_id: params.window_id, expect: params.expect }, runOpts(ctx))
				: { ok: false, code: "no_expectation", message: "no expect object supplied", retryable: false };

			if (!result.ok && params.snapshot_fallback !== false) {
				// Same connection and same delivery rules as cua_observe. Going through the CLI
				// here used to stringify the whole flat payload, whose inline
				// `screenshot_png_b64` is ~2.5 MB for one window — the model got 24 KB of
				// truncated base64 as text and no picture.
				const conn = await ensureMcp(ctx);
				const grabbed = await grab(conn, "get_window_state", { pid: params.pid, window_id: params.window_id }, limitsFor(ctx));
				if (grabbed.ok) {
					const fresh = grabbed.payload;
					const captureId = typeof fresh.capture_id === "string" ? fresh.capture_id : undefined;
					if (captureId) captures.remember(captureId, targetKey(params.pid, params.window_id));
					const freshState = {
						capture_id: captureId,
						snapshot_id: fresh.snapshot_id,
						element_count: fresh.element_count,
						screenshot: grabbed.image ? imageMeta(grabbed.image) : { present: false, reason: grabbed.note },
						elements: Array.isArray(fresh.elements) ? fresh.elements : undefined,
					};
					const body = JSON.stringify({ verified: false, reason: result.message, fresh_state: freshState }, null, 1);
					const boundedResult = bounded("verify-fresh", body);
					return {
						content: resultContent(boundedResult.content, forModel(ctx, grabbed.image).images),
						details: { verified: false, screenshot: grabbed.image ? imageMeta(grabbed.image) : undefined },
					};
				}
				fail(result);
			}
			if (!result.ok) fail(result);

			const json = (result.json ?? {}) as Record<string, unknown>;
			const verified = json.ok !== false && json.matched !== false;
			const body = JSON.stringify({ verified, result: json }, null, 1);
			return {
				content: tc(`${verified ? "VERIFIED" : "NOT VERIFIED"}\n${body}`),
				details: { verified },
			};
		},
	});

	pi.registerTool({
		name: "cua_describe",
		label: "Cua describe",
		description:
			"Introspect the installed driver's own tool list and parameter schemas. Use before an unfamiliar action instead of guessing parameters; the installed version is authoritative.",
		promptSnippet: "Look up a Cua driver tool's exact parameters.",
		parameters: DescribeParams,
		async execute(_id, params: Static<typeof DescribeParams>, _signal, _u, ctx) {
			const bin = binary();
			if (!params.tool) {
				if (toolsCache && Date.now() - toolsCache.at < 300_000) {
					return { content: tc(toolsCache.data.map((t) => `${t.name}: ${t.summary}`).join("\n")), details: { tools: toolsCache.data } };
				}
				const tools = await listTools(bin, runOpts(ctx));
				if (!tools.ok) fail(tools);
				toolsCache = { at: Date.now(), data: tools.data };
				const body = tools.data.map((t) => `${t.name}: ${t.summary}`).join("\n");
				const boundedResult = bounded("tools", body);
				return { content: tc(boundedResult.content), details: { count: tools.data.length, file: boundedResult.file } };
			}
			const described = await describeTool(bin, params.tool, runOpts(ctx));
			if (!described.ok) fail(described);
			const policy = checkTool(params.tool, config);
			const gate = policy.allowed ? "" : `\n\nBLOCKED BY POLICY: ${policy.reason}`;
			const boundedResult = bounded(`describe-${params.tool}`, described.raw.trim());
			return {
				content: tc(boundedResult.content + gate),
				details: { tool: params.tool, actionClass: policy.actionClass, allowed: policy.allowed },
			};
		},
	});

	// --------------------------------------------------------------- command

	pi.registerCommand("cua", {
		description:
			"Cua computer-use: /cua on|session|off|auto|confirm|status|doctor|grant|perception|config (on persists; session is this-session-only; auto = never prompt for any action; confirm on|app|off = prompt posture)",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);

			if (sub === "on" || sub === "enable") {
				config.driver.enabled = true;
				sessionEnabled = false;
				saveConfig(config);
				setActive(true);
					ctx.ui.notify(
					"pi-cua: enabled and SAVED to ~/.pi/agent/pi-cua.json — this persists across restarts. "
					+"For this session only, use /cua session.",
				"info",
				);
				// One-time discoverability nudge: regions is the only route into non-AX
				// surfaces, and it is off by default upstream.
				const bin = resolveBinary(config.driver.binary);
				if (bin.path) {
					const status = await runCuaDriver(bin.path, ["extension", "status", "cua-perception"], { timeoutMs: 20_000 });
					if (classifyPerception(outputOf(status)).state !== "installed") {
						ctx.ui.notify(
							"Tip: visual regions are unavailable. Without them, Chromium content and canvas apps (Blender, Figma, DAWs) have no semantic route. Enable with `/cua perception install` — it includes an AGPL-3.0-only component; private use is unrestricted.",
							"info",
						);
					}
				}
				return;
			}
			if (sub === "off" || sub === "disable") {
				config.driver.enabled = false;
				sessionEnabled = false;
				saveConfig(config);
				setActive(false);
				ctx.ui.notify("pi-cua: disabled and removed from ~/.pi/agent/pi-cua.json (also clears any /cua session or cua_enable override)", "info");
				return;
			}
			// Consent posture. `auto` is the mute switch for every action prompt and it
			// overrides confirmActions; `confirm` is the opt-in back to dialogs. Both persist,
			// so a later headless run inherits the posture the user chose here.
			if (sub === "auto") {
				const want = rest[0];
				config.policy.autoMode = want === "on" || want === "true" || want === "1" ? true : want === "off" ? false : !config.policy.autoMode;
				saveConfig(config);
				ctx.ui.notify(
					`pi-cua: auto mode ${config.policy.autoMode ? "ON - no GUI action will prompt you" : "off"}\nconsent: ${consentLabel(config)}\nsaved to ${CONFIG_PATH}`,
					"info",
				);
				return;
			}
			if (sub === "confirm") {
				const want = rest[0];
				if (want === "off") {
					config.policy.confirmActions = false;
					config.policy.confirmPerApp = false;
				} else {
					config.policy.confirmActions = true;
					config.policy.confirmPerApp = want === "app";
				}
				saveConfig(config);
				ctx.ui.notify(`pi-cua: consent -> ${consentLabel(config)}\nsaved to ${CONFIG_PATH}`, "info");
				return;
			}
			// Session-scoped enable, deliberately distinct from /cua on|enable, which
			// persists. The label this used to print is in `/cua status`.
			const bin0 = resolveBinary(config.driver.binary);
			if (sub === "session" || sub === "once") {
				if (!bin0.path) {
					ctx.ui.notify(`cua-driver binary not found (${bin0.source}) — nothing to enable`, "error");
					return;
				}
				sessionEnabled = true;
				setActive(true);
					ctx.ui.notify(
					"pi-cua: enabled for THIS SESSION ONLY. Nothing was written to config; a new session starts disabled. Use /cua on to persist.",
					"info",
				);
				return;
			}
			if (sub === "doctor") {
				const bin = resolveBinary(config.driver.binary);
				if (!bin.path) return ctx.ui.notify("cua-driver binary not found", "error");
				const doctor = await runCuaDriver(bin.path, ["doctor"], { timeoutMs: 60_000 });
				ctx.ui.notify(outputOf(doctor).trim().slice(0, 1500) || "doctor produced no output", "info");
				return;
			}
			if (sub === "grant") {
				const bin = resolveBinary(config.driver.binary);
				if (!bin.path) return ctx.ui.notify("cua-driver binary not found", "error");
				ctx.ui.notify("Opening macOS permission prompts for CuaDriver.app…", "info");
				const granted = await grantPermissions(bin.path);
				ctx.ui.notify(granted.ok ? outputOf(granted).trim().slice(0, 800) : `grant failed: ${granted.message}`, granted.ok ? "info" : "error");
				return;
			}
			if (sub === "perception") {
				const action = rest[0] ?? "status";
				const bin = resolveBinary(config.driver.binary);
				if (!bin.path) return ctx.ui.notify("cua-driver binary not found", "error");
				if (action === "status") {
					const status = await runCuaDriver(bin.path, ["extension", "status", "cua-perception"], { timeoutMs: 30_000 });
					const release = await findRelease();
					ctx.ui.notify(
						`${outputOf(status).trim().split("\n").slice(0, 4).join("\n")}\nlatest release: ${release.ok ? release.data.tag : release.message}`,
						"info",
					);
					return;
				}
				if (action === "install") {
					// The licence notice must be shown and accepted. Interactive users accept
					// via the dialog; headless runs accept explicitly, and the notice is still
					// emitted so it lands in the transcript or log.
					const headlessAck = rest.includes("--yes") || process.env.PI_CUA_ACCEPT_AGPL === "1";
					let approved = false;
					if (ctx.hasUI) {
						approved = await ctx.ui.confirm("Install cua-perception? (includes AGPL-3.0-only code)", PERCEPTION_NOTICE);
					} else if (headlessAck) {
						ctx.ui.notify(PERCEPTION_NOTICE, "warning");
						approved = true;
					} else {
						return ctx.ui.notify(
							"refusing to install without confirmation. Re-run with `--yes` or set PI_CUA_ACCEPT_AGPL=1 to accept the AGPL-3.0-only notice non-interactively, or run `/cua perception install` in an interactive session.",
							"error",
						);
					}
					if (!approved) return ctx.ui.notify("cancelled — nothing downloaded", "info");
					ctx.ui.notify("downloading + verifying (~426 MB)…", "info");
					const outcome = await installPerception(bin.path, (message) => ctx.ui.notify(message, "info"));
					if (outcome.ok) {
						// Restart the connection so the new parse path gets a fresh registry.
						const closing = mcp;
						mcp = null;
						await closing?.stop().catch(() => {});
						ctx.ui.notify('cua-perception installed — cua_observe mode:"regions" is now available', "info");
					} else {
						ctx.ui.notify(`install failed: ${outcome.error}${outcome.hint ? `\n${outcome.hint}` : ""}`, "error");
					}
					return;
				}
				if (action === "remove") {
					const removed = await removePerception(bin.path);
					ctx.ui.notify(removed.ok ? "cua-perception removed" : `remove failed: ${removed.message}`, removed.ok ? "info" : "error");
					return;
				}
				ctx.ui.notify("usage: /cua perception [status|install|remove]", "info");
				return;
			}
			if (sub === "config") {
				ctx.ui.notify(`${CONFIG_PATH}\n${JSON.stringify(config, null, 2)}`, "info");
				return;
			}
			if (sub === "models-dir") {
				ctx.ui.notify(`S1 models dir: ${expandPath(config.s1.modelsDir)}`, "info");
				return;
			}

			const bin = resolveBinary(config.driver.binary);
			const lines = [
				`driver:    ${enabled() ? "enabled" : "disabled (default)"} · active=${pi.getActiveTools().includes("cua_status")}`,
				`binary:    ${bin.path ?? `not found (${bin.source})`}`,
				`mode:      ${config.driver.permissionMode}`,
				`consent:   ${consentLabel(config)}`,
				`s1:        ${config.s1.enabled ? `enabled (${config.s1.checkpoint}, ${config.s1.modality})` : "disabled (default)"}`,
				`session:   ${sessionLabel}`,
				`mcp:       ${mcp?.alive() ? `connected (${mcp.toolNames.length} tools)` : "not started (opens on first capture-bound use)"}`,
				`perception: see /cua perception status`,
				`config:    ${CONFIG_PATH}`,
			];
			if (bin.path) {
				const [daemon, perms] = await Promise.all([daemonStatus(bin.path, { timeoutMs: 15_000 }), permissionsStatus(bin.path, { timeoutMs: 15_000 })]);
				lines.push(`daemon:    ${daemon.ok && daemon.data.running ? "running" : "not running"}`);
				lines.push(`tcc:       ${perms.ok ? perms.data.status : "unknown"}`);
			}
			if (rest[0] === "--verbose" && bin.path) {
				const version = await driverVersion(bin.path, { timeoutMs: 15_000 });
				if (version.ok) lines.push(`version:   ${version.data.version}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		// A genuinely new session must not inherit a previous session's cua_enable;
		// reload/resume/fork are continuations of the same working context and keep it.
		if ((event as { reason?: string }).reason === "startup") sessionEnabled = false;
		config = loadConfig();
		sessionLabel = `${config.driver.sessionLabelPrefix}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		// Always assert, in both directions. On reload pi passes
		// includeAllExtensionTools:true, which would otherwise promote every cua_* tool
		// into the active set regardless of config and leak them into context.
		setActive(enabled());
	});

	pi.on("session_shutdown", async () => {
		// The MCP child is the only long-lived resource we own. Keep this idempotent:
		// cancellation, reload, session replacement, and exit can converge here.
		const closing = mcp;
		mcp = null;
		await closing?.stop().catch(() => {});
		captures.forget();
		consentedApps.clear();
		toolsCache = null;
	});

	// Backstop: block a mutating driver call arriving through any other path
	// (for example a third-party MCP adapter exposing the same tools).
	pi.on("tool_call", async (event) => {
		if (!event.toolName.startsWith("cua_")) return undefined;
		// The loader is the way IN, so it must never be gated.
		if (event.toolName === LOADER_TOOL) return undefined;
		// Disabled by default: refuse until the user opts in.
		if (!enabled()) {
			return { block: true, reason: "pi-cua is disabled. Call cua_enable to turn the tools on for this session, or ask the user to run /cua on." };
		}
		return undefined;
	});
}
