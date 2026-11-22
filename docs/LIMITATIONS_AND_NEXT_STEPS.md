# Technical Limitations & Next Steps

Honest inventory of what this build does not do, and what to do next.

## Limitations (current build)

### Companion / execution
1. **No real PTY.** The terminal streams a spawned shell per command with
   client-side line editing (history, Ctrl+C, cwd tracking). Full TTY apps
   (`vim`, `htop`, `watch`) and raw interactive REPLs are out of scope until
   node-pty (native module) is bundled. Most agent and build workflows do not
   need a TTY.
2. **Shell-session state.** `cd` persists (companion tracks cwd); `export`
   does not persist across commands (use `export X=1 && cmd` in one line).
3. **Command screening is heuristic.** Deny/confirm lists are regex-based
   defense-in-depth for accidents, not a security sandbox against a malicious
   actor who already owns the machine. Process-level sandboxing (per-workspace
   users, containers, seccomp profiles) is the correct long-term answer.
4. **Windows/macOS untested in CI.** Windows code paths (cmd.exe wrapper,
   marker parsing) are implemented but need a real Windows test pass; macOS
   works by design (bash ships with the OS) but is unsigned.
5. **LAN discovery is manual.** LAN endpoints work by URL entry, but automatic
   mDNS/Bonjour discovery of companions on the LAN is not built.
6. **Preview proxy is HTTP-only.** Dev-server HMR websockets are not proxied
   (static preview and full page reload work fine).

### Agent runtime
7. **Small models need supervision.** The pipeline and fallback protocol are
   tuned to keep ≤1.5B models on task (short JSON actions, explicit
   verification loops), but tiny models can loop or under-plan. Recommend ≥7B
   coder models for serious work; the runner stops at turn limits and reports
   honestly.
8. **Per-stage model routing UI is minimal.** `stageModels` is wired
   end-to-end at runtime but the Settings UI exposes only the global model;
   per-stage pickers are a small TODO.
9. **Tool results are text-only** (capped ~30KB). Binary artifacts (screenshots)
   are not yet returned to models.
10. **No long-term memory.** Sessions are per-project in browser storage; a
    workspace-level memory/index (embeddings via a local model) is roadmap.

### Hosted platform
11. **Billing inert by design.** Stripe code paths exist (checkout, signed
    webhooks, tier sync) but `SUBSCRIPTIONS_ENABLED=false`; no payments are
    processed in the prototype. Pricing is placeholder.
12. **Team management is schema-only** (no UI/API yet).
13. **Single-route app.** Only `/` is exposed in this environment; deep views
    use hash routing. Production deployments can enable real routes trivially.
14. **Anonymous usage.** Hosted analytics only count signed-in users; anonymous
    events are skipped by design (privacy-first default).

### Privacy
15. **No cloud sync exists yet** — including the good kind: project metadata
    syncs only when signed in, and no code/prompt sync feature is implemented
    (spec requires it to be explicitly user-enabled before it exists).

## Next steps (priority order)

**Phase 2 hardening (short term)**
1. node-pty-based terminal with a fallback to the current streaming shell.
2. Windows CI runner for companion tests; smoke-test installer on Win10/11.
3. Per-stage model pickers in Settings + pipeline run summary view.
4. Diff-preview in the approval dialog for `edit_file`/`write_file` before allow.
5. Companion standalone binaries (SEA/bun compile) + signed installers.

**Phase 3 (multi-agent)**
6. Parallel agent graphs (fan-out/fan-in) on the existing `AgentRunner`
   primitive; capability-based model routing using `probeTools`.
7. Local mDNS discovery (companion ↔ companion and browser ↔ LAN companion).
8. Workspace memory: per-project summaries + local embedding search.

**Phase 4 (commercial)**
9. Stripe activation checklist (docs/DEPLOYMENT.md §5) + customer portal.
10. Team workspaces: invite flow, role-gated project sharing (metadata).
11. Optional, explicitly-enabled encrypted metadata sync (never code/prompts)
    so users can move between devices.
12. Usage dashboard for hosted-service analytics with billing-period exports.

### Agent runtime (Phase Two additions)

16. **Learned dialects are validated by mocks only.** The json/tagged/py
    ladder and the per-model ledger are protocol-tested; live-model runs on
    the owner's hardware (Qwen3.5-4B, Qwen3-Coder-30B) are the next
    validation step.
17. **CDP browser happy path is mock-tested.** The companion's browser driver
    speaks the real DevTools protocol, but no browser exists in the build
    sandbox; the unavailable→UNVERIFIED path is integration-tested, the
    Chrome/Edge happy path needs one live pass on the owner's machine.
18. **Multi-machine flows need real hosts.** Fleet Map probing, machine
    attribution and cross-machine handoffs are implemented and unit-mocked;
    Station/Portable/Windows validation requires those machines.
19. **Completion-gate keyword accounting is heuristic.** Requirement→evidence
    matching uses salient-word overlap (≥50%); it errs toward refusing
    COMPLETE (safe direction), and the user override exists for false
    negatives.
