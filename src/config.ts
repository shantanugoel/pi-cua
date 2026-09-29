/**
 * Configuration for pi-cua.
 *
 * Everything defaults to OFF. A user must opt in twice:
 *   1. `driver.enabled`  -> the cua_* tools become activatable
 *   2. `s1.enabled`      -> the Cua-S1 sidecar may be spawned at all
 *
 * When `s1.enabled` is false, nothing in this package may spawn Python, read the
 * uv environment, or touch the ~9.34 GB Qwen3.5-4B base weights.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-cua.json");

/** Actions we never expose without an explicit allow, regardless of mode. */
export const DEFAULT_DENY_TOOLS = [
	"kill_app",
	"clipboard_write",
	"clipboard_read",
	"browser_set_input_files",
	"install_extension",
	"install_ffmpeg",
	"set_config",
	"revoke",
];

export interface DriverConfig {
	/** Master switch for the driver tools. Default false. */
	enabled: boolean;
	/** Absolute path to the cua-driver binary; null resolves from PATH/env. */
	binary: string | null;
	/**
	 * Permission mode applied to the daemon we may start. "unrestricted" is
	 * intentionally unsupported: it requires --dangerously-bypass-approvals.
	 */
	permissionMode: "standard" | "bounded";
	/** Capability manifest file, required when permissionMode is "bounded". */
	capabilityManifest: string | null;
	/** Start CuaDriver.app via LaunchServices when no daemon is running. */
	autoStartDaemon: boolean;
	/** Milliseconds for one `cua-driver call`. */
	callTimeoutMs: number;
	/** Prefix for the CLI lifecycle session label passed on calls. */
	sessionLabelPrefix: string;
	/**
	 * Pass the session label on the read-only CLI enumeration calls (list_apps,
	 * list_windows, get_accessibility_tree, get_screen_size). Off by default because only
	 * some tools accept a public `session` parameter and an unknown parameter is an error.
	 * It has no effect on captures or actions: those all share one persistent MCP
	 * connection, whose implicit lifecycle session is what owns the capture and screenshot
	 * context, so a label would only risk a schema rejection.
	 */
	passSessionLabel: boolean;
}

export interface S1Config {
	/** Master switch for the decision model. Default false. */
	enabled: boolean;
	/** Only the 4B PEFT adapters are supported by the upstream chooser. */
	checkpoint: "cua-s1-4b-0.2" | "cua-s1-4b-0.1";
	modality: "text" | "multimodal";
	/** "auto" picks mps on Apple silicon, else cpu. */
	device: "auto" | "mps" | "cpu" | "cuda";
	/** "auto" picks float16 on mps, bfloat16 on cpu (float16 has no CPU support). */
	dtype: "auto" | "float16" | "bfloat16" | "float32";
	modelsDir: string;
	/** Checkout of trycua/cua providing libs/cua-s1 + libs/cua-driver/examples/jev-use. */
	cuaRepo: string | null;
	/** Caller-side policy: never act below these. */
	minProbability: number;
	minMargin: number;
	/** Downscale captures before multimodal scoring (2560x1600 costs 22-30s). */
	maxImageDimension: number;
	/** Reserved for the experimental per-element nano pre-filter. Not a decision maker. */
	experimentalNanoPrefilter: false;
}

export interface PolicyConfig {
	/** Allow mutating actions at all. Default true (still per-action consent). */
	allowMutations: boolean;
	/**
	 * Ask the user before each mutating action in interactive sessions.
	 * Default FALSE: pi-cua does not interrupt you per action.
	 * Set true (or run `/cua confirm on`) to gate every mutating action behind a dialog.
	 * Overridden by `autoMode`.
	 */
	confirmActions: boolean;
	/** With confirmActions, ask once per app per session instead of once per action. */
	confirmPerApp: boolean;
	/**
	 * Auto mode: never prompt the user for any GUI action, in any session, UI or not.
	 * Default false. When true it wins over `confirmActions` / `confirmPerApp`, so an
	 * unattended run cannot stall on a dialog nobody is there to answer.
	 * It does NOT weaken the other gates: `allowMutations`, `allowApps` / `denyApps`,
	 * `denyTools`, the stale-capture ledger, and the AGPL install notice still apply.
	 * Toggle with `/cua auto on|off` or PI_CUA_AUTO=1.
	 */
	autoMode: boolean;
	/** Empty allowlist means "any app not denied". */
	allowApps: string[];
	denyApps: string[];
	denyTools: string[];
	/** Hard cap on candidates offered to a decision model (upstream limit is 26). */
	maxCandidates: number;
}

