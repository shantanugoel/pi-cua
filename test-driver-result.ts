/**
 * Regression tests for CLI result classification.
 *
 * These exist because `toResult` originally treated *any* non-JSON stdout as a failure,
 * which silently broke `listTools` and `describeTool` (their first lines are
 * `bring_to_front: ...` and `name: get_window_state`, which look like `code: message`).
 * Measured ground truth on driver 0.30.4:
 *
 *   success  -> exit 0, plain text (doctor, status, describe, list-tools, extension *)
 *   failure  -> exit != 0, and `call --json` failures are FLAT JSON with a `code`
 *
 * Skips cleanly when no driver is installed so CI without a driver still passes.
 *
 *   node --experimental-strip-types test-driver-result.ts
 */
import { createJiti } from "/Users/shantanugoel/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const driver: any = await jiti.import(new URL("./src/driver.ts", import.meta.url).href);

const resolved = driver.resolveBinary(null);
if (!resolved.path) {
	console.log("SKIP: cua-driver not installed");
	process.exit(0);
}
const bin: string = resolved.path;

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
	console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(42)} ${detail}`);
	if (!pass) failures++;
}

const cases: Array<{ label: string; run: () => Promise<any>; wantOk: boolean; wantCode?: string }> = [
	// Plain-text successes must not be mistaken for `code: message` errors.
	{ label: "doctor (plain text)", run: () => driver.runCuaDriver(bin, ["doctor"]), wantOk: true },
	{ label: "list-tools (first line is a tool name)", run: () => driver.listTools(bin), wantOk: true },
	{ label: "describe (first line 'name: ...')", run: () => driver.describeTool(bin, "get_window_state"), wantOk: true },
	// JSON success.
	{ label: "permissions status (JSON)", run: () => driver.permissionsStatus(bin), wantOk: true },
	// Genuine failures.
	{
		label: "get_window_state bad pid",
		run: () => driver.callTool(bin, "get_window_state", { pid: 99999, window_id: 1 }),
		wantOk: false,
		wantCode: "window_id_not_found",
	},
	{
		label: "unclassified tool (permission denied)",
		run: () => driver.callTool(bin, "bogus_tool_not_a_real_tool", {}),
		wantOk: false,
	},
	{ label: "extension inspect missing catalog", run: () => driver.runCuaDriver(bin, ["extension", "inspect", "cua-perception", "--catalog", "/nonexistent.json"]), wantOk: false },
];

for (const c of cases) {
	let r: any;
	try {
		r = await c.run();
	} catch (e: any) {
		check(c.label, false, `threw ${e?.message ?? e}`);
		continue;
	}
	const detail = r.ok ? `ok=true raw=${(r.raw ?? "").length}b` : `code=${r.code}`;
	check(c.label, r.ok === c.wantOk && (c.wantCode === undefined || r.code === c.wantCode), detail);
}

console.log(failures === 0 ? "\nall result-classification checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);