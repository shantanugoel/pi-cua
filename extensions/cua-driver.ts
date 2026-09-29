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
 *   - Mutating actions fail closed when there is no UI to consent through.
 *   - The caller (us) owns capture_id discipline and preconditions. Cua's docs are
 *     explicit that a decision or a successful exit is not proof of task success.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
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
import { CaptureLedger, checkApp, checkTool } from "../src/policy.ts";
import { CuaMcp, mcpPayload } from "../src/mcp.ts";
import { PERCEPTION_NOTICE, findRelease, installPerception, removePerception } from "../src/perception.ts";

const TOOL_NAMES = ["cua_status", "cua_observe", "cua_act", "cua_verify", "cua_describe"] as const;

const MAX_MODEL_BYTES = 24_000;

/** Pi requires tool content as content blocks, not a bare string. */
function tc(value: string): TextContent[] {
	return [{ type: "text", text: value }];
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
		x: Type.Optional(Type.Number({ description: "Window-local screenshot pixel x, only with a fresh capture of the same target." })),
		y: Type.Optional(Type.Number({ description: "Window-local screenshot pixel y." })),
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
		Type.Boolean({ description: "mode=window: set false for the cheap tree-only re-index before an element action. Default true." }),
	),
	include_accessibility_tree: Type.Optional(
		Type.Boolean({ description: "mode=window: set false to skip the AX walk entirely and get a screenshot preview only." }),
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
	/**
	 * Capture state is per-connection, so capture-bound parse_visual_regions and
	 * capture-bound pixel clicks need one long-lived MCP child. Started lazily, never in
	 * the factory, and stopped from session_shutdown.
	 */
	let mcp: CuaMcp | null = null;

	async function ensureMcp(ctx: ExtensionContext): Promise<CuaMcp> {
		if (mcp?.alive()) return mcp;
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
		if (active) {
			const merged = [...new Set([...current, ...TOOL_NAMES])];
			pi.setActiveTools(merged);
		} else {
			pi.setActiveTools(current.filter((name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number])));
		}
	}

	function statusLine(): string {
		const bin = resolveBinary(config.driver.binary);
		return `cua ${config.driver.enabled ? "on" : "off"} · driver ${bin.path ? "found" : "MISSING"} · s1 ${config.s1.enabled ? "on" : "off"}`;
	}

	// ---------------------------------------------------------------- tools

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
				driverEnabled: config.driver.enabled,
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
				out.perception = /not installed/i.test(text) ? "not_installed" : /status:\s*installed/i.test(text) ? "installed" : "unknown";
				if (out.perception === "not_installed") {
					out.perceptionNote =
						"parse_visual_regions is unavailable, so non-AX surfaces (Chromium content, canvas apps) fall back to the accessibility tree, typed browser state, or screenshot reasoning. Enable it with `/cua perception install` (fetches the signed artifact from Cua's release; includes an AGPL-3.0-only component).";
				}
				const release = await findRelease();
				out.perceptionRelease = release.ok ? release.data.tag : `unavailable: ${release.message}`;
			}
			out.mcpConnection = mcp?.alive()
				? { alive: true, tools: mcp.toolNames.length }
				: { alive: false, note: "opens on first capture-bound use; required for capture-bound parse_visual_regions and pixel clicks" };
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
				tool = "list_windows";
				if (params.pid) args.pid = params.pid;
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

			const result = await callTool(bin, tool, args, {
				...runOpts(ctx),
				session: config.driver.passSessionLabel ? sessionLabel : undefined,
			});
			if (!result.ok) fail(result);

			const json = (result.json ?? {}) as Record<string, unknown>;
			const captureId = typeof json.capture_id === "string" ? json.capture_id : params.capture_id;
			const target = targetKey(params.pid, params.window_id);
			// mode=="regions" returns earlier, so anything reaching here issued a fresh
			// capture that later actions may bind to.
			if (captureId) captures.remember(captureId, target);

			// The CLI returns a FLAT payload (no MCP structuredContent wrapper).
			// Surface degradation explicitly: an empty AX tree and a failed capture are
			// different failures, and the model must be able to tell them apart.
			const degraded = json.degraded === true;
			const payload = JSON.stringify(
				{
					tool,
					capture_id: captureId,
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
					screenshot: json.screenshot_png_b64
						? {
								bytes_b64: String(json.screenshot_png_b64).length,
								width: json.screenshot_width,
								height: json.screenshot_height,
								scale: json.screenshot_scale,
								frame_valid: json.screenshot_frame_valid,
						  }
						: undefined,
					elements: (json.structuredContent as Record<string, unknown> | undefined)?.elements ?? json.elements ?? json,
					...(params.include_markdown && json.tree_markdown ? { tree_markdown: json.tree_markdown } : {}),
				},
				null,
				1,
			);
			const boundedResult = bounded(`observe-${tool}`, payload);
			return {
				content: tc(boundedResult.content),
				details: { tool, captureId, degraded, truncated: boundedResult.truncated, file: boundedResult.file },
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
			const bin = binary();
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
							hint: 'Set policy.confirmActions to false in ~/.pi/agent/pi-cua.json only for unattended automation you trust.',
						});
					}
					const title = `Cua: ${action} → ${appKey}`;
					const message = `${params.note}\n\nparams: ${JSON.stringify(args).slice(0, 400)}\n\nAllow this action?`;
					const ok = await ctx.ui.confirm(title, message);
					if (!ok) fail({ ok: false, code: "user_denied", message: `user declined "${action}"`, retryable: false });
					consentedApps.add(appKey);
				}
			}

			let result: CuaResult;
			if (params.capture_id && mcp?.alive()) {
				// Capture-bound actions must stay on the connection that owns the capture.
				const mcpResult = await mcp.call(action, args, config.driver.callTimeoutMs);
				const payload = mcpPayload(mcpResult);
				result = mcpResult.ok
					? { ok: true, data: payload, json: payload, raw: JSON.stringify(payload) }
					: {
							ok: false,
							code: String(payload.code ?? "driver_error"),
							message: mcpResult.text || "driver error",
							retryable: payload.retryable === true,
							raw: mcpResult.text,
						};
			} else {
				result = await callTool(bin, action, args, {
					...runOpts(ctx),
					session: config.driver.passSessionLabel ? sessionLabel : undefined,
				});
			}
			if (params.capture_id) captures.consume(params.capture_id);
			if (!result.ok) fail(result);

			const json = (result.json ?? {}) as Record<string, unknown>;
			const effect = typeof json.effect === "string" ? json.effect : undefined;
			const summary = { action, effect, result: json };
			const warning =
				effect === "unverifiable"
					? "\n\nWARNING: effect is \"unverifiable\". This is NOT proof the action worked. Verify with cua_verify."
					: "\n\nVerify the postcondition with cua_verify or a fresh cua_observe before continuing.";
			const body = JSON.stringify(summary, null, 1);
			const boundedResult = bounded(`act-${action}`, body);
			return {
				content: tc(boundedResult.content + warning),
				details: { action, effect, truncated: boundedResult.truncated },
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
				const fresh = await callTool(
					bin,
					"get_window_state",
					{ pid: params.pid, window_id: params.window_id },
					runOpts(ctx),
				);
				if (fresh.ok) {
					const body = JSON.stringify({ verified: false, reason: result.message, fresh_state: fresh.json }, null, 1);
					const boundedResult = bounded("verify-fresh", body);
					return { content: tc(boundedResult.content), details: { verified: false } };
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
		description: "Cua computer-use: /cua on|off|status|doctor|grant|perception|session|config",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);

			if (sub === "on" || sub === "enable") {
				config.driver.enabled = true;
				saveConfig(config);
				setActive(true);
				ctx.ui.notify("pi-cua driver tools enabled and saved", "info");
				// One-time discoverability nudge: regions is the only route into non-AX
				// surfaces, and it is off by default upstream.
				const bin = resolveBinary(config.driver.binary);
				if (bin.path) {
					const status = await runCuaDriver(bin.path, ["extension", "status", "cua-perception"], { timeoutMs: 20_000 });
					if (/not installed/i.test(outputOf(status))) {
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
				saveConfig(config);
				setActive(false);
				ctx.ui.notify("pi-cua driver tools disabled and saved", "info");
				return;
			}
			if (sub === "session") {
				ctx.ui.notify(`CLI session label: ${sessionLabel}`, "info");
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
				`driver:    ${config.driver.enabled ? "enabled" : "disabled (default)"} · active=${pi.getActiveTools().includes("cua_status")}`,
				`binary:    ${bin.path ?? `not found (${bin.source})`}`,
				`mode:      ${config.driver.permissionMode}`,
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

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		sessionLabel = `${config.driver.sessionLabelPrefix}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		if (config.driver.enabled) setActive(true);
		ctx.ui.setStatus("cua", config.driver.enabled ? statusLine() : undefined);
	});

	pi.on("session_shutdown", async () => {
		// The MCP child is the only long-lived resource we own. Keep this idempotent:
		// cancellation, reload, session replacement, and exit can converge here.
		const closing = mcp;
		mcp = null;
		await closing?.stop().catch(() => {});
		consentedApps.clear();
		toolsCache = null;
	});

	// Backstop: block a mutating driver call arriving through any other path
	// (for example a third-party MCP adapter exposing the same tools).
	pi.on("tool_call", async (event) => {
		if (!event.toolName.startsWith("cua_")) return undefined;
		// Disabled by default: refuse until the user opts in.
		if (!config.driver.enabled) {
			return { block: true, reason: "pi-cua is disabled. Run /cua on, or set driver.enabled in ~/.pi/agent/pi-cua.json." };
		}
		return undefined;
	});
}
