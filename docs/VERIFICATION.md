# Verification Procedures

This document defines what "working" means for LocalForge and how it is
verified. Automated results from the build environment are recorded at the
bottom; they are re-runnable with one command each.

## A. Automated: companion tests (real processes, no mocks for exec)

Two suites in `companion/test/` (node:test):

- `companion.test.mjs` — command screening (hard-deny `rm -rf /`/`mkfs`, `sudo` needs confirm), **real exit-code propagation** (`node -e "process.exit(3)"` → 3), stderr capture, `__LF_EOF` marker stripping, timeout reporting with whole-tree termination, and the **detached process manager**: `startProc` returns in <2 s while the child keeps running, output is captured, `stopProc` kills the whole tree (verified with `kill(pid, 0)`), quick-exiting processes record their **real** exit code (5), and unknown ids return null.
- `server.integration.test.mjs` — boots the **real HTTP server** on an ephemeral port: health, pairing from the persisted state file, workspace registration, tree, exec exit code + stderr end-to-end, detached start/output/list/stop over HTTP, and 401 on unauthenticated API calls.

```bash
cd companion && npm test    # node --test test/companion.test.mjs test/server.integration.test.mjs
```

**Result (build environment, Linux):** **13/13 pass** (9 + 4), 2026-11-14.

## B. Automated: agent harness + protocol tests (Phase One regression suite)

- `tests/harness.test.ts` (24 tests) — regression coverage for every defect observed in real-world model testing (see `docs/HARNESS_UPGRADE.md` §1): `edit_file` alias normalization (`old_content/new_content` → `find/replace`) and precise validation errors (no more "missing path or find"); invented tool names (`bash`, `str_replace_editor`, `cat`) resolve to registry tools; malformed JSON repair (single quotes, trailing commas, double-encoded args); unknown-tool errors with the full registry list; native mode executing preserved tool-call ids with **no helper nudges** (plain-text answers accepted as final); `auto` falling back once on a server tool rejection with a recorded `mode_change` reason; native-forced mode **refusing** silent downgrade; structured `run_command` output with real exit codes (a traceback is an error, never `exit code: 0`); timeout reporting redirecting GUI launches to `launch_app`; `launch_app`/`process_status`/`stop_process` lifecycle; language-aware test discovery (pytest → unittest fallback, package.json, informative undetected-project error); repetition guard blocking the 3rd identical successful call with the previous result + strategy hint; configurable turn limit preserving the full history; **resume** replaying preserved context so the model sees prior `[TOOL RESULT]`s.
- `tests/protocol.test.ts` (12 tests) — fallback parser shapes, thinking-block stripping, legacy `{name, arguments}`, nudge contract.

```bash
bun test tests/             # 36/36 pass
```

**Result (build environment):** **36/36 pass**, 2026-11-14. TypeScript (`bunx tsc --noEmit`) clean.

## C. Automated: LIVE end-to-end proof-of-function

`e2e/live-e2e.ts` drives the **real agent runtime** against a **real local
model server** through the **real companion**. It performs the ten required
proof points and writes `e2e-report.json` (checks, every tool call, durations).
It refuses to fake success: with no model endpoint it exits `UNVERIFIED`.

```bash
# 1. start a real local model server (any one):
llama-server -m qwen2.5-coder-1.5b-instruct-q4_k_m.gguf -c 8192 --port 8080
#    …or Ollama: ollama serve   …or LM Studio → local server

# 2. run the proof (auto-discovers the endpoint):
bun run test:e2e
```

### Latest run (build environment)

| Field | Value |
| --- | --- |
| Date | 2026-11-14 — evidence: `docs/evidence/e2e-report.json`, `docs/evidence/e2e-run.log`, `docs/evidence/e2e-workspace/` |
| Model | Qwen3-1.7B-Instruct Q4_K_M via llama.cpp `llama-server` (build b12374), CPU, 2 threads, `--jinja` (native tool calls) |
| Companion | spawned fresh by the runner, temp home, temp workspace |
| Test harness | `package.json` + `test.js` (13 assertions) are **pre-seeded by the runner as a customer-provided suite**; the agent authored `index.html`, `styles.css`, `app.js`. The harness files are protected by `protectedPaths` so the agent cannot modify them. |

