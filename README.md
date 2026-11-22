<div align="center">

# LocalForge IDE

**Your models. Your machine. Your IDE.**

A browser-based AI coding environment that connects to language models already
running on your own computer. Real files, real terminals, real builds — with
every tool call visible.

</div>

LocalForge is a working software system, not a mockup. It has three parts:

| Part | What it is | Where it runs |
| --- | --- | --- |
| **Web IDE** (`/`) | Next.js app: Monaco editor, file explorer, agent chat, terminal, preview, dashboards | Hosted (or self-hosted) |
| **Companion** (`companion/`) | Small Node.js service: file tools, shell execution, model-server proxy, preview server, pairing | The customer's machine (Windows/Linux; macOS compatible) |
| **Hosted backend** (`src/app/api/`) | Accounts, sessions, project metadata, billing scaffolding, usage analytics | Hosted server (never sees code or prompts) |

The browser talks **directly** to the companion for everything local. The hosted
backend only manages accounts and metadata — source code and model prompts never
leave the customer's machine unless the user explicitly enables a transfer
feature (none is enabled in this build).


## Companion control plane (v0.4.5 source candidate)

The `companion/` source now implements the Phase 2 hardware, Model Manager,
explicitly paired LAN mesh peers, agent scratchpad/notebook/assignments and
workspace-revision routes used by `MeshClient`. Nothing loads a model during
inventory. Existing provider/chat and pairing contracts remain supported.
See [Phase 2 implementation and limits](docs/CONTROL_PLANE_PHASE2_2026-11-21.md).

**Source-only:** the supplied Windows/Linux installers were not rebuilt from
this code. Physical fleet tests, Next.js build verification, native discovery
and automated agent scheduling remain separate work.

## Quick start (5 minutes)

### 1. Run the IDE

```bash
# hosted instance (the preview you were given), or self-host:
npm install
cp .env.example .env   # Windows: copy .env.example .env
mkdir -p db            # Windows: mkdir db
npx prisma db push
npm run dev          # http://localhost:3000
```

### 2. Install the companion on your computer

```bash
npm install -g @localforge/companion   # or: cd companion && npm link
localforge-companion
```

It prints a **pairing code**, e.g. `PAIRING CODE: AB23CD45`.

### 3. Pair the browser

Open the IDE → **Launch IDE** → paste the pairing code.

### 4. Pick your model

Settings → **Discover** finds Ollama (`:11434`), LM Studio (`:1234`),
llama.cpp `llama-server` (`:8080`), Lemonade (`:8000`) and any
OpenAI-compatible endpoint automatically. Choose a model.

### 5. Authorize a workspace and run the agent

Open a folder, switch the agent panel to **Agent** mode, describe a task:

> Build a todo app with add, complete and delete; write a test and make it pass.

Watch it read files, write code, run `npm test`, read failures, fix code, and
finish — with every tool call in the **Tool log** panel.

## Verify it end-to-end

```bash
# full proof-of-function test against a real local model (see docs/VERIFICATION.md):
llama-server -m <model.gguf> -c 8192 --port 8080 &
bun run test:e2e -- --endpoint http://127.0.0.1:8080
```

The E2E script drives the same agent runtime the browser uses, checks all ten
proof points, and writes `e2e-report.json`. It **fails honestly** if no real
model endpoint is available.

## Source audit and patched builds (November 2026)

This source contains the verified workspace/preview and release-packaging repairs
documented in [the audit report](docs/REPAIR_AUDIT_2026-11-21.md). Run the
Companion regression suite with `cd companion && npm test` (28 passing tests).
Build clean source archives with `bash scripts/build-source-zip.sh`.

**Important:** Companion 0.4.4's packaged backend does not yet implement the
IDE's full mesh/model-manager/agent-memory API contract. These features are not
yet independently verified end to end. The original prebuilt Windows installers
are **not** rebuilt by changing source; rebuild them before treating the
filesystem fixes as installed.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design + architecture diagram |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | Browser ↔ companion ↔ backend API contracts |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Hosted backend data model |
| [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) | Working / partial / simulated / untested / unimplemented — honest status |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Automated + manual verification procedures and results |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Self-hosting, production deployment, companion packaging |
| [docs/WINDOWS_INSTALL.md](docs/WINDOWS_INSTALL.md) | Windows companion installer: install, tray app, troubleshooting, SmartScreen, verification status |
| [docs/LIMITATIONS_AND_NEXT_STEPS.md](docs/LIMITATIONS_AND_NEXT_STEPS.md) | Known limits and the roadmap |
| [docs/LICENSES.md](docs/LICENSES.md) | Third-party licenses (commercial compatibility) |

## Repository layout

```
├── src/                     # Next.js 16 IDE (App Router, TypeScript)
│   ├── app/                 # single route + REST API routes (auth/projects/billing/usage)
│   ├── components/ide/      # IDE panels (explorer, editor, agent, terminal, preview…)
│   ├── components/views/    # landing / auth / dashboard / settings
│   └── lib/
│       ├── agent/           # ★ agent runtime (pure TS, shared by browser + E2E)
│       ├── companion/       # ★ browser-side companion client
│       ├── store/           # zustand state
│       └── hosted/          # hosted-backend client
├── companion/               # ★ Node.js companion (deps: ws only)
│   ├── src/                 # server, fs tools, exec, providers, preview
│   └── test/                # black-box integration tests (node:test)
├── e2e/live-e2e.ts          # ★ live end-to-end verification script
├── prisma/                  # hosted backend schema (SQLite; Postgres-ready)
└── docs/                    # documentation suite
```

## Status

This is a **prototype build**: the IDE, companion, agent runtime, and billing
scaffolding are implemented and tested; live payments are deliberately
inert (`SUBSCRIPTIONS_ENABLED=false`). See
[docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) for the exact status of every
feature, including what is verified, what is protocol-tested only, and what is
not yet built.

## License

MIT (this repository). Third-party licenses: see docs/LICENSES.md.
