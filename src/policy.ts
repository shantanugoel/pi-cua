/**
 * Caller-side policy.
 *
 * Cua's own docs put the safety burden on the caller, not the model:
 *   "`selected` is not an action result. The application must look up the selected ID
 *    in its original candidate table, re-check any typed action precondition against
 *    the original current-capture observation, dispatch only an authorized action
 *    through Driver, and verify the postcondition from an independent source."
 * So this module is the real safety layer. Model confidence is not.
 */

import type { PiCuaConfig } from "./config.ts";

export type ActionClass = "observe" | "lifecycle" | "mutate";

/** Authoritative for cua-driver 0.30.4 (`cua-driver list-tools`, 58 tools). */
const OBSERVE_TOOLS = new Set([
	"check_for_update",
	"check_permissions",
	"get_accessibility_tree",
	"get_agent_cursor_state",
	"get_browser_state",
	"get_config",
	"get_cursor_position",
	"get_desktop_state",
	"get_recording_state",
	"get_screen_size",
	"get_session",
	"get_session_state",
	"get_window_state",
	"health_report",
	"history_query",
	"history_status",
	"list_apps",
	"list_sessions",
	"list_windows",
	"parse_visual_regions",
	"verify_state",
	// `zoom` only crops a capture the session already owns and returns a JPEG; it changes
	// no app state. Classifying it as a mutation put a consent prompt on every step of
	// the pixel escalation ladder, which is the ladder's whole purpose on canvas apps.
	"zoom",
]);

const LIFECYCLE_TOOLS = new Set(["start_session", "end_session"]);

/**
 * Everything that can change app, window, clipboard, filesystem, or driver state.
 * Anything unrecognised is treated as mutating (fail closed).
 */
const MUTATE_TOOLS = new Set([
	"bring_to_front",
	"browser_click",
	"browser_dialog",
	"browser_download",
	"browser_navigate",
	"browser_pointer",
	"browser_prepare",
	"browser_set_input_files",
	"browser_type",
	"click",
	"clipboard_read",
	"clipboard_write",
	"double_click",
	"drag",
	"escalate_session",
	"hotkey",
	"install_extension",
	"install_ffmpeg",
	"invoke_menu",
	"kill_app",
	"launch_app",
	"move_cursor",
	"page",
	"press_key",
	"replay_trajectory",
	"right_click",
	"scroll",
	"set_agent_cursor_enabled",
	"set_agent_cursor_motion",
	"set_agent_cursor_theme",
	"set_config",
	"set_value",
	"set_window_frame",
	"start_recording",
	"stop_recording",
	"type_text",
]);

export function classify(tool: string): ActionClass {
	if (OBSERVE_TOOLS.has(tool)) return "observe";
	if (LIFECYCLE_TOOLS.has(tool)) return "lifecycle";
	return "mutate";
}

export interface PolicyDecision {
	allowed: boolean;
	reason?: string;
	/** True when the caller must ask the user before dispatching. */
	requiresConsent: boolean;
	actionClass: ActionClass;
}

export function checkTool(tool: string, config: PiCuaConfig): PolicyDecision {
	const actionClass = classify(tool);
	if (config.policy.denyTools.includes(tool)) {
		return {
			allowed: false,
			reason: `"${tool}" is in policy.denyTools. Remove it from ~/.pi/agent/pi-cua.json only if you understand what it does.`,
			requiresConsent: false,
			actionClass,
		};
	}
	if (actionClass === "mutate" && !config.policy.allowMutations) {
		return {
			allowed: false,
			reason: "policy.allowMutations is false; this session is observe-only.",
			requiresConsent: false,
			actionClass,
		};
	}
	return { allowed: true, requiresConsent: actionClass === "mutate" && config.policy.confirmActions, actionClass };
}

/** App-name gating. `app` is whatever the caller can name (bundle id or app name). */
export function checkApp(app: string | undefined, config: PiCuaConfig): { allowed: boolean; reason?: string } {
	if (!app) return { allowed: true };
	const needle = app.toLowerCase();
	const matches = (list: string[]) =>
		list.some((entry) => {
			const e = entry.toLowerCase();
			return e === needle || needle.includes(e) || e.includes(needle);
		});
	if (matches(config.policy.denyApps)) {
		return { allowed: false, reason: `"${app}" is denied by policy.denyApps.` };
	}
	if (config.policy.allowApps.length > 0 && !matches(config.policy.allowApps)) {
		return { allowed: false, reason: `"${app}" is not in policy.allowApps.` };
	}
	return { allowed: true };
}

/**
 * Driver captures expire 60s after creation, and an action must carry the same
 * capture_id as the observation it was grounded on. Track issued captures so a stale
 * one is refused locally instead of burning a round-trip and silently acting on old
 * pixels.
 */
export class CaptureLedger {
	private readonly captures = new Map<string, { at: number; target: string }>();
	/** Upstream lifetime is 60s; act well inside it. */
	constructor(private readonly lifetimeMs = 55_000) {}