export interface PiCuaConfig {
	driver: DriverConfig;
	s1: S1Config;
	policy: PolicyConfig;
}

export const DEFAULTS: PiCuaConfig = {
	driver: {
		enabled: false,
		binary: null,
		permissionMode: "standard",
		capabilityManifest: null,
		autoStartDaemon: true,
		callTimeoutMs: 60_000,
		sessionLabelPrefix: "pi",
		passSessionLabel: false,
	},
	s1: {
		enabled: false,
		checkpoint: "cua-s1-4b-0.2",
		modality: "text",
		device: "auto",
		dtype: "auto",
		modelsDir: "~/cua-s1-models",
		cuaRepo: null,
		minProbability: 0.35,
		minMargin: 0.1,
		maxImageDimension: 1280,
		experimentalNanoPrefilter: false,
	},
	policy: {
		allowMutations: true,
		// No per-action dialog by default. Opt into confirmActions (or /cua confirm on)
		// if you want to approve each mutating action yourself.
		confirmActions: false,
		confirmPerApp: false,
		autoMode: false,
		allowApps: [],
		denyApps: [],
		denyTools: [...DEFAULT_DENY_TOOLS],
		maxCandidates: 26,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge parsed JSON over defaults, ignoring unknown keys and bad types. */
function merge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const current = out[key];
		if (isRecord(current) && isRecord(value)) {
			out[key] = merge(current, value);
		} else if (typeof current === typeof value || Array.isArray(value)) {
			// Only accept a patch value shaped like the default it replaces.
			if (Array.isArray(current) ? Array.isArray(value) : typeof current === typeof value) {
				out[key] = value;
			}
		}
	}
	return out as T;
}

export function loadConfig(overrides?: Partial<PiCuaConfig>): PiCuaConfig {
	let config = structuredClone(DEFAULTS);
	if (existsSync(CONFIG_PATH)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			if (isRecord(parsed)) config = merge(config as unknown as Record<string, unknown>, parsed) as unknown as PiCuaConfig;
		} catch (error) {
			// A broken config file must not brick Pi; fall back and say so later.
			config = { ...structuredClone(DEFAULTS), ...{} } as PiCuaConfig;
			(config as PiCuaConfig & { configError?: string }).configError = String(
				error instanceof Error ? error.message : error,
			);
		}
	}

	// Environment escape hatches for one-off runs.
	if (process.env.PI_CUA === "1") config.driver.enabled = true;
	if (process.env.PI_CUA_S1 === "1") config.s1.enabled = true;
	if (process.env.PI_CUA_AUTO === "1") config.policy.autoMode = true;
	if (process.env.CUA_DRIVER_PATH) config.driver.binary = process.env.CUA_DRIVER_PATH;

	if (overrides) {
		config = merge(config as unknown as Record<string, unknown>, overrides as Record<string, unknown>) as unknown as PiCuaConfig;
	}

	// Hard guards that no configuration may cross.
	if (config.s1.minProbability < 0 || config.s1.minProbability > 1) config.s1.minProbability = DEFAULTS.s1.minProbability;
	if (config.s1.minMargin < 0 || config.s1.minMargin > 1) config.s1.minMargin = DEFAULTS.s1.minMargin;
	if (config.policy.maxCandidates < 2 || config.policy.maxCandidates > 26) config.policy.maxCandidates = 26;
	if ((config.driver.permissionMode as string) === "unrestricted") config.driver.permissionMode = "standard";

	return config;
}

export function saveConfig(config: PiCuaConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const { ...rest } = config as PiCuaConfig & { configError?: string };
	writeFileSync(CONFIG_PATH, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
}

export function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path);
}