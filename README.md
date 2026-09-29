# pi-cua

Computer-use for [Pi](https://pi.dev) via [Cua Driver](https://cua.ai/docs/cua-driver),
plus an optional [Cua-S1](https://github.com/trycua/cua/tree/main/libs/cua-s1)
closed-candidate decision model.

**Everything is off by default.** A fresh install registers nothing into your context
and touches no permissions until you opt in.

## Status

| Piece | State |
| --- | --- |
| `cua-driver.ts` — driver tools, consent gate, skill | **built**, typechecks, loads in Pi, safety layer unit-tested |
| `cua-s1.ts` — Cua-S1-4B decision sidecar | **not built yet** (phase 2 — see [PLAN.md](PLAN.md)) |

## Install

```bash
# 1. the driver itself (signed CuaDriver.app + ~/.local/bin/cua-driver)
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
open -n -g -a CuaDriver --args serve

# 2. the Pi package
pi install ./pi-cua
```

Then grant macOS Accessibility + Screen Recording to **CuaDriver.app**. This is the
only step that needs you; Apple attributes those grants to a responsible app identity
and will not let a terminal or an agent do it:

```bash
cua-driver permissions grant      # or, inside Pi:  /cua grant
```

Verify:

```bash
cua-driver permissions status --json   # expect "status": "granted"
cua-driver doctor
```

## Enable

Four ways:

```bash
pi -e ./extensions/cua-driver.ts        # one run
PI_CUA=1 pi                             # one run
/cua session                            # THIS SESSION ONLY, writes nothing
/cua on                                 # persists to ~/.pi/agent/pi-cua.json
# or by hand:       {"driver":{"enabled":true}} in ~/.pi/agent/pi-cua.json
# or just ask the model: "drive Finder"  # it calls cua_enable (this session only)
```

**Scope is deliberate and the two spellings differ on purpose:**

| | effect | writes config? | survives new session? |
|---|---|---|---|
| `/cua session` (or `once`) | this session only | no | no |
| `/cua on` (or `enable`) | persistent | yes | yes |
| `cua_enable` tool | this session only | no, unless `persist:true` | no |

`/cua off` reverses all three, including any session override. `/cua status` shows what is
active. Nothing about Cua is rendered persistently in the footer — there is no status
line; ask `/cua status`.

## Context cost when disabled

Off is the default, and off really is off. `cua_status`, `cua_observe`, `cua_act`,
`cua_verify` and `cua_describe` are registered but **inactive**, and pi builds both the
tool-snippet list and the rules list from the *selected* tools only
(`dist/core/system-prompt.js`), so none of their descriptions reach the model. The `/cua`
command is not model-visible at all. A disabled `session_start` reads one JSON file and
does nothing else — no subprocess, no driver probe, no MCP child, and no persistent footer status.

Two things are always resident, by design:

- **`cua_enable`** (~1 small tool definition). This is the loader pattern pi documents in
  `docs/extensions.md`: optional tools stay inactive and a loader tool activates them.
  Without it a model could not self-enable at all — an inactive tool is absent from the
  tool list, so calling it throws `Unknown tool name`, extension commands are not
  model-invocable, and `ctx.reload()` exists only on the command context.
- **the `cua` skill's frontmatter** (~100 tokens in `<available_skills>`). The 7.5 KB body
  loads only when the model reads it. To drop even the frontmatter, install with
  resource filtering: `{"source":"...","skills":[]}`.

`cua_enable` is session-scoped unless called with `persist:true`. A new session clears it;
`/cua off` clears it. Note that pi promotes every extension tool on `/reload`
(`includeAllExtensionTools: true`), so `session_start` re-asserts the correct set in both
directions — otherwise a `/reload` would silently leak the disabled tools back into
context.

## Tools

Five tools, not the driver's 58. The driver's own skill defines the loop
(observe → act once → verify), so the loop is what gets exposed and `cua_describe`
serves parameter details on demand. This keeps Pi's context window lean.

| Tool | Class | What |
| --- | --- | --- |
| `cua_status` | observe | install, daemon, TCC, capability state |
| `cua_observe` | observe | apps / windows / one window's AX tree / display / visual regions |
| `cua_act` | **mutate** | exactly one action on one exact target |
| `cua_verify` | observe | postcondition from independent fresh state |
| `cua_describe` | observe | the installed driver's own tool list + schemas |

`cua_observe mode:"regions"` (visual regions) and any `cua_act` carrying a `capture_id`
are routed over the persistent `cua-driver mcp` child; everything else uses the CLI.

## Configuration

`~/.pi/agent/pi-cua.json`. Every value below is the default.

```json
{
  "driver": {
    "enabled": false,
    "binary": null,
    "permissionMode": "standard",
    "capabilityManifest": null,
    "autoStartDaemon": true,
    "callTimeoutMs": 60000,
    "sessionLabelPrefix": "pi",
    "passSessionLabel": false
  },
  "s1": {
    "enabled": false,
    "checkpoint": "cua-s1-4b-0.2",
    "modality": "text",
    "device": "auto",
    "dtype": "auto",
    "modelsDir": "~/cua-s1-models",
    "cuaRepo": null,
    "minProbability": 0.35,
    "minMargin": 0.1,
    "maxImageDimension": 1280
  },
  "policy": {
    "allowMutations": true,
    "confirmActions": true,
    "confirmPerApp": false,
    "allowApps": [],
    "denyApps": [],
    "denyTools": ["kill_app", "clipboard_write", "clipboard_read",
                  "browser_set_input_files", "install_extension",
                  "install_ffmpeg", "set_config", "revoke"],
    "maxCandidates": 26
  }
}
```

Notes:

- `permissionMode` supports `standard` and `bounded`. **`unrestricted` is not
  supported** — it requires `--dangerously-bypass-approvals`, and this package will
  never pass that flag. For `bounded`, start the daemon yourself with a reviewed
  capability manifest.
- `denyTools` is a denylist, not a convenience list. `kill_app`, clipboard access, and
  driver reconfiguration are deliberately refused out of the box.
- Anything unrecognised by the action classifier is treated as **mutating** (fail
  closed).
- Mutating actions **fail closed when there is no UI** to consent through, so
  unattended runs need an explicit `policy.confirmActions: false`.

## Why CLI-first, with one persistent MCP child

Pi has no built-in MCP support, and the driver's own skill names the CLI as the default
agent surface ("Use the CLI by default when a shell is available"); one-shot CLI calls
are daemon-backed. Most calls stay on the CLI because it:

- keeps TCC attribution on the supported `CuaDriver.app` identity — spawning a raw
  `cua-driver serve` outside that bundle is documented as unsupported;
- gives this extension the caller-side policy seam that Cua's own docs require the
  caller to own.

One class of call cannot live on the CLI: anything bound to a `capture_id`. Capture state
is scoped to the MCP **connection**, and a one-shot CLI process closes its connection the
moment it prints, so the id it issued is already dead. pi-cua therefore starts a single
persistent `cua-driver mcp` child lazily and routes `get_window_state`,
`get_desktop_state`, `parse_visual_regions` and capture-bound `cua_act` calls through it,
so the capture that produces an id and the call that consumes it share one connection.
The child is closed on `session_shutdown`.

If you would rather put everything on MCP, install [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)
and add `{"cua-driver": {"command": "cua-driver", "args": ["mcp"]}}` to
`~/.pi/agent/mcp.json`. You lose the policy seam and the Cua-S1 hook, and note that
`this package's` consent gate will not cover those tools.

## Safety model

Cua's docs put the burden on the caller, not the model:

> `selected` is not an action result. The application must look up the selected ID in
> its original candidate table, re-check any typed action precondition against the
> original current-capture observation, dispatch only an authorized action through
> Driver, and verify the postcondition from an independent source.

So `src/policy.ts` is the real safety layer, and model confidence is not:

- **Consent** — every mutating action needs an interactive confirmation; no UI means
  no action.
- **Denylist + fail-closed classification** — unknown tools count as mutating.
- **App gating** — `allowApps` / `denyApps`.
- **Capture ledger** — Driver captures expire after 60s and an action must carry the
  same `capture_id` as the observation it was grounded on. Stale captures and captures
  reused against a different target are refused locally.
- **Decision gate** (phase 2) — `reobserve` / `abstain` / `error` dispatch nothing;
  tied top scores are non-actionable; a selected id that is not in *our* candidate table
  is refused; our own `minProbability` / `minMargin` apply, using
  `probabilities[selected_id]` rather than the provider's `confidence`.

## OmniParser / `cua-perception`

`cua-perception` is an **optional, separately licensed** Driver extension that powers
one tool, `parse_visual_regions`: it turns one screenshot into model-neutral **text
regions** (PP-OCRv5, Apache-2.0) and **icon regions** (an OmniParser icon detector —
a fine-tuned Ultralytics YOLO from `microsoft/OmniParser-v2.0`, **AGPL-3.0-only**).
It runs in a CPU-only ONNX worker with no network and no Python, and it never captures
the screen, picks an action, or sends input.

**What it buys:** the only semantic route into surfaces with no accessibility tree —
Chromium web content and canvas tools (Blender, Figma, DAWs, game engines). Without it
those fall back to raw screenshot reasoning, which loses the capture-bound provenance
chain that makes a pixel click auditable, and it removes the structured region
candidates the Cua-S1 multimodal path is evaluated against.

**What it costs:** the AGPL-3.0-only detector. Upstream is explicit:

- *"Private use is unrestricted. Running the extension on your own machines does not
  trigger the AGPL's source-distribution obligations."*
- *"Redistribution carries the AGPL obligations"* — license text, notices, model and
  source ledgers, SBOM, and corresponding source including the pinned source model and
  the conversion/export material.
- *"Hosted services can trigger the network-use clause"* — the shipped ONNX is a
  converted (so modified) version of the upstream model, so §13 can apply.
- The upstream publishes **no training data or training code**, so corresponding
  source has a hard limit Cua cannot fill. Ultralytics sells separate commercial
  licenses; Cua can grant nothing beyond AGPL-3.0-only.
- Driver itself stays MIT either way, because it talks to the worker as a separate
  process over a protocol.

**What this package does — and why it is worded this way.** `pi-cua` gives you the
full capability without shipping a single AGPL byte:

```bash
/cua perception status    # what is installed, and the latest upstream release
/cua perception install   # shows the licence notice, then fetches the signed
                          # artifact straight from Cua's GitHub release
/cua perception install --yes    # headless: accept the notice non-interactively
/cua perception remove           # (or set PI_CUA_ACCEPT_AGPL=1)
```

The notice is always emitted before anything is downloaded. In an interactive session
you confirm it in a dialog; headless runs must opt in explicitly with `--yes` or
`PI_CUA_ACCEPT_AGPL=1`, and the notice is still printed so it reaches the transcript or
log. `/cua on` reminds you once when regions are unavailable.

That is deliberate, and it is **not** because attribution was considered enough. It is
not: AGPL-3.0-only's consideration is *source availability*, not credit. Giving credit
satisfies MIT/BSD/Apache-style attribution; it does nothing for AGPL. Redistributing the
artifact would mean shipping the AGPL licence text, notices, the model and source
ledgers, the SBOM, and the Corresponding Source (the converted ONNX plus the pinned
source model and the conversion/export material) — and §13 can additionally apply to a
hosted offering.

So the rule is simply: ** whoever downloads it is whoever installs it.** You fetch from
Cua's own signed release, `pi-cua` never becomes a redistributor, and `install_extension`
stays in `policy.denyTools` so the agent cannot add it behind your back. Three practical
reasons to prefer this even setting licence aside:

- the archive is **~426 MB per platform** (~1.27 GB across all three) — not an npm tarball
- each release's **catalog expires one year** after its release commit, so a vendored copy
  silently goes stale
- Cua rotates the pinned model revisions; fetching at install time always gets the
  current verified artifact

Credit and provenance are still recorded: `cua_status` reports the resolved release tag,
and this README names the upstream repos and licences.

> If you do want to vendor or re-host it, that is a real AGPL question for your own
> counsel — but you don't need to, so there's no reason to spend that risk.

### Using regions

`cua_observe` `mode:"regions"` parses one capture into text + icon regions through the
persistent child described above.

Verified end to end on driver 0.30.4 with `cua-perception` 0.2.1 installed:
`mode:"windows"` -> on-screen window -> `mode:"window"` (`degraded: false`, `captureId`
issued) -> `mode:"regions"` returned 8 regions from `omniparser-v2-ppocrv5-en` in ~4.7 s
with the same `capture_id` echoed back. Across 7 on-screen windows the parser produced
40 regions each, 10-21 of them OCR text.

Two shape details that cost real debugging time:

- a `kind:"text"` region carries its OCR string in **`text`**; `kind:"icon"` carries
  **`label`**. Reading `.label` on a text region returns `undefined`.
- `capture_id` exists only if a screenshot was taken. `include_screenshot:false` means
  there is nothing to parse.

Region bounds are in the returned screenshot's space and
`capture.action_coordinate_space` maps them to action space; the driver applies that
mapping once, so never rescale a point yourself.

## Cua-S1 (phase 2)

`cua-s1-4b` is **not a chat model** and will never appear in `/model`. It is a LoRA
adapter on frozen `Qwen/Qwen3.5-4B` that answers a closed-candidate contract
(`cua.jev_choice_request_v1` → `cua.decision_choice_v1`, ≤26 options, no open
generation, no tool calls). It runs as a resident Python sidecar and is exposed as a
`cua_decide` tool.

**Default checkpoint: `cua-s1-4b-0.2`, text modality.** It is the only checkpoint with
a strong live agentic result (0.944 episode success). `cua-s1-nano-0.1` is *not* a
candidate: it scores 0.000 on every hard cross-dataset text family (chance 0.250), is
`n/a` for live agentic use because its per-element scorer "has no goal conditioning and
no `done` option", and is rejected by the upstream chooser. See
[PLAN.md](PLAN.md#4-nano-vs-4b--the-comparison-you-asked-for) for the full comparison.

Requirements when enabled: a `trycua/cua` checkout, `uv sync --extra four-b`, ~9.34 GB
of base weights, and ≥16 GB free memory. Cold load is 10–35 s against a 60 s capture
lifetime, which is why the sidecar stays resident.

## License

MIT. Cua Driver itself is also MIT. The optional `cua-perception` extension's OmniParser
icon detector is **AGPL-3.0-only** and this package does not bundle, install, or ship it —
see [OmniParser](#omniparser--cua-perception). Do not add it to a redistributed package
without reviewing the
[third-party notices](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/perception-third-party-notices.md).
