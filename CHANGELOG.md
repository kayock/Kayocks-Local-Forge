# Changelog

## v0.5.0 — integration & repair pass (v0.5-dev, 2026-11-22)

Fixed from the final review:
- Windows PTY packaging: sidecar loader in companion/src/pty.js — the runtime
  imports prebuilt node-pty from <exe-dir>/pty-sidecar/node-pty (bundled by
  installer/windows/build-windows.sh). Loader VERIFIED on Linux (backend
  reports node-pty-sidecar with node_modules emptied); Windows verification
  requires a Windows runner (UNVERIFIED there).
- FanoutRunner connected to production: runDistributedFanout() in
  collab-service (planner decomposition → parallel execution across the
  participant machines via the mesh), exposed as the "Parallel fan-out
  (distributed)" mode in the Forge Control Center; Center re-mounted at
  #/control with a TopBar entry.
- Mesh proxy: route regex widened, health+chat proxied (routed IDE client
  needs both) — fixes 401/404/"route not available" for cross-machine traffic.
- Test repairs (129/133 pass, was 81/17-fail of 100): missing companion
  fixture stub-model-server.mjs created (spec'd by collab suites); missing
  toolcalls.js module implemented; provider-settings tests rewritten to the
  v0.5.0 settings API; auto-steering delivery order + rate limit fixed;
  recovery stall-stop redesigned (activity backstop, progress-by-tool,
  send-once envelopes); append_file tool added with aliases.
- UI: DiagnosticsPanel mounted in the IDE bottom dock (new tab);
  ControlCenter reachable from the IDE header.
- Next.js production build verified (npm run build → success).

## v0.5.0 (development branch v0.5-dev)

Milestone 1 — Real PTY terminal and reliable file operations
- Real interactive terminal via optional node-pty: persistent shell sessions (cd/env/state survive), full ANSI, resize, Ctrl+C/Ctrl+Z as tty bytes, multi-session UI, scrollback replay on reconnect; NDJSON streaming shell preserved as the documented fallback (e.g. compiled binary without native modules).
- Unified diff previews before file writes + concise post-edit diffs; overwrite protection via ifUnmodifiedSince (409 + current content on concurrent modification); workspace revision notes in FS-write tool results; complete command-output ring log (/exec/log); structured tool results (changed files, exit status).

Milestone 2 — Automatic LAN discovery and multi-machine orchestration
- mDNS/Bonjour advertisement + browsing (bonjour-service, optional dep): identifying TXT only; never auto-pairs; --no-mdns flag; manual IP entry unchanged.
- Durable cross-machine task packets: ack/progress/complete/fail/cancel, dedupKey idempotency, machine-disconnect hook; workspace write reservations (owner-refresh, TTL); mesh proxy now carries the full workspace tool surface with enforcement at the destination companion.
- IDE FanoutRunner: dependency waves, bounded parallel fan-out across machines, failure reassignment with preserved handoff, revision conflict notes, explicit cancellation; Fleet Map LAN discovery panel + fleet task list.

Milestone 3 — Persistent local project memory
- Per-workspace SQLite (node:sqlite — no native packaging) + FTS5 keyword search; JSON-store fallback for old runtimes; content-hash dedup so concurrent same-fact writes merge; kinds/tags/refs/pin; optional LOCAL-only embedding hybrid (never required); incremental workspace file indexing with path+content secret exclusion; export/import backup; restart persistence verified.
- Agent memory tools: memory_search / memory_read / memory_write / notebook_append / notebook_search / read_scratchpad / write_scratchpad; Forge Control Memory tab (inspect/search/edit/pin/delete/reindex/export/import).

Milestone 4 — Intelligent multi-agent harness and recovery
- Outcome-aware recovery: two-step ladder (workspace_refocus → strategy_directive quoting requirements verbatim) then honest STALLED stop; stall classes repetition/progress/verification from tool evidence; canonical journal signatures; truncated tool-call args refused with truncated-edit auto-steering; validation-failure streaks escalate; activity-stall backstop; contract progress records real file writes.
- Agent-recovery regression suite: 7 of 11 previously-failing baseline tests now pass (A, B×2, C, D, E, F); 2 auto-steering edge tests remain (see final report).

Milestone 5 — Forge Control, diagnostics, usability
- Live Runs timeline events for recovery_action / stalled; Fleet Map discovery + fleet tasks; Memory tab; PTY terminal sessions in the IDE.

Milestone 6 — Packaging, CI, release readiness
- Companion test script covers all 57 tests (baseline 32 + M1 8 + M2 8 + M3 9); IDE suites extended (m1-diff, m2-fanout, m3-memory-tools); version 0.5.0; CI workflows unchanged (build-validation.yml, controlplane.yml) — Windows/macOS real-machine verification remains UNVERIFIED in this environment.
