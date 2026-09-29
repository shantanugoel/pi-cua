# pi-cua — integrating Cua Driver + Cua-S1 into Pi

Research findings and implementation plan. Status: **research complete, build not started.**

---

## 0. TL;DR

1. **Cua Driver** is a clean fit. It is a Rust binary that speaks MCP over stdio *and*
   a `cua-driver call` CLI. Pi has **no native MCP**, so we either add `pi-mcp-adapter`
   or register first-class Pi tools that shell out to the CLI. **Recommend the CLI**,
   because it is the driver's own default agent surface and it keeps macOS TCC
   attribution on the supported `CuaDriver.app` daemon.
2. **`cua-s1-4b` cannot be a Pi `/model` model.** It is a LoRA adapter on frozen
   `Qwen/Qwen3.5-4B` that answers a *closed-candidate* contract
   (`cua.jev_choice_request_v1` → `cua.decision_choice_v1`): no open-ended generation,
   no tool calling, ≤26 options, Python/torch-only, 9.34 GB base weights. It must be a
   **decision-model sidecar** the extension calls, not a chat model in the picker.
3. **Do not default to `cua-s1-nano-0.1`.** It scores **0.000 on every hard
   cross-dataset text family** (chance = 0.250), and is marked `n/a` for the live agentic
   benchmark because its per-element scorer "has no goal conditioning and no `done`
   option" — it structurally cannot drive a loop. Its only win is 0.003 s vs 0.141 s
   latency, which we do not need. Default to **`cua-s1-4b-0.2`, text modality**
   (0.944 live agentic episode success). Offer nano, if at all, as an opt-in
   experimental scorer only.
4. Ship as **one Pi package with two extensions** (`cua-driver.ts`, `cua-s1.ts`) so the
   model half can be disabled independently of the driver half. Both off by default.

---

## 1. Environment facts (verified locally)

| Check | Result |
| --- | --- |
| Workspace `/Users/shantanugoel/dev/pi-cua` | empty, not a git repo — greenfield |
| `cua-driver` binary | **not installed** (`command -v` empty, no `/Applications/CuaDriver.app`) |
| Pi native MCP | **none** — zero MCP references in `docs/` or `dist/` |
| `~/.pi/agent/mcp.json` | exists (`chrome-devtools`) but is **orphaned** — no installed package reads it |
| Installed Pi packages | `pi-subagents`, `pi-agent-browser-native`, `pi-peer-comms`, `pi-cursor`, `pi-nous-portal-provider`, `rpiv-ask-user-question` |
| Pi extension dirs | `~/.pi/agent/extensions/` (`degoog-tools.ts`, `herdr-agent-state.ts`) |

The orphaned `mcp.json` matters: it looks like MCP works here, but it does not until
`pi-mcp-adapter` (or similar) is installed.

## 2. Cua Driver — integration surfaces

From `libs/cua-driver/README.md`:

| Surface | Notes |
| --- | --- |
| `cua-driver mcp` | MCP over stdio. Modern rev `2026-07-28` (`server/discover` + per-request `_meta`), legacy `2025-06-18` via `initialize`. Also serves the bundled skill pack via `skills/list` / `resources/read`. |
| `cua-driver call` | CLI for shell-oriented agents. **The skill's declared default.** |
| `@trycua/cua-driver` (npm, 0.30.4, MIT) | Generated UniFFI bindings, in-process native runtime, no daemon. Optional platform deps incl. `darwin-arm64`. But README: "language packages are for client applications, **not agents**." |
| `--claude-code-computer-use-compat` | Only changes `screenshot` to require `pid`+`window_id`. Not needed for us. |

**Tool catalog** (from `rust/Skills/cua-driver/SKILL.md` v0.30.4):
`status` `doctor` `describe <tool>` `list_apps` `list_windows` `launch_app`
`get_window_state` `get_desktop_state` `get_browser_state` `click` `type_text`
`verify_state` `start_recording` `stop_recording` `end_session`
(+ optional `history_status` / `history_query`, + `parse_visual_regions` via perception).

Core loop the skill mandates: **select exact target → observe → act once → verify from
fresh state.** Use returned `element_token`, never invented indices. A fresh snapshot
invalidates prior handles.

### Transport decision

**Recommended: CLI-backed first-class Pi tools.**

- Keeps macOS permission attribution on `CuaDriver.app` (`open -n -g -a CuaDriver --args
  serve`), which is the supported standalone mode. The npm SDK in-process path and raw
  `cua-driver serve` are explicitly unsupported/awkward for TCC: "Directly spawning a raw
  `cua-driver serve` outside `CuaDriver.app` … is unsupported."
- Gives the extension a place to enforce the caller-owned safety rules Cua's own docs
  require (capture_id discipline, precondition re-check, consent).
- Keeps Pi's context lean: expose ~5 curated tools instead of ~30 mirrored MCP tools.
- No dependency on a third-party MCP adapter.

**Documented alternative:** add to `~/.pi/agent/mcp.json` and install `pi-mcp-adapter`
(npm 3.1.0, MIT, token-efficient single proxy tool). Zero code, but driver tools arrive
through a proxy, and we lose the pi-side policy seam and the S1 decision hook.

Permission modes belong to the launching process and are fixed at launch — set via
`CUA_DRIVER_PERMISSION_MODE` (+ `CUA_DRIVER_CAPABILITY_MANIFEST_FILE`,
`CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED`). Default `standard`. Support `bounded`.
**Never** set `--dangerously-bypass-approvals` automatically.

## 3. Cua-S1 — what the model actually is

Family (all on Hugging Face, `cua-ai/*`):

| Checkpoint | What | Size | License |
| --- | --- | --- | --- |
| `cua-s1-nano-0.1` | from-scratch ~855K-param option-attention classifier | 6.9 MB | Apache-2.0 |
| `cua-s1-forms` (`form-v0`) | finetuned text-only nano variant | 2.8 MB | MIT |
| `cua-s1-4b-0.1` | LoRA on frozen `Qwen/Qwen3.5-4B` | 272 MB | Apache-2.0 (adapter) |
| `cua-s1-4b-0.2` | separately trained `text/` + `multimodal/` LoRA pair, + RL on live GUI | 187 MB | Apache-2.0 (adapter) |

Base `Qwen/Qwen3.5-4B` = 9.34 GB, Apache-2.0, downloaded from Qwen's repo.

### Wire contract

- Request `cua.jev_choice_request_v1` (a `_v2` exists: native snapshot + compact a11y
  elements): goal, `capture_id`, typed visual regions, bounded history, candidate
  `{id, description}` list.
- Response `cua.decision_choice_v1`: `schema`, `kind` (`selected` | `reobserve` |
  `abstain` | `error`), `capture_id`, `selected_id`, `model`, `confidence`,
  `probabilities`, `reason`. Exactly 8 keys.
- **≤26 candidates** including `reobserve`/`abstain` (one letter per option); over that →
  `kind:"error", reason:"option_limit"`.
- Never contains tool names, tool arguments, coordinates, or screenshot bytes.
- Env: `S1_BASE_MODEL_PATH`* (req), `S1_ADAPTER_PATH`* (req), `S1_DEVICE` (cpu),
  `S1_DTYPE` (float16; use bfloat16 on CPU), `S1_MODALITY` (text), `S1_ADAPTER_ID`,
  `S1_ADAPTER_REVISION`.

### Two existing service shapes (reuse, don't reinvent)

1. **`libs/cua-s1/ci/warm_chooser.py` — stdio, line-delimited JSON.**
   Prints `{"ready":true, model, modality, device, dtype, load_s, peak_rss_mb, ...}` once
   loaded, then per line reads `{"request": <req>, "screenshot": "<png path>"}` and
   replies `{"decision": <resp>, "latency_ms": N, "peak_rss_mb": N}` or
   `{"error": "..."}`. Has `--smoke` (positive+negative fixtures) and `--warmup`.
   Copies mmap'd weights into anonymous memory (`make_resident`) so the kernel can't
   evict 9 GB and force disk rereads per step. Requires repo layout (`parents[3]`) +
   `libs/cua-driver/examples/jev-use/python/` on `sys.path`.