	remember(captureId: string, target: string): void {
		this.prune();
		this.captures.set(captureId, { at: Date.now(), target });
	}

	check(captureId: string, target: string): { ok: boolean; reason?: string; ageMs?: number } {
		const entry = this.captures.get(captureId);
		if (!entry) return { ok: false, reason: `capture_id ${captureId} was not issued by this session` };
		const ageMs = Date.now() - entry.at;
		if (ageMs > this.lifetimeMs) {
			this.captures.delete(captureId);
			return { ok: false, reason: `capture_id ${captureId} is ${Math.round(ageMs / 1000)}s old and past the Driver capture lifetime; re-observe`, ageMs };
		}
		if (entry.target !== target) {
			return { ok: false, reason: `capture_id ${captureId} belongs to a different target; never reuse a capture against another window`, ageMs };
		}
		return { ok: true, ageMs };
	}

	consume(captureId: string): void {
		this.captures.delete(captureId);
	}

	/**
	 * Drop every outstanding capture. Capture state lives on the MCP connection, so when
	 * that child is replaced the ids we issued are already dead on the driver side; a
	 * local clear turns a confusing driver error into our own "re-observe" message.
	 */
	forget(): void {
		this.captures.clear();
	}

	private prune(): void {
		const now = Date.now();
		for (const [id, entry] of this.captures) {
			if (now - entry.at > this.lifetimeMs * 2) this.captures.delete(id);
		}
	}
}

export interface Candidate {
	id: string;
	description: string;
	/** Opaque caller-side payload. Never sent to the model. */
	action?: Record<string, unknown>;
}

export interface DecisionLike {
	kind: string;
	selected_id: string;
	confidence?: number;
	probabilities?: Record<string, number>;
	capture_id: string;
	reason?: string;
}

export interface GateResult {
	actionable: boolean;
	candidate?: Candidate;
	reason: string;
	probability?: number;
	margin?: number;
}

/**
 * Apply the caller's own score + margin policy to a decision.
 *
 * Upstream rules encoded here:
 *   - `reobserve`, `abstain`, and `error` dispatch nothing.
 *   - Tied top scores are non-actionable errors.
 *   - Use probabilities[selected_id], not `confidence`, for a model-independent
 *     threshold (confidence preserves a provider's own value when it has one).
 *   - The selected id must exist in OUR table; a model can never introduce an action.
 */
export function gateDecision(
	decision: DecisionLike,
	candidates: Candidate[],
	thresholds: { minProbability: number; minMargin: number },
): GateResult {
	if (decision.kind !== "selected") {
		return { actionable: false, reason: `decision kind is "${decision.kind}" (${decision.reason ?? "no reason given"}); dispatching nothing` };
	}

	const candidate = candidates.find((c) => c.id === decision.selected_id);
	if (!candidate) {
		return { actionable: false, reason: `model selected "${decision.selected_id}", which is not in our candidate table; refusing` };
	}

	const probabilities = decision.probabilities ?? {};
	const probability = probabilities[decision.selected_id];

	const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
	const top = ranked[0]?.[1];
	const second = ranked[1]?.[1];
	const margin = top !== undefined && second !== undefined ? top - second : undefined;

	if (margin !== undefined && margin <= 0) {
		return { actionable: false, reason: `tied top scores (${top}); upstream treats ties as non-actionable`, probability, margin };
	}
	if (probability !== undefined && probability < thresholds.minProbability) {
		return {
			actionable: false,
			reason: `probability ${probability.toFixed(3)} is below policy minProbability ${thresholds.minProbability}`,
			probability,
			margin,
		};
	}
	if (margin !== undefined && margin < thresholds.minMargin) {
		return {
			actionable: false,
			reason: `margin ${margin.toFixed(3)} is below policy minMargin ${thresholds.minMargin}`,
			probability,
			margin,
		};
	}

	return {
		actionable: true,
		candidate,
		reason: `selected ${candidate.id}`,
		probability,
		margin,
	};
}

/**
 * Build the closed candidate table. Candidate descriptions are model INPUT, never
 * executable conditions, and the 26-option cap includes reobserve + abstain.
 */
export function buildCandidateTable(actions: Array<Omit<Candidate, "id"> & { id?: string }>, maxCandidates: number): {
	candidates: Candidate[];
	wire: Array<{ id: string; description: string }>;
	truncated: number;
} {
	const cap = Math.max(2, Math.min(26, maxCandidates));
	const reserved = 2; // reobserve + abstain
	const limit = cap - reserved;
	const taken = actions.slice(0, limit);
	const candidates: Candidate[] = [
		...taken.map((action, index) => ({
			id: action.id ?? `a${index}`,
			description: action.description,
			action: action.action,
		})),
		{ id: "reobserve", description: "The current observation is insufficient or ambiguous; take a fresh snapshot before choosing." },
		{ id: "abstain", description: "No listed action is safe or correct for this goal; do nothing." },
	];
	return {
		candidates,
		wire: candidates.map((c) => ({ id: c.id, description: c.description })),
		truncated: Math.max(0, actions.length - limit),
	};
}