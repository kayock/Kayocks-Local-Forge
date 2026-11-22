# Feature Completion Matrix

Statuses are honest and specific:

- **Working (verified)** — implemented and exercised automatically or by a real browser session in the build environment.
- **Working (untested on real model)** — logic complete + protocol-tested; needs a live model run (marked where relevant).
- **Protocol-tested** — tested against mock servers that speak the real wire format; real-model behavior pending.
- **Partial** — works but with documented limits.
- **Unimplemented** — designed, not built.

## 1. Core IDE

| Feature | Status | Notes |
| --- | --- | --- |
| Monaco code editor w/ syntax highlighting | ✅ Working (verified) | Self-hosted (`public/monaco`), custom graphite/purple themes |
| Multiple editor tabs | ✅ Working (verified) | Dirty-state dot, Ctrl+S save-to-disk |
| File explorer w/ folder navigation | ✅ Working (verified) | Nested tree, context menu (new/rename/delete), in-project content search |
| AI agent conversation panel | ✅ Working (verified) | Streaming markdown, tool-call cards, approvals inline |
| Model & provider selector | ✅ Working (verified) | Top-bar dropdown, per-provider discovery |
| Integrated terminal | ✅ Working (verified) | Real shell via companion, NDJSON streaming, history, Ctrl+C interrupt, `!confirm` escape hatch |
| Preview panel | ✅ Working (verified) | Static dir server + dev-server proxy; sandboxed iframe; open-in-tab |
| Git integration | ✅ Working (verified) | status/diff/log/init/commit via companion exec |
| Tool-call & execution history | ✅ Working (verified) | Structured log w/ args, output, duration; chat cards |
| Project create/open/save/import | ✅ Working (verified) | Templates (static site w/ real test script; empty), open arbitrary path, recent list, persistence |
| Resizable panels & dark/light themes | ✅ Working (verified) | react-resizable-panels; next-themes; graphite+purple palette |
| Beginner onboarding (no terminal) | ✅ Working (verified) | 3-step pairing gate; companion prints one code |

## 2. Local model connectivity

| Feature | Status | Notes |
| --- | --- | --- |
| Ollama | ✅ Working (verified via protocol mock) | Native `/api/tags` + `/api/chat` (NDJSON) normalized; `num_ctx`/`num_predict` options |
| LM Studio | ✅ Working (verified via protocol mock) | OpenAI-compatible `/v1`; load/unload best-effort `/api/v0` |
| llama.cpp (llama-server) | ✅ Working (verified via protocol mock) | OpenAI-compatible `/v1`; live-model run documented in VERIFICATION.md |
| Lemonade Server | ✅ Protocol-tested | `/api/v1/models` discovery; OpenAI-compatible chat |
| Generic OpenAI-compatible endpoints | ✅ Working (verified via protocol mock) | Optional API key kept in browser only |
| Endpoint entry + discovery | ✅ Working (verified) | Port scan + extra URLs; kind inference |
| Connection testing | ✅ Working (verified) | 1-token round trip w/ latency |
| Context-window config | ✅ Working (verified) | `numCtx` → Ollama `num_ctx`; documented limits for llama.cpp |
| Inference settings | ✅ Working (verified) | temperature / top_p / max tokens per model |
| Meaningful error messages | ✅ Working (verified) | Upstream status bodies surfaced verbatim |
| Tool-capability discovery | ✅ Working (protocol mock) | `probeTools` sends a 1-tool probe → yes/no/weak/unknown |
| Model load/unload | ✅ Working (Ollama verified via protocol mock) | LM Studio best-effort; llama.cpp N/A (server-managed) |
| LAN endpoints | ✅ Partial | Direct URL entry works; zero-config LAN scan is roadmap |

## 3. Coding agents