2. **`libs/cua-driver/examples/jev-use/python/s1_service.py` — HTTP loopback *client*.**
   `CUA_S1_DECISION_URL` (e.g. `http://127.0.0.1:8791/decide`), POST the request, get the
   decision. Enforces http+loopback+no userinfo, 30 s timeout, 256 KB cap, and a strict
   `validate_decision()` (schema, kind, capture_id match, selected_id ∈ supplied IDs,
   probabilities set-equal to candidate IDs and all finite in [0,1]). **No server ships
   for this** — only the client.

**Why resident matters:** cold load is 10–35 s (mps) / 30–43 s (cpu), and Driver captures
expire after **60 s**, with the action required to carry the same `capture_id`. A
per-decision process cannot fit. One resident process is mandatory, not an optimization.

Warm latency (M1 Ultra, mps): 4b-0.2 text **1.07–2.83 s**, multimodal **5.55–6.7 s**.
Multimodal at 2560×1600 = 22–30 s/decision → **downscale large captures before scoring.**
Needs ≥16 GB free; 8 GB hosts cannot run it.

### Why it is not a Pi model

Registering it via `pi.registerProvider()`/`models.json` would put a model in `/model`
that cannot produce open-ended text or tool calls, so Pi's agent loop breaks immediately.
It is a *policy head* for one screen-state decision, not an assistant. Model it as:

> **Decision model** = sidecar service; **Driver** = actuator; **Pi's active model** = planner.

If a `/model` entry is ever required for UX, it would be a *cosmetic* alias backed by a
custom provider that only satisfies the closed-candidate contract — I recommend against it.

## 4. nano vs 4B — the comparison you asked for

From `libs/cua-bench-s1/README.md` (hard = held-out cross-dataset GUI-360; chance = 0.250):

| Row | nano-0.1 | 4b-0.1 | **4b-0.2** |
| --- | --- | --- | --- |
| 6 core families, **text, hard** | **0.000 on all six** | 0.167–0.571 | **0.833–1.000, 0.875 overall** (ECE 0.121) |
| 6 core families, **mm, hard** | **0.000 on all six** | 0.000–0.583 | **0.750–1.000, 0.929 overall** (ECE 0.069) |
| 6 core families, mm *same-distribution* | **1.000** | 1.000 | 0.000–0.778 |
| `safety_gate` text zero-shot | 0.000 | 0.071 | **1.000** |
| `general_decision` (external, OOD) | **n/a** | 0.632 | **0.887** |
| `cua_bench_basic` live agentic | **n/a** | 0.000 text / 0.333 mm | **0.944 text / 0.722 mm** |
| latency, text hard | **0.003 s** | 0.121–0.128 s | 0.141 s |

### Verdict: do not default to nano

1. **It cannot be an agent policy.** Bench note, verbatim: "`cua-s1-nano-0.1` and `jev`
   are `n/a`: neither can produce a single cross-element comparable score for 'which
   action to take now' (nano's per-element scorer has no goal conditioning and no `done`
   option…)". No goal conditioning ⇒ you can't tell it the task. No `done` ⇒ it can't
   terminate. It picks the best option *per element*, not one action for the screen.
2. **0.000 on every hard text row is below chance (0.250),** not merely weak.
3. **The 1.000 multimodal rows are a trap** — that is the *same-distribution* split, i.e.
   the distribution it trained on. On the held-out cross-dataset multimodal split it is
   0.000 across the board.
4. **No supported integration path.** `choose_decision.py` accepts only the 4B PEFT
   adapters; `_resolve_s1_adapter()` raises "cua-s1-nano and cua-s1-forms checkpoints are
   not supported by this chooser". Wiring nano means writing a custom scorer against
   `cua_s1.nano.load_nano_checkpoint`, matching the 55-concept catalogue in
   `cua_s1/concepts.py`, and inventing the goal conditioning the architecture lacks.
5. **Environment conflict.** nano's multimodal needs a frozen vision backbone
   (SmolVLM-256M or SigLIP) from the `nano-vision` extra, which **cannot coexist** with
   `four-b` (Transformers 4 vs Transformers 5). Supporting both = two venvs.
6. **The latency win is not our bottleneck.** 0.141 s in-process, or 1–3 s warm through
   our service, already fits a 60 s capture budget with enormous margin. Trading 0.875 →
   0.000 to save ~1.3 s/step is strictly bad.

### Recommendation

