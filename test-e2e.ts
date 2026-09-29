import { createJiti } from "/Users/shantanugoel/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const d: any = await jiti.import("./src/driver.ts");
const pol: any = await jiti.import("./src/policy.ts");

const bin = d.resolveBinary(null);
console.log("binary:", bin.path, "via", bin.source);

const perms = await d.permissionsStatus(bin.path!);
console.log("perms:", perms.ok ? perms.data : perms.message);

const apps = await d.callTool(bin.path!, "list_apps", {});
if (!apps.ok) { console.log("list_apps FAILED:", apps.code, apps.message); process.exit(1); }
const running = (apps.json?.apps ?? []).filter((a: any) => a.running && a.kind === "desktop");
console.log(`list_apps OK — ${running.length} running regular apps`);

// list_apps does not populate per-app windows; window discovery is list_windows' job.
let pick: any = null; let win: any = null; let wins: any = null;
for (const a of running) {
  const w = await d.callTool(bin.path!, "list_windows", { pid: a.pid });
  const list = w.ok ? (w.json?.windows ?? []) : [];
  if (list.length) { pick = a; wins = w; win = list[0]; break; }
}
if (!pick) { console.log("no windowed app found; stopping"); process.exit(0); }
console.log(`picked: ${pick.name} pid=${pick.pid} windows=${(wins.json?.windows ?? []).length}`);
console.log("   window_id:", win.window_id, "| title:", String(win.title ?? win.name ?? "").slice(0, 60));

const st = await d.callTool(bin.path!, "get_window_state", { pid: pick.pid, window_id: win.window_id });
if (!st.ok) { console.log("get_window_state FAILED:", st.code, st.message); process.exit(1); }
const j: any = st.json;
const captureId = j.capture_id ?? j.structuredContent?.capture_id;
const elems = j.structuredContent?.elements ?? j.elements ?? [];
console.log(`\nget_window_state OK — ${Array.isArray(elems) ? elems.length : "?"} elements, capture_id=${captureId ?? "NONE"}`);
if (Array.isArray(elems) && elems.length) {
  console.log("   sample:", elems.slice(0, 4).map((e: any) => `${e.role}${e.label ? `/${String(e.label).slice(0, 18)}` : ""}`).join(" | "));
}

// The ledger key fix: observe-remember then act-check must agree on the same target.
if (captureId) {
  const key = `win:${pick.pid}:${win.window_id}`;   // targetKey() in the extension
  const ledger = new pol.CaptureLedger();
  ledger.remember(captureId, key);
  console.log("\nledger observe->act same target ->", JSON.stringify(ledger.check(captureId, key)));
  console.log("ledger cross-target refused      ->", ledger.check(captureId, `win:9999:9999`).ok);
}

// Perception detection (optional extension path)
const perc = await d.runCuaDriver(bin.path!, ["extension", "status", "cua-perception"]);
const txt = d.outputOf(perc);
console.log("\nperception:", /not installed/i.test(txt) ? "not_installed" : /installed/i.test(txt) ? "installed" : "unknown");
if (/not installed/i.test(txt)) {
  const probe = await d.callTool(bin.path!, "parse_visual_regions", { capture_id: captureId ?? "x" });
  console.log("parse_visual_regions while absent ->", probe.ok ? "unexpectedly OK" : `${probe.code}: ${probe.message.slice(0, 70)}`);
}
console.log("\nE2E OK");