| Feature | Status | Notes |
| --- | --- | --- |
| Read files / dirs | ✅ Working (verified) | Companion FS w/ path jail |
| Create files & directories | ✅ Working (verified) | Auto-parent mkdir |
| Edit existing code | ✅ Working (verified) | `edit_file` exact-match replace w/ single-match guard; alias args (`old_content`→`find`) normalized; precise validation errors (Phase 1 regression-tested) |
| Search project contents | ✅ Working (verified) | Regex/glob, line numbers |
| Run authorized terminal commands | ✅ Working (verified) | Policy-gated + companion screening; structured output (command, cwd, exit code, duration, stdout, stderr) |
| Install dependencies | ✅ Working (verified via tool) | Lockfile-detects npm/pnpm/yarn/bun/pip |
| Run builds & tests | ✅ Working (verified) | Language-aware discovery: package.json, Cargo.toml, go.mod, Makefile, Python (pytest → unittest fallback) |
| Diagnose failures & revise code | ✅ Working (real model, see VERIFICATION.md §B) | Tool results fed back; rework loop |
| Return verifiable artifacts | ✅ Working (verified) | Files on disk + test exit codes |
| Native tool calling | ✅ Working (protocol mock + regression suite) | OpenAI `tools` param; unified delta accumulation; helper/nudges never injected in native mode (Test C fix) |
| Documented fallback protocol | ✅ Working (verified live — small models emit tool calls as text; parser handles both shapes) | JSON-per-turn text protocol + JSON repair (quotes/keys/fullwidth) + double-encoded args recovery |
| Tool protocol modes native/text/auto | ✅ Working (verified, `tests/harness.test.ts`) | `auto` starts native, falls back once on server rejection, records reason + persists per provider/model profile |
| Argument alias + validation layer | ✅ Working (verified) | Tool-name aliases (bash→run_command, …) + per-param aliases; errors name the exact missing parameter and accepted aliases |
| Detached GUI/background processes | ✅ Working (verified on Linux; Windows code untested on hardware) | `launch_app`/`process_status`/`stop_process` + companion process manager (real pid, lifecycle, tree-kill, output ring buffer) |
| Repetition/loop guard | ✅ Working (verified) | Identical successful calls blocked at 3rd attempt (reads 4th, failing calls after 3 tries) with previous result + strategy hint |
| Configurable turn limits + resumable tasks | ✅ Working (verified) | Settings 5–500 turns; pause preserves full history; "Continue task" resumes losslessly |
| Iterative tool results → model | ✅ Working (verified) | Core loop |
| Workspace authorization | ✅ Working (verified) | One folder authorize → all FS ops jailed |
| Execution policy (no per-change spam) | ✅ Working (verified) | auto / confirm-commands / confirm-all + always-allow patterns |
| Transparent execution logs | ✅ Working (verified) | Companion JSONL (metadata only) + browser tool log + SSE events |
| Explicit auth for destructive/out-of-scope ops | ✅ Working (verified) | `delete_path` requires approval; shell confirm list; hard-deny list |

## 4. Multi-model & orchestration

| Feature | Status | Notes |
| --- | --- | --- |
| Multiple models/endpoints configured | ✅ Working (verified) | Provider list + active selection |
| Planner → coder → tester → reviewer pipeline | ✅ Working (verified live with a real local model in the E2E run) | 4 stages, tool subsets, handoff context |
| Reviewer → coder rework handoff | ✅ Working (runtime) | `VERDICT: REQUEST_CHANGES` triggers rework pass |
| Per-stage model routing | ✅ Working (runtime) | `stageModels` plumbing; simple UI pending (see LIMITATIONS) |
| Task handoffs between agents | ✅ Working (runtime) | Structured context messages |
| Model loading/unloading via provider APIs | ✅ Working (Ollama) | See §2 |
| Tool-capability routing | ◐ Partial | Probe + manual protocol override; auto-routing by capability is roadmap |
| Sequential workflows | ✅ Working | Pipeline |
| Parallel workflows | ⬜ Unimplemented | Architecture supports (see ARCHITECTURE §5) |
| Multiple LAN machines | ◐ Partial | Companion supports non-loopback bind + URL entry; auto-discovery roadmap |
| Research agents (web tools) | ⬜ Unimplemented | Out of scope for this build |

## 5. Companion application

| Feature | Status | Notes |
| --- | --- | --- |
| Discover local inference servers | ✅ Working (verified) | Port probe + kind inference |
| Connect browser ↔ local models | ✅ Working (verified) | Normalized streaming proxy |
| Authorized project access | ✅ Working (verified) | Path jail + realpath symlink guard |
| Execute coding tools | ✅ Working (verified) | FS + shell + search |
| Run builds/tests | ✅ Working (verified) | Streaming + batch |
| Terminal session management | ✅ Working (verified) | Streaming sessions, interrupts, timeouts; full PTY (node-pty) is roadmap |
| Detached process manager | ✅ Working (verified on Linux; Windows code untested on hardware) | `/proc/start` returns immediately; output ring buffer; real exit codes via marker; tree-kill (taskkill on Win) |
| Real-time execution updates | ✅ Working (verified) | SSE events + streamed NDJSON |
| Secure pairing | ✅ Working (verified) | Code → token, rate-limited, timing-safe |
| Windows support | ✅ Compatible (code paths present, untested in CI) | cmd.exe wrapper + marker parsing; needs a Windows test pass |
| macOS | ◐ Compatible by design | bash wrapper is POSIX; packaging/signing not done |
| Beginner onboarding | ✅ Working (verified) | Banner + pairing code; no config files needed |
| No public unrestricted command execution | ✅ By design | Loopback bind default; token auth; confirm list; hard deny |

## 6. Subscription business architecture

| Feature | Status | Notes |
| --- | --- | --- |
| Registration/login/logout | ✅ Working (verified) | scrypt hashes, opaque tokens, httpOnly cookies |
| Customer dashboard | ✅ Working (verified) | Usage summary, projects, subscription card |
| Subscription tiers UI | ✅ Working (verified) | Free/Pro/Team catalog |
| Stripe integration | ◐ Scaffolded (inert) | Checkout + signed webhook + tier sync code paths; gated by `SUBSCRIPTIONS_ENABLED` — **no live payments in prototype** |
| Subscription status & billing mgmt | ◐ Partial | Status + webhook sync implemented; customer portal link pending |
| User settings & preferences | ✅ Working (verified) | Providers, policy, theme, companion transport |
| Project metadata persistence | ✅ Working (verified) | localStorage + hosted sync (metadata only) |
| Usage analytics (hosted services) | ✅ Working (verified) | `agent_run`/`project_open` events + dashboard summary |
| Account & team management | ◐ Partial | Schema + auth done; team UI unimplemented |
| Separation of billing from inference | ✅ By design | No inference metering exists anywhere in the codebase |