- **Default (when S1 is enabled): `cua-s1-4b-0.2`, `S1_MODALITY=text`, `mps` +
  `float16` on Apple silicon, `cpu` + `bfloat16` elsewhere.** Best live agentic score,
  no screenshot needed, fastest of the viable options.
- **Offer `multimodal` as an opt-in** for non-AX / canvas surfaces (0.722 live, ~6 s,
  downscale to ≤1280×800).
- **Do not ship nano as a default or as a co-equal option.** If included at all, put it
  behind `experimental: true` in a separate venv, labelled *per-element candidate
  pre-filter / benchmark ablation — not a decision maker*. Reasonable v2 use: prune 26
  candidates to a plausible handful before a 4B call. Note its own model card: on
  out-of-catalogue labels `cua-s1-forms` answers a confident `skip` — 29.3% held-out vs
  97.5% in-distribution — so confident-but-wrong is a documented failure mode in this
  architecture family.
- **Also exclude `cua-s1-4b-0.1` as a default:** its text mode "collapses to `skip` on
  340/360 steps; its SFT removed the agentic capability its zero-shot base already had"
  (0.000 live agentic text). Keep it selectable for A/B against 0.2.
- Zero-download fallback for plumbing: `--model mock`. (TypeSafe **Jev** `--model jev`
  exists as a hosted decision model but is also `n/a` for live agentic use, so it is not
  a better default — 4b-0.2 genuinely is.)

## 5. Proposed architecture

```
pi (Node)                                        Python (uv venv)
┌─────────────────────────────────────────┐      ┌──────────────────────────┐
│ extensions/cua-driver.ts                │      │ src/s1d/service.py       │
│  tools: cua_status, cua_observe,        │      │  warm FourBModel +       │
│         cua_act, cua_verify, cua_decide │      │  S1DecisionModel + choose│
│   │ spawn `cua-driver call --json`      │      │  stdio line-JSON, ready  │
│   ▼                                     │      │  handshake, --smoke      │
│ CuaDriver.app daemon (TCC grants)       │      └───────────▲──────────────┘
└───────────────┬─────────────────────────┘                  │ line JSON
                │ capture_id, regions, candidates            │
┌───────────────┴─────────────────────────┐                  │
│ extensions/cua-s1.ts  (OFF by default)  │──────────────────┘
│  /cua-s1 enable|disable|status|logs|smoke|install           pi.events
└─────────────────────────────────────────┘  ◀──────────────▶ (cross-extension)
```

