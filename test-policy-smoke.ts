import { createJiti } from "/Users/shantanugoel/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });

const tools: any[] = [];
const commands: Record<string, any> = {};
const handlers: Record<string, Function[]> = {};
let active: string[] = ["read", "bash", "edit", "write"];

const pi: any = {
  registerTool: (t: any) => tools.push(t),
  registerCommand: (n: string, o: any) => { commands[n] = o; },
  registerFlag: () => {}, registerShortcut: () => {}, registerProvider: () => {},
  getActiveTools: () => active,
  setActiveTools: (names: string[]) => { active = names; },
  on: (event: string, h: Function) => { (handlers[event] ??= []).push(h); return () => {}; },
  events: { emit: () => {}, on: () => () => {} },
  appendEntry: () => {}, sendMessage: async () => {}, sendUserMessage: async () => {},
};

const mod: any = await jiti.import("./extensions/cua-driver.ts");
mod.default(pi);

const names = tools.map((t) => t.name);
console.log("registered tools:", names.join(", "));
console.log("commands:", Object.keys(commands).join(", "));
// 5 driver tools + the always-active loader. The loader must stay resident in both
// directions: it is how a model turns the rest on.
console.assert(names.length === 6 && names[0] === "cua_enable", "FAIL: expected cua_enable + 5 tools");
console.assert(commands.cua, "FAIL: /cua missing");
console.assert(!active.includes("cua_status"), "FAIL: tools must be INACTIVE by default");
console.log("default active set (cua absent):", active.join(", "));

// every tool must have a description + parameters + execute
for (const t of tools) {
  console.assert(typeof t.description === "string" && t.description.length > 20, `FAIL desc ${t.name}`);
  console.assert(t.parameters, `FAIL params ${t.name}`);
  console.assert(typeof t.execute === "function", `FAIL execute ${t.name}`);
}

// session_start then disabled-by-default tool_call block
const ctx: any = { ui: { notify: (m: string) => console.log("  notify:", m.split("\n")[0]), setStatus: () => {}, confirm: async () => true, select: async () => "Yes" }, mode: "print", hasUI: false, cwd: process.cwd(), signal: undefined, isIdle: () => true, isProjectTrusted: () => false };
await handlers.session_start[0]({}, ctx);
const block: any = await handlers.tool_call[0]({ toolName: "cua_status", input: {} }, ctx);
console.log("tool_call while disabled ->", JSON.stringify(block));
console.assert(block?.block === true, "FAIL: disabled extension must block");

// policy layer
const pol: any = await jiti.import("./src/policy.ts");
const cfg: any = await jiti.import("./src/config.ts");
const config = cfg.loadConfig();
console.log("config defaults -> driver.enabled:", config.driver.enabled, "| s1.enabled:", config.s1.enabled, "| confirmActions:", config.policy.confirmActions);
console.assert(config.driver.enabled === false && config.s1.enabled === false, "FAIL: must default OFF");
console.log("classify(click)=", pol.classify("click"), " classify(get_window_state)=", pol.classify("get_window_state"), " classify(unknown_thing)=", pol.classify("unknown_thing"));
console.log("deny kill_app ->", JSON.stringify(pol.checkTool("kill_app", config)));

// decision gate: abstain must never be actionable
const table = pol.buildCandidateTable([{ description: "click Submit", action: { a: 1 } }, { description: "type name" }], 26);
console.log("candidate ids:", table.candidates.map((c: any) => c.id).join(","), "| wire n:", table.wire.length);
const g1 = pol.gateDecision({ kind: "abstain", selected_id: "abstain", capture_id: "c1", probabilities: { a0: .2, a1: .2, reobserve: .2, abstain: .4 } }, table.candidates, { minProbability: .35, minMargin: .1 });
console.log("gate(abstain) ->", g1.actionable, "|", g1.reason);
const g2 = pol.gateDecision({ kind: "selected", selected_id: "a0", capture_id: "c1", probabilities: { a0: .4, a1: .4, reobserve: .1, abstain: .1 } }, table.candidates, { minProbability: .35, minMargin: .1 });
console.log("gate(tie)     ->", g2.actionable, "|", g2.reason);
const g3 = pol.gateDecision({ kind: "selected", selected_id: "a0", capture_id: "c1", probabilities: { a0: .2, a1: .1, reobserve: .4, abstain: .3 } }, table.candidates, { minProbability: .35, minMargin: .1 });
console.log("gate(lowprob) ->", g3.actionable, "|", g3.reason);
const g4 = pol.gateDecision({ kind: "selected", selected_id: "ghost", capture_id: "c1", probabilities: { a0: .9 } }, table.candidates, { minProbability: .35, minMargin: .1 });
console.log("gate(ghost id)->", g4.actionable, "|", g4.reason);
const g5 = pol.gateDecision({ kind: "selected", selected_id: "a0", capture_id: "c1", probabilities: { a0: .8, a1: .1, reobserve: .05, abstain: .05 } }, table.candidates, { minProbability: .35, minMargin: .1 });
console.log("gate(good)    ->", g5.actionable, "|", g5.reason);
console.assert(!g1.actionable && !g2.actionable && !g3.actionable && !g4.actionable && g5.actionable, "FAIL: gate logic");

// capture ledger staleness + target binding
const ledger = new pol.CaptureLedger(50);
ledger.remember("cap1", "window:1:2");
console.log("ledger fresh  ->", JSON.stringify(ledger.check("cap1", "window:1:2")));
console.log("ledger wrongT ->", ledger.check("cap1", "window:9:9").ok);
await new Promise((r) => setTimeout(r, 80));
console.log("ledger stale  ->", JSON.stringify(ledger.check("cap1", "window:1:2")));
console.log("\nSMOKE OK");