| # | Proof point | Result |
| --- | --- | --- |
| 1 | Real local model endpoint connected | ✅ (auto-discovered llama.cpp :8080, connection test 368 ms) |
| 2 | Actual project folder opened | ✅ (tmp workspace registered) |
| 3 | Agent asked to create a web app | ✅ (planner → coder → tester → reviewer pipeline, 9 model turns) |
| 4 | Real source files generated | ✅ (index.html 295B, styles.css 263B, app.js 263B — verified on disk) |
| 5 | Files saved to authorized workspace | ✅ (5 entries; harness files intact) |
| 6 | Actual build/test executed | ✅ (`npm test` exit 0 — all 13 assertions ok) |
| 7 | App served in preview | ✅ (HTTP 200 with expected content) |
| 8 | Deliberate error found & corrected | ✅ (`addTodo` → `addTodoBroken` injected; suite failed; the tester agent ran the tests, read the failure, rewrote `app.js`, re-ran: exit 0) |
| 9 | Tool calls & results displayed | ✅ (every call with args + output recorded in `e2e-report.json`) |
| 10 | Project preserved after reopen | ✅ (companion killed & restarted with same home; pairing token + workspace persisted from `state.json`; files intact) |

**Result: PASS — verified with a real local model.** The report JSON is the
source of truth and includes every tool call with arguments and outputs.

> Model-size note: a 1.7B model needs the runner's guardrails (text-protocol
> fallback for models that answer in prose, one-nudge continuation, parallel-
> call caps, history compaction for small context windows, `protectedPaths`)
> — all of which are product features, documented in ARCHITECTURE.md. Larger
> local models (≥7B) are strictly easier; the procedure is identical.

## D. Manual: browser session (performed in the build environment — all steps verified with agent-browser)

Screenshots: `docs/evidence/screenshots/`.

1. Open the IDE → landing page renders (graphite/purple, dark default).
2. **Launch IDE** → pairing gate appears with 3 steps.
3. Start companion locally → paste pairing code → "Companion paired".
4. Open folder → workspace loads; explorer shows the tree.
5. Settings → Discover → local model server appears with its models.
6. Select model → agent panel shows it in the header.
7. Type a task in Agent mode → tokens stream; tool cards appear per action;
   tool log lists every execution with args/output/duration.
8. Terminal panel: run `ls`, `npm test`; Ctrl+C interrupts a long command.
9. Preview panel: refresh serves the created app in the iframe.
10. Reload the browser (F5) → same workspace restores (persisted state).
11. Toggle light theme → editor + panels adapt.
12. Register/login via `/auth` → dashboard shows account, tiers
    ("billing disabled" notice), project metadata, usage counts.

## E. Manual: security spot checks

1. `GET /api/workspaces` without token → 401.
2. Tree/file request with `path=../../etc/passwd` → 400 (path escapes workspace).
3. Symlink pointing outside the workspace → rejected (realpath guard).
4. `sudo rm -rf /` from terminal without confirm → blocked with explanation;
   `!confirm sudo ls` after reading → runs (explicit user action).
5. Companion console is the only place the pairing code is printed.
6. Hosted backend DB contains no file contents or prompts (inspect
   `prisma/db/custom.db` — only metadata rows exist).

## F. What is explicitly NOT yet verified

- Windows/macOS companion execution (code paths present; see FEATURE_MATRIX).
- Browser-in-browser pipeline run with a large model (the pipeline runtime is
  the same code verified in §C via the agent runtime).
- Stripe live payments (intentionally disabled — see docs/DEPLOYMENT.md).
