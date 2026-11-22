# Deployment & Operations

## 1. Local development (IDE + companion on one machine)

```bash
# IDE
npm install
npx prisma db push
cp .env.example .env      # optional: adjust
npm run dev               # http://localhost:3000

# Companion (second terminal — this is also how end users run it)
cd companion && npm install && npm link   # or: npm i -g @localforge/companion
localforge-companion
```

The browser connects directly to `http://127.0.0.1:7337` (default `direct`
mode). Nothing else to configure.

## 2. Hosted production (SaaS)

### 2.1 Environment

```ini
DATABASE_URL="file:./db/custom.db"     # or postgres://… for production
SUBSCRIPTIONS_ENABLED="false"          # keep false until billing is activated
STRIPE_SECRET_KEY=""                   # required only when the above is true
STRIPE_PRICE_PRO=""                    # price IDs created in Stripe
STRIPE_PRICE_TEAM=""
STRIPE_WEBHOOK_SECRET=""               # for /api/billing/webhook
NEXT_PUBLIC_APP_URL="https://your-domain.com"
```

### 2.2 Build & run

```bash
npm run build
npm start               # NODE_ENV=production bun .next/standalone/server.js
```

Deploy targets: any Node host (VM, Docker, Fly.io, Railway). The app is a
standard Next.js standalone build; SQLite keeps the prototype portable — switch
`datasource` to PostgreSQL and run `prisma migrate deploy` for a multi-node
deployment. The IDE is static after build; only `/api/*` and the preview are
dynamic.

### 2.3 Important architectural note

The hosted IDE served from `https://your-domain.com` talks to the customer's
companion from **their browser** (fetch/WebSockets to `127.0.0.1:7337`).
Browsers allow secure pages to call loopback (Private Network Access):
the companion already answers preflights with
`Access-Control-Allow-Private-Network: true` and permissive CORS. No cloud
proxy for model traffic exists — that is the privacy design. If a corporate
network blocks loopback fetches from remote pages, users can self-host the IDE
(§1) where same-origin `http://` removes all mixed-content concerns.

## 3. Companion distribution & packaging strategy

| Stage | Mechanism | Status |
| --- | --- | --- |
| Today (Windows) | **Per-user NSIS installer** with embedded-runtime companion (`bun build --compile --target=bun-windows-x64`, ~93 MB exe) + native Win32 tray GUI; Start-Menu shortcut, optional desktop shortcut + autostart, clean uninstall that preserves user data. Downloadable from the website connection screen (`/downloads/`) | ✅ built & served (`installer/windows/build-windows.sh`); **installer run itself UNVERIFIED on real Windows hardware** — see docs/WINDOWS_INSTALL.md |
| Today (any OS) | `npm install -g @localforge/companion` (bin: `localforge-companion`) | ✅ shipped in repo (`companion/`) — developer path, kept alongside the installer |
| Next | macOS/Linux one-file binaries (`bun build --compile`) + code-signing certificate for the Windows installer (removes the SmartScreen warning) | roadmap |
| Later | Auto-update channel + in-app download from the hosted dashboard | roadmap |

Companion data lives in `%LOCALAPPDATA%\LocalForgeCompanion` (Windows
installer) or `~/.localforge-companion/` elsewhere (`state.json`, `status.json`
for the tray GUI, `logs/`). The log contains **execution metadata only**
(events, exit codes, durations, command strings) — never file contents or
prompts. Pairing tokens are stored only as SHA-256 hashes.

CLI reference:

```
localforge-companion [--port 7337] [--host 127.0.0.1] [--workspace /path]
                     [--home ~/.localforge-companion] [--show-code] [--lan]
```

## 4. Configuration matrix

| Setting | Where | Default |
| --- | --- | --- |
| Companion port/host | CLI / `LOCALFORGE_PORT` / `LOCALFORGE_HOST` | 7337 / 127.0.0.1 |
| Companion data dir | `--home` / `LOCALFORGE_HOME` | `~/.localforge-companion` |
| Browser transport mode | IDE Settings → Companion | `direct`, auto-falls back to `gateway` on hosted previews |
| Model endpoint(s) | IDE Settings → Discover | — |
| Execution policy | IDE Settings → Execution policy | `confirm-commands` |
| Tool protocol | IDE Settings | `auto-native` (auto-fallback to text protocol) |

## 5. Activating billing (post-prototype checklist)

1. Create Stripe products/prices → set `STRIPE_PRICE_*`.
2. Set `SUBSCRIPTIONS_ENABLED=true` + `STRIPE_SECRET_KEY`.
3. Add webhook endpoint → `/api/billing/webhook` with
   `customer.subscription.*`, `checkout.session.completed`.
4. Set `STRIPE_WEBHOOK_SECRET`.
5. Smoke test in Stripe test mode; confirm `/api/billing/status` flips and
   webhook rows appear in `BillingWebhookEvent`.

Until then, checkout returns HTTP 503 with an explanatory message and no
payment is attempted (verified in tests).