**Loop:** `cua_observe` → build immutable candidate table → `cua_decide` (S1 if enabled,
else Pi's own model) → re-check precondition against the *original* capture → dispatch one
authorized action → `cua_verify` from fresh state.

### Layout

```
pi-cua/
├── package.json            # keywords:["pi-package"], pi.extensions, peerDeps "*"
├── extensions/
│   ├── cua-driver.ts       # driver tools + /cua
│   └── cua-s1.ts           # gated S1 sidecar + /cua-s1
├── src/
│   ├── driver.ts           # spawn/probe, JSON envelope, version+schema check
│   ├── policy.ts           # consent gate, allowlist, capture_id + margin rules
│   ├── config.ts           # ~/.pi/agent/pi-cua.json
│   ├── s1d/
│   │   ├── service.py      # resident stdio decision service
│   │   ├── client.ts       # line-JSON client, per-request timeout
│   │   └── vendor/         # pinned choose_action.py + decision_models.py (+SHA file)
│   └── ui.ts
├── skills/cua/SKILL.md     # on-demand workflow guidance, keeps context lean
├── scripts/setup.sh        # sparse-checkout, uv sync --extra four-b, pinned hf + sha256
└── README.md
```

Two extensions in one package is deliberate: `pi config` and the package resource filter
(`{"source":"...","extensions":["!extensions/cua-s1.ts"]}`) can then drop the model half
without losing the driver, and vice versa.

### Enable/disable (all default OFF)

1. **Driver tools:** register always, keep **inactive**; activate via
   `pi.setActiveTools()` from `/cua on`. (Per docs: register first, activate later;
   unknown names are ignored. `defaultTools` doesn't touch extension tools, so we own it.)
2. **S1:** `~/.pi/agent/pi-cua.json` → `{"s1":{"enabled":false,...}}`, plus `PI_CUA_S1=1`
   for one-off. When disabled the extension must **never** spawn Python, read the venv, or
   touch the 9.34 GB weights. `/cua-s1 enable|disable|status|logs|smoke`.
3. Lifecycle: no processes/sockets/timers in the factory (docs: some invocations load
   extensions without a session). Spawn lazily from the command/tool that needs it; kill
   idempotently in `session_shutdown`.
4. Session-scoped state in tool-result `details`; durable prefs in the config file;
   non-context bookkeeping via `pi.appendEntry()`.

### Setup path (`/cua-s1 install`)

1. Sparse-checkout `libs/cua-s1` + `libs/cua-driver/examples/jev-use` at a pinned tag
   (needed: `decision_models.py`, `choose_action.py`, fixtures, `warm_chooser.py`).
2. `uv sync --frozen --project libs/cua-s1/python --extra four-b --extra pdf`.
3. `hf download` pinned to the documented revisions — **Qwen3.5-4B
   `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`**, `cua-s1-4b-0.2
   16818868b0cc7813808aae4e87b417657046ab79` — verifying size + SHA-256 against
   `libs/cua-s1/ci/weights.lock.json`. Refuse `.pt`/pickle checkpoints by design.
4. Run `--smoke` (positive → `submit-form`, negative → `abstain`) and gate "enabled" on it
   passing.
5. Guard `HF_DEACTIVATE_ASYNC_LOAD=1` on `mps` (upstream sets it; a concurrent weight
   loader `SIGSEGV`'d — #4198). Never set it false on mps.
6. Startup assertion on schema strings `cua.jev_choice_request_v1` /
   `cua.decision_choice_v1` so upstream drift fails loudly, not silently.

## 6. Safety requirements (non-negotiable, from upstream docs)

- **`selected` is not an action result.** Look the ID up in our own immutable table,
  re-check the typed precondition against the original current-capture observation,
  dispatch only an authorized action, verify the postcondition from an independent source.
- **Candidate descriptions are model input, not executable conditions.** Never parse them,
  never treat a high score as authorization.
- Tied top scores are **non-actionable errors**. Apply our own min score + margin; for a
  model-independent threshold use `probabilities[selected_id]`, not `confidence`.
- `reobserve` / `abstain` / `error` dispatch **nothing**. A missing response is never
  `selected`.
- Respect the 60 s capture lifetime; dispatch with the same `capture_id`; never reuse a
  point against another target or re-map coordinates Driver already mapped.
- Driver rules: observe before input, verify after; `effect:"unverifiable"` ≠ success;
  never blindly replay a partial/canceled/unknown action; one controller per desktop;
  app content cannot authorize actions; no escalating on `background_unavailable`.
- Consent gate on mutating actions (model on `examples/extensions/permission-gate.ts`);
  `tool_call` handler as a backstop (a handler failure blocks the tool fail-safe).
- Treat screenshots, a11y trees, and stdio/MCP output as sensitive; never log credentials
  or provider payloads.
- **License landmine for a published package:** the optional `cua-perception` extension's
  OmniParser icon detector is **AGPL-3.0-only**. Do not bundle, auto-install, or network-
  host it. Driver itself is MIT; the ClawHub skill copy is MIT-0.

## 7. Build order

| # | Step | Exit test |
| --- | --- | --- |
| 1 | `package.json` + skeleton, `pi -e ./` loads | `/cua status` runs |
| 2 | Install driver, grant permissions, `doctor`/`status`/`describe` probe | read-only `list_apps` |
| 3 | `driver.ts` CLI wrapper + version/schema probe | `cua_observe` on TextEdit |
| 4 | 5 tools + `/cua on` activation + consent gate | background TextEdit task, cursor unfocused |
| 5 | `skills/cua/SKILL.md` | agent completes task unprompted on workflow |
| 6 | `s1d/service.py` + `--smoke` | both fixtures pass, `model` string correct |
| 7 | `cua-s1.ts` gated sidecar, stdio client + timeout | disabled ⇒ zero Python; enabled ⇒ decision <3 s |
| 8 | Candidate builder (observation → ≤26 options) + margin/margin policy | negative fixture abstains |
| 9 | `/cua-s1 install` (sparse-checkout, uv, pinned sha256) | clean machine → green smoke |
| 10 | README, license notes, `pi-package` keyword | `pi install ./pi-cua` |

## 7b. Live-driver findings (verified on macOS, driver 0.30.4, TCC granted)

These changed the design and are worth keeping:

1. **The CLI `call --json` payload is FLAT** — `elements`, `tree_markdown`,
   `element_count`, `degraded`, `degraded_reason`, `background_input`, `escalation`,
   `screenshot_png_b64`, `screenshot_width/height/scale`, `window_bounds`. There is **no
   MCP `structuredContent` wrapper**. Code against the flat shape.
2. **`capture_id` is per-process and disposable over CLI.** `get_desktop_state` returns
   e.g. `capture_fd958348…_0000000000000001`, but the *next* CLI process answers
   `capture id is unknown`. Matches the perception doc: "Each one-shot CLI process owns
   a disposable capture registry, so a later process cannot resolve its `capture_id`."
   **Consequence: capture-bound `parse_visual_regions` and capture-bound pixel clicks
   cannot work over one-shot CLI.** They need one persistent `cua-driver mcp` stdio
   child or the typed SDK. Element-addressed actions are unaffected. This is the real
   reason to add a persistent MCP child in phase 2 — the same place the S1 sidecar
   attaches.
3. **`get_window_state` returned `degraded: true` / `ax_window_unresolved` with 0
   elements for every app tested** (Finder, Ghostty, Strongbox, Preview, Activity
   Monitor, Calendar, …) while the screenshot was valid. Documented behaviour: the tree
   comes back empty, background input is refused, and the escape hatch is
   `delivery_mode:"foreground"`. Must be surfaced to the model, not returned as a silent
   empty tree.
4. **`permissions status --json` has two shapes** — pending
   `{daemon_running, status:"unknown", reason}` vs granted
   `{accessibility, screen_recording, source}`. Normalise both.
5. Useful `get_window_state` params: `include_screenshot:false` (cheap tree-only
   re-index), `include_accessibility_tree:false` (screenshot-only preview),
   `max_image_dimension`, `timeout_ms` (AX walk budget, default 1000). `capture_mode` is
   deprecated and ignored.
6. Upstream warns the tree "lies on some surfaces: Electron echo-confirms, Catalyst null
   values, virtualized off-viewport rows with `h:1` frames" — cross-check tree and
   screenshot rather than trusting either.

## 8. Open risks

- **macOS TCC**: pi is a Node CLI; only `CuaDriver.app` (or embedded/`--direct`) is a
  supported grant target. Validate early (step 2) — this is the likeliest blocker.
- **Memory**: 9.34 GB weights + activations; must refuse to start under 16 GB free and
  say so instead of OOMing.
- **Upstream churn**: `jev-use` is *example* code, not a stable contract ("an
  example-local integration, not a new Driver, MCP, or cross-language contract"). Pin a
  tag, vendor with provenance, assert schemas at startup.
- **`_v2` request schema** (RFC #4268) exists; pick v1 for v1 and detect v2 later.
- Model quality is *not* established for desktop use: upstream flags a negative-control
  counterexample where S1 picked a mismatched action at p=0.777. So the caller-side typed
  policy guard is the real safety layer, not the model's confidence.

## Sources

- https://github.com/trycua/cua — `libs/cua-driver/README.md`,
  `libs/cua-driver/docs/mcp-protocol-and-skills.md`,
  `libs/cua-driver/rust/Skills/cua-driver/SKILL.md`,
  `libs/cua-driver/examples/jev-use/{decision-models.md,python/{choose_decision,s1_service,decision_models}.py}`,
  `libs/cua-s1/{README.md,MODEL_CARD.md}`, `libs/cua-s1/ci/warm_chooser.py`,
  `libs/cua-bench-s1/README.md`
- https://huggingface.co/cua-ai/cua-s1-4b-0.2 · /cua-s1-4b-0.1 · /cua-s1-nano-0.1 · /cua-s1-forms
- https://registry.npmjs.org/@trycua/cua-driver (0.30.4)
- `@earendil-works/pi-coding-agent` docs: `extensions.md`, `custom-provider.md`,
  `models.md`, `packages.md`, `settings.md`; `examples/extensions/{dynamic-tools,permission-gate}.ts`
- https://github.com/nicobailon/pi-mcp-adapter (MCP option, not chosen)