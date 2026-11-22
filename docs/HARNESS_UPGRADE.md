# Harness Upgrade — Phase One (Agent Tool Harness Repair)

Date: 2026-11-14. Scope: Priority A of the engineering upgrade directive —
repair the agent tool harness before any orchestration expansion. Every
change maps to a defect observed in real-world testing against local models
(Qwen3.5-4B and Qwen3-Coder-30B-A3B served by FOXAI/llama.cpp on Windows 11).

---

## 1. Field-test findings → what was fixed

| # | Observed in testing | Root cause in code | Fix |
|---|---|---|---|
| 1 | Test A: model sent `edit_file` with `path`, `old_content`, `new_content`; harness replied `Error: missing path or find` and the model never recovered | `edit_file` accepted only `find`/`replace`; no alias layer; error message did not say which parameter was missing | `normalizeToolArgs()` in `src/lib/agent/tools.ts` renames aliases before execution (`old_content/old_text/old_string/old/search/original → find`, `new_content/new_text/new_string/new/replacement/updated → replace`, `cmd/shell/… → command`, `file/filepath/… → path`, plus per-tool maps). Validation errors name the exact missing parameter, what was received, and the accepted aliases. Regression: `tests/harness.test.ts` Test A block |
| 2 | Test B: malformed JSON tool requests, legacy call shapes, tool names invented by the model | Parser only tolerated trailing commas; unknown tool names returned a generic error | `repairJson()` repairs trailing commas, single-quoted JSON, unquoted keys, fullwidth/smart punctuation; `args` delivered as a JSON *string* (double-encoded) is recovered; `{"name","arguments"}` and OpenAI `{"function":{…}}` shapes accepted; invented names map through `TOOL_ALIASES` (`bash→run_command`, `str_replace_editor→edit_file`, `cat→read_file`, …); unknown names get the full registry list plus a repair instruction |
| 3 | Test C: with the tool-call helper enabled, a model with solid native tool calling degraded into protocol churn; with the helper disabled it immediately used native tools and repaired a real application | The text-protocol nudge was injected regardless of mode (`allowNudgeOnText` honored even in native mode) | Three explicit modes (see §2). The helper (nudges + text-protocol instructions) engages **only** in `text` mode or in `auto` mode after a genuine server-side fallback — never in `native` mode. Regression: native-mode block in `tests/harness.test.ts` |
| 4 | Test D Problem 1: a launch printed a genuine Python traceback while the tool reported `exit code: 0` | Launch-and-crash sequence: the wrapper returned before/while the child failed, and detached children were never tracked | Blocking `run_command` output now always carries the actual command, cwd, exit code, duration, stdout and stderr, and `isError` is derived from the real exit code (or timeout). GUI/long-running launches go through the new process manager which records the real outcome (§4). Regression: command-accuracy block |
| 5 | Test D Problem 2: `python taskforge_gui.py` held the agent ~1,164 s and ended in `exit code: null (TIMED OUT)` although the GUI was running fine | `run_command` waits for process exit; GUIs never exit; Windows tree-kill only killed the wrapper shell | New `launch_app` tool + companion process manager: starts detached, returns id+pid immediately, tracks running/exited/stopped/failed with output ring buffer; `stop_process` kills the whole tree (`taskkill /pid X /T /F` on Windows, process group SIGKILL on POSIX). Timeouts on `run_command` now also tree-kill correctly and point the model to `launch_app`. Regression: detached-process block + `companion/test/companion.test.mjs` |
| 6 | Test D Problem 3: `run_tests` on a Python project said "Add a test script to package.json" | Discovery only looked at `package.json` | Language-aware discovery: package.json `test` script → `npm test`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./…`; `Makefile` → `make`; Python markers (`pytest.ini`, `pyproject.toml`, `conftest.py`, `tests/`) → `python -m pytest -q` with automatic fallback to `python -m unittest discover -v` when pytest is not installed. Undetectable projects get an informative summary of everything checked. Regression: test-discovery block |
| 7 | Test D Problem 4: the agent repeatedly ran identical import checks despite earlier success | No repetition tracking | Repetition guard in the runner: identical calls (tool + args, key-order independent) are counted; successful commands/edits/writes are blocked from the 3rd identical execution, read-only calls from the 4th, identical *failing* calls after 3 attempts. Blocked calls return the previous result plus `[REPEATED CALL — not executed]` and a concrete strategy hint, and a `loop_detected` event is emitted. Legitimate lengthy operations are never stopped. Regression: repetition-guard block |
| 8 | Test D Problem 5: `Stopped after 40 turns.` lost all progress | Hard limit with no resume | `maxTurns` is user-configurable (Settings → Agent, 5–500). At the limit the run *pauses*: `hitTurnLimit` is reported, the full internal message history is preserved in the session, and the IDE shows a **Continue task** button that resumes with complete context (conversation, tool results, modified files). Regression: turn-limit/resume block |
| 9 | Test D Problem 6: visual defects (blank button labels, inconsistent styling) invisible to unit tests | No visual verification path in Phase One | Requires browser/desktop control + vision agents (Phase 7–8). The harness groundwork is in place: detached processes + per-process output tracking + real screenshots-ready process lifecycle. **NOT IMPLEMENTED in this phase** — see §6. |

## 2. Tool protocol modes (replaces the old two-value toggle)

| Mode | Behavior | Recorded why |
|---|---|---|
| `native` | Genuine provider function calling only. No text-protocol instructions, no nudges. If the server/model rejects tools, the run reports it instead of silently downgrading. | — |
| `text` | JSON-per-turn text protocol for models without reliable native calling. | — |
| `auto` (default) | Starts native; on a server tool rejection falls back to text **once**, emitting a `mode_change` event with the exact server error, and **persists the decision per provider+model profile** (`settings.modelProtocols`). A functioning native protocol is never silently replaced. | `mode_change.reason` + settings record |

Migration: persisted `toolProtocol: 'auto-native'` → `auto`, `'force-text'` →
`text` (`normalizeProtocolMode()`). The Settings UI now offers the three modes
explicitly plus a configurable agent turn limit.

## 3. Tool contract changes (one authoritative registry, `src/lib/agent/tools.ts`)

- `edit_file`: `path` (aliases: file, filepath, file_path, filename, target), `find` (aliases: old_content, old_text, old_string, old, search, original, needle, target_text), `replace` (aliases: new_content, new_text, new_string, new, replacement, updated, replace_with), optional `replaceAll`.
- `run_command`: output now structured — command, cwd, `exit code: N`, duration, stdout, stderr; timeout note redirects GUI launches to `launch_app`.
- New: `launch_app {command, cwd?}`, `process_status {id?}`, `stop_process {id}` — backed by companion endpoints `POST /api/ws/:id/proc/start`, `GET /api/ws/:id/proc/list`, `GET /api/ws/:id/proc/output?id&since`, `POST /api/ws/:id/proc/stop`. Older companions degrade with a clear "update the companion" message instead of failing silently.
- `run_tests` / `run_build`: language-aware discovery (see table row 6); explicit command parameter still wins.
- Tool-name aliases accepted everywhere (`bash`, `shell`, `cat`, `mkdir`, `grep`, `test`, `done`, …).
- Validation is performed **before** approval prompts: schema violations cost no user interaction and return actionable errors.

## 4. Companion process manager (`companion/src/procs.js`)

- `startProc`: spawns the shell wrapper detached (`windowsHide` on Windows; own process group on POSIX), pipes output into a 256 KB tail buffer, records pid/startedAt.
- Real exit codes: the wrapper's `__LF_EOF` marker (same protocol as blocking exec) carries the child's exit code; the marker is parsed on close and stripped from stored output.
- `stopProc`: whole-tree kill — `taskkill /pid X /T /F` on Windows (fixes the old `child.kill()` that left python/GUI children alive), `kill(-pid, SIGKILL)` on POSIX.
- History: last 100 finished processes stay queryable for accurate termination reports; a window being closed is a normal outcome, not a failure.
- Companion shutdown deliberately leaves detached processes running (they are detached by design); blocking terminal sessions are still cleaned up.

## 5. Verification evidence (this environment, Linux)

All commands run in the sandbox; output captured in the session log.

- `bun test tests/` → **36/36 pass** (`tests/protocol.test.ts` 12 + `tests/harness.test.ts` 24).
- `node --test test/` in `companion/` → **13/13 pass** (9 unit + 4 integration). The integration suite boots the real companion HTTP server on a random port, pairs, opens a workspace, then proves: real exit codes via exec (`process.exit(3)` → `exitCode 3`, stderr preserved), detached start returning in <2 s with live output capture, stop killing the whole tree (verified via `kill(pid, 0)`), and 401 on unauthenticated API calls.
- `bunx tsc --noEmit` → clean. ESLint on changed files → clean.
- Windows artifacts rebuilt with the new companion: `localforge-companion.exe` (bun 1.3.14, `--target=bun-windows-x64`), `LocalForgeTray.exe` (zig cc, GUI subsystem), `LocalForge-Companion-Setup-0.1.0.exe` (NSIS 3.13). `scripts/verify-windows-release.py` → **7/7 checks passed** (PE structure, NSIS signature, sizes, SHA-256 sidecar, website serves byte-exact bytes).
- New SHA-256: installer `12a401f6…`, companion `53bb3c83…`, tray `91c07851…` (recorded in `download/windows/SHA256SUMS.txt`).

## 6. Explicitly NOT done in this phase (tracked for later priorities)

- Browser automation, desktop control, screenshot capture and vision agents (Phases 7–8) — the process manager and structured exec results are the foundation.
- LAN multi-machine orchestration, Model Manager, tool library (Phases 4–6).
- Guided setup + benchmarks (Phase 10) and the Image Studio (Phase 9).
- Real-machine validation of the rebuilt Windows artifacts (install, pairing, FOXAI endpoint, native tool calling with Qwen3-Coder-30B) — the artifacts are verified structurally here; functional testing on the owner's hardware is listed in `docs/WINDOWS_INSTALL.md` follow-ups and the completion matrix.

## 7. Compatibility notes

- No schema/data migrations: user accounts, projects, settings, pairing tokens and workspaces are untouched. The settings store keeps its `localforge-settings-v1` key; legacy protocol values are remapped on read.
- The IDE tolerates an OLD companion (process tools degrade gracefully); the NEW companion remains fully backward-compatible for every pre-existing endpoint.
- FOXAI/llama.cpp connectivity is unchanged: discovery, chat proxy, tool-call delta normalization and model load/unload code paths were not modified in this phase.

---

# Phase Two — Forge Control & Agent Reliability Upgrade

Date: 2026-11-16. Scope: the five coordinator problems (A–E) from the
calculator field test, plus the Forge Control capabilities (Parts 2–6 of the
engineering directive): model-aware tooling, Projects Hub, Fleet Map, Live
Runs and shared browser verification. Adapted components are labeled in-file
with their sources (ALS — Apache-2.0).

## 1. Problem → fix map

| Problem | Observed failure | Fix (files) |
|---|---|---|
| A — repeated tool-call loops | The agent called `list_dir("calculator repo")` on a missing directory despite duplicate-call warnings; the guard blocked re-execution but nothing changed strategy | Coordinator tool journal (`src/lib/agent/runner.ts`): identical-call signatures tracked with outcome class (ok-empty / ok-nonempty / error) and a workspace version; blocks now carry the REAL previous result + concrete alternatives; after repeated blocks a `[COORDINATOR RECOVERY]` envelope is injected as a coordinator message (`stall_detected` event); user steering queue applied at the next turn boundary (`steer()` → `[USER STEERING]` message); escalation to a configured replacement model with the original assignment preserved |
| B — workspace confusion | `list_dir` of a nonexistent path and of an empty dir both returned "success (empty)"; archives were extracted into `calculator repo/calculator repo/` with no notice | Companion `GET /api/ws/:id/stat` (exists / type / empty / entryCount / parentExists — `companion/src/fsapi.js`), `list_dir` rewritten to stat first and answer MISSING vs EMPTY distinctly; `workspace_info` tool reports the canonical absolute root, machine and platform; `POST /api/ws/:id/extract` — zip (store+deflate) / tar / tar.gz reader with nested-root DETECTION (report always, flatten only on explicit `flatten:true`), zip-slip jail, skip-don't-overwrite (`extract_archive` tool + client methods) |
| C — losing the assignment | The "graphical scientific calculator with number base converter" degraded into a four-operation CLI script; nothing carried requirements across turns/models | `src/lib/agent/task-contract.ts` — coordinator-owned TaskContract: verbatim original request, append-only requirements (models add progress + PROPOSE changes; only the user waives), acceptance criteria, progress, evidence, steering, proposals; serialized per project (localStorage, survives restarts); `contractPromptBlock` re-injected verbatim into every run's system prompt (runner prepends it unless the caller already did) |
| D — false completion | The agent "verified" only CLI arithmetic and declared the GUI task done; exit code 0 masked a launch-and-crash | `src/lib/agent/completion.ts` — evidence-gated completion with statuses COMPLETE / PARTIAL / BLOCKED / FAILED / UNVERIFIED; `finish` passes through the gate (files must exist on disk, verification commands must have run and passed, GUI/browser scope needs real browser evidence); refused finishes feed the missing evidence back (bounded: 2 refusals, then an honest verdict is recorded — never COMPLETE); user override is recorded WITHOUT touching evidence records |
| E — model switching | Switching models mid-task lost the assignment and prior progress | `buildHandoffPacket(contract, state)` — structured handoff (verbatim request + requirements + steering + verified files/tests/blockers/remaining work) injected when continuing after a model switch; pipeline stall escalation reuses the same packet; the contract itself persists independently of any model |

## 2. Forge Control (Parts 2–6)

- **Part 2 — model-aware tool harness**: `src/lib/agent/dialects.ts` —
  tool-call dialect ladder (json → tagged `<tool_call>` → pythonic
  `tool(args)`), per-model learned-dialect ledger in settings
  (`modelDialects`), conversational prose never executed as a tool call;
  structured execution feedback on every tool log entry (`machine`, `cwd`,
  `exitCode`, `fsChanged`, outcome); `src/lib/agent/drills.ts` +
  `scripts/run-drills.ts` — eight tool-reliability drills (listing incl.
  empty-vs-missing, reading, creation, modification, command execution, error
  recognition, recovery, multi-step) with one evidence JSON per pass.
- **Part 3 — Projects Hub**: `src/lib/store/projects.ts` +
  `src/components/forge/ForgeView.tsx` (Projects tab) — create/open/switch/
  resume projects bound to host + directory, participating models, contract,
  run history; workspaces are referenced, never duplicated.
- **Part 4 — Fleet Map**: `src/lib/store/fleet.ts` + Fleet tab — machines
  (Station / Portable / Windows Dell / any paired host) with honest states
  unreachable → discovered → paired → inference-ready, resources from the
  extended `/health`, lightweight static SVG, manual/event-driven refresh
  (no polling loops, no continuous animation).
- **Part 5 — Live Runs**: `src/lib/store/runs.ts` (persisted operation
  timelines) + Runs tab — every tool call, notice, error, recovery, gate
  verdict, handoff and approval with expandable output; failure inspection;
  steer / stop / continue controls for the active run.
- **Part 6 — shared browser**: `companion/src/browser.js` — CDP driver over
  the user's own Chrome/Edge/Chromium (visible or headless), one shared
  session per workspace; tools `browser_open` / `browser_verify` /
  `browser_eval` / `browser_close`; structured evidence (checks, console
  errors, screenshot into the workspace). When no browser exists the result
  is `BROWSER UNAVAILABLE` and verification MUST be recorded UNVERIFIED — a
  fake pass is impossible by construction.

## 3. Regression tests (Part 7) and verification results

- `tests/forge.test.ts` (18 tests): Tests 1–7 of the directive — repeated
  listing → recovery envelope + steering applied + termination; nested
  workspace → real-fsapi extraction/flattening/zip-slip + empty-vs-missing;
  handoff → replacement model receives the verbatim request and progress;
  false completion → gate refuses, honest verdict recorded; interrupted run →
  resume keeps requirements/progress/workspace intact; browser evidence →
  real evidence or honest UNVERIFIED; multi-machine attribution (MOCKED —
  the real multi-machine flow needs the owner's actual hosts). Plus dialect
  ladder, drills (mock host incl. a host that lies about failing commands)
  and completion-gate units.
- `companion/test/` (recreated; 14 tests): unit (path jail, stat, extraction,
  zip-slip, tar.gz, command screening) + REAL server integration (boot →
  pair → workspace → file I/O → stat → extract → exec truthfulness → browser
  honesty → health resources).
- Results in this sandbox: `bun test tests/` → **54/54 pass**; `npm test` in
  `companion/` → **14/14 pass**; `bunx tsc --noEmit` → clean; `bun run build`
  → production build OK.
- **Real-hardware drill evidence**: the companion was booted live in the
  sandbox and the drills executed against it via `scripts/run-drills.ts` →
  **10/10 drills passed**, evidence at `download/drill-evidence/drill-2026-11-16T08-52-18-864Z.json`.
- Browser verification on real GUI apps requires a real browser on the user's
  machine (none exists in the build sandbox by design): the honest-unavailable
  path is integration-tested; the CDP happy path is unit-mocked and flagged
  for live validation on the owner's hardware (Test 6 real-browser pass).

## 4. Compatibility notes

- The IDE degrades gracefully against an OLD companion: stat/extract/browser
  tools return explicit "not supported by this companion / UNVERIFIED"
  messages instead of guessing. The new companion is fully backward-compatible.
- Settings store keeps `localforge-settings-v1`; new fields
  (`modelDialects`, `autoEscalate`, `machineLabel`) are additive.
- No hosted-platform schema changes; contracts/runs/projects/fleet live in
  browser localStorage (privacy-first default, same as sessions).