## 7. Privacy

| Requirement | Status |
| --- | --- |
| Local project files stay local | ✅ Companion-only access; hosted DB has no file content columns |
| Prompts stay local | ✅ Chat goes browser → companion → local model |
| Clear distinction local/browser/hosted storage | ✅ Documented in README + ARCHITECTURE; no upload code paths exist |
| Explicit opt-in upload feature | ⬜ Unimplemented (by design — spec says only build when explicitly enabled) |

## 8. Engineering

| Requirement | Status |
| --- | --- |
| Open-source components, no reinvention | ✅ Next.js, Monaco, xterm, zustand, Prisma, shadcn/ui, react-resizable-panels |
| Modular frontend/backend + defined APIs | ✅ docs/API_CONTRACTS.md |
| Persistent project & account data | ✅ state.json (companion), SQLite (hosted), localStorage (browser) |
| Streaming model responses | ✅ NDJSON end-to-end (verified in browser + E2E) |
| WebSocket or equivalent real-time | ✅ NDJSON streaming + SSE events (+ optional raw WS channel in companion) |
| Error handling & recovery | ✅ Tool errors → model; needs-confirm retry path; UI toasts; abort/stop |
| Automated tests | ✅ companion (node:test, black-box incl. streaming + security) |
| Structured execution logging | ✅ JSONL companion logs (metadata only) |
| Repository-ready source | ✅ This repo |
| Environment configuration | ✅ `.env.example` (root + companion) |
| Install instructions | ✅ README + docs/DEPLOYMENT.md |
| Companion packaging strategy | ✅ npm bin now; standalone-binary strategy documented |
| Deployment documentation | ✅ docs/DEPLOYMENT.md |
| License compatibility | ✅ docs/LICENSES.md — MIT/Apache-2.0 family, commercial-OK |
| Portable & exportable | ✅ No platform-specific lock-in; SQLite → Postgres path documented |

## 8. Forge Control & agent reliability (Phase Two, 2026-11-16)

Statuses follow the same honest scheme as above.

| Feature | Status | Notes |
| --- | --- | --- |
| Empty-vs-missing workspace inspection | ✅ Working (verified: real companion integration + real fsapi) | `/stat` endpoint + `list_dir` rewrite; MISSING ≠ EMPTY, parent-exists reported |
| Canonical workspace identity | ✅ Working (verified) | `workspace_info` tool + `workspaceMeta` (absolute root from companion realpath, machine label, platform) in every tool result |
| Archive extraction w/ nested-root detection | ✅ Working (verified: unit + integration + live drills) | zip/tar/tgz, explicit flatten, zip-slip jail, skip-don't-overwrite |
| Coordinator repetition journal + recovery envelopes | ✅ Working (verified) | outcome classes, workspace version, real-result quoting, `[COORDINATOR RECOVERY]` messages, `stall_detected` events |
| User steering during runs | ✅ Working (verified) | `steer()` queue applied at the next turn boundary; UI input stays enabled while running |
| Persistent task contracts | ✅ Working (verified) | verbatim request, append-only requirements, progress/evidence/steering/proposals; survives restarts (localStorage) |
| Evidence-gated completion (5 statuses) | ✅ Working (verified) | finish refused without evidence; bounded refusals; honest final verdict; user override recorded without touching evidence |
| Model handoff packets | ✅ Working (verified) | verbatim requirements + verified state on model switch / stall escalation |
| Learned tool-call dialects (json/tagged/py) | ✅ Working (protocol mock) | per-model ledger; live-model validation pending (needs real hardware models) |
| Tool reliability drills + evidence files | ✅ Working (verified 10/10 on live companion; mock suites) | `scripts/run-drills.ts`, one JSON per pass, never overwrites |
| Projects Hub | ✅ Working (verified: builds + stores; UI flow needs a paired browser session) | create/open/switch/resume; workspaces referenced, never duplicated |
| Fleet Map | ✅ Working (verified: health resources + states; multi-machine needs the owner's hosts) | honest state ladder, static SVG, manual refresh |
| Live Runs timelines | ✅ Working (verified) | persisted operation timelines, failure inspection, steer/stop/continue |
| Shared browser verification (CDP) | ⚠️ Working (untested on real model/browser) | companion CDP driver + 4 tools; honest UNVERIFIED path integration-tested; happy path mock-tested — live Chrome validation on owner hardware pending |
| Stall escalation to another model | ✅ Working (protocol mock) | opt-in (`autoEscalate`), handoff packet preserves the assignment |
