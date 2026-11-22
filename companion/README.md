# LocalForge Companion

The local companion connects the browser IDE to the customer's machine:
authorized folders, real shells, and local AI model servers. It is a single
Node.js service with **one optional runtime dependency** (`ws`; without it the
WebSocket terminal channel is disabled and everything else works identically
over HTTP/NDJSON/SSE).

## Install & run

```bash
# from this folder
npm install && npm start          # prints a pairing code

# globally (published package layout)
npm install -g @localforge/companion
localforge-companion
```

Requirements: Node.js ≥ 20 (Windows 10+, Linux, macOS).

## What it prints on start

```
  PAIRING CODE:  AB23CD45
```

Paste that code into the IDE (Launch IDE → pairing screen). The browser then
holds a bearer token (stored in `~/.localforge-companion/state.json` on the
machine and in the browser's localStorage).

## CLI

```
localforge-companion [--port 7337] [--host 127.0.0.1] [--workspace /path]
                     [--home ~/.localforge-companion] [--show-code] [--lan]
```

| Flag | Meaning |
| --- | --- |
| `--port` | HTTP port (default 7337; `0` = ephemeral, printed in the banner) |
| `--host` | Bind address (default loopback; use `--host 0.0.0.0 --lan` for LAN — only with a network you control) |
| `--workspace` | Pre-authorize a folder at startup |
| `--home` | Data directory (state.json, logs) |
| `--show-code` | Re-print the pairing code |
| `--lan` | Acknowledge non-loopback binding |

## Security model

- Loopback bind by default; pairing code is shown only in the local console.
- All `/api/*` routes require the bearer token (pairing is rate-limited and
  timing-safe).
- Every filesystem path is jailed to the authorized workspace (logical +
  realpath checks defeat `..` and symlink escapes).
- Shell commands pass a **hard-deny** list (never run) and a
  **needs-confirm** list (run only when the IDE sends `confirm:true` after a
  user approval interaction).
- The local JSONL log (`~/.localforge-companion/logs/`) contains execution
  metadata only (events, exit codes, durations, command strings) — never file
  contents or prompts.

## API surface

See `docs/API_CONTRACTS.md` in the repository root for the complete contract
(health/pair, workspaces, filesystem, exec + streaming terminal, provider
discovery + normalized chat proxy, model load/unload, tool-capability probe,
preview tokens + static/dev-server serving, SSE events, optional WebSocket).

## Tests

```bash
npm test       # black-box: spawns the real server, pairs, exercises everything
```

## Packaging strategy

- **Today:** npm global install (`bin: localforge-companion`).
- **Next:** single-file binaries via `bun build --compile` or Node SEA
  (windows-x64 / linux-x64 / macos-x64), then code-signing.
- The service is intentionally dependency-light to keep the supply chain
  auditable (see docs/LICENSES.md).
