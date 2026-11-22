# API Contracts

Three interfaces are defined. All JSON bodies are UTF-8. Errors are
`{"error": "message"}` with an appropriate HTTP status unless noted.

---

## 1. Browser ⇄ Companion

Default base: `http://127.0.0.1:7337` (direct mode). Two gateway transports exist for hosted/locked-down deployments (identical contract):
`/lf-companion/<path>` (Next.js same-origin rewrite) or `/<path>?XTransformPort=7337` (host reverse proxy).
All `/api/*` routes (except `/api/events`) require
`Authorization: Bearer <token>` from pairing. `/pair` and `/health` are public.
CORS: reflected origin, methods `GET,POST,PUT,PATCH,DELETE,OPTIONS`, headers `Authorization, Content-Type`, plus `Access-Control-Allow-Private-Network: true` so a
secure page may call loopback.

### Pairing & status

| Method/Path | Body/Query | Response | Notes |
| --- | --- | --- | --- |
| `GET /health` | — | `{ok, name, version, platform, paired, workspaces:[{id,name,path}]}` | public |
| `POST /pair` | `{code, deviceLabel}` | `{token, companion:{name,version,platform}}` | 8-char code from companion console; rate limited 6/min/IP; timing-safe compare |
| `GET /api/events` | `?token=` | SSE stream: `data: {"type":"exec_start"\|"exec_end"\|"term_start"\|"term_end"\|"fs_write"\|"workspace_open", ...}` | execution transparency |

### Workspaces

| Method/Path | Body | Response |
| --- | --- | --- |
| `GET /api/workspaces` | — | `{workspaces:[{id, path, name, previewDir}]}` |
| `POST /api/workspaces` | `{path, name?}` | `{workspace}` — realpath must exist & be a dir; id = sha1(realpath) prefix |
| `PATCH /api/workspaces/:id` | `{name?, previewDir?}` | `{workspace}` |
| `DELETE /api/workspaces/:id` | — | `{removed}` |

### Filesystem (all jailed to the workspace root; traversal → 400)

| Method/Path | Body/Query | Response |
| --- | --- | --- |
| `GET /api/ws/:id/tree` | `?depth=4` | `{root, entries:[{path,type:'dir'\|'file',size}]}` (node_modules/.git/etc. ignored) |
| `GET /api/ws/:id/file` | `?path=rel` | `{path, content, size, modifiedAt}` — text ≤2MB |
| `PUT /api/ws/:id/file` | `{path, content}` | `{path, bytes}` — parents auto-created |
| `POST /api/ws/:id/mkdir` | `{path}` | `{path}` |
| `POST /api/ws/:id/delete` | `{path, confirm}` | `{deleted}` — **403 without `confirm:true`** |
| `POST /api/ws/:id/rename` | `{from, to}` | `{from, to}` |
| `GET /api/ws/:id/search` | `?q=&isRegex=&glob=&max=&ignoreCase=` | `{query, count, results:[{path,line,text}]}` |

### Execution

| Method/Path | Body | Response |
| --- | --- | --- |
| `POST /api/ws/:id/exec` | `{cmd, cwd?, timeoutMs?, confirm?}` | `{exitCode, stdout, stderr, cwd(after), durMs, timedOut}` — output capped 400KB/stream |
| `POST /api/ws/:id/term` | `{cmd, cwd?, sessionId?, confirm?, timeoutMs?}` | **NDJSON stream**: `{t:'start',sessionId}` `{t:'out'\|'err', d}` `{t:'exit', code, cwd, durMs, timedOut}` |
| `POST /api/ws/:id/term/signal` | `{sessionId}` | `{signaled}` — Ctrl+C (process-group SIGINT→SIGKILL) |

Command screening (defense in depth, not a sandbox):

- **Hard deny** (never runs): `mkfs`, `dd if=`, fork bombs, `chmod -R 777 /`, …
- **Needs confirm** (runs only with `confirm:true` after a UI approval):
  `sudo`, `rm -r*` on `/`/`~`, `shutdown/reboot`, `curl … | sh`, forced pushes, …
  → HTTP 403 `{error, needsConfirm:true}`.

### Providers & models

| Method/Path | Body | Response |
| --- | --- | --- |
| `POST /api/providers/discover` | `{extraUrls?}` | `{providers:[{kind:'ollama'\|'openai', baseUrl, name, models:[…]}]}` — probes 11434/1234/8080/8000/1337 + extras |
| `POST /api/providers/models` | `{provider:{kind,baseUrl,apiKey?}}` | `{models:[{id, display, sizeBytes?, paramSize?, quant?}]}` |
| `POST /api/chat` | `{provider, model, messages, tools?, params?}` | **NDJSON unified stream** (below) |
| `POST /api/models/load` / `unload` | `{provider, model, keepAlive?}` | `{ok, message}` — Ollama `keep_alive`; LM Studio best-effort |
| `POST /api/models/probe-tools` | `{provider, model}` | `{nativeTools:'yes'\|'no'\|'weak'\|'unknown', detail}` |
| `POST /api/models/test` | `{provider, model}` | `{ok, latencyMs?, reply?}` |

Unified chat stream events (one JSON per line):

```
{t:'text', v:'…'}                             // content delta
{t:'end', finish:'stop'|'tool_calls', toolCalls:[{id,name,args}], usage:{promptTokens,completionTokens}}
{t:'error', message:'…'}
```

Messages (OpenAI-style): `system|user|assistant|tool` with optional
`tool_calls[{id,function:{name,arguments}}]` and `tool_call_id`. The companion
converts to Ollama's native chat format when `kind:'ollama'`.

### Preview

| Method/Path | Response |
| --- | --- |
| `POST /api/ws/:id/preview-token` | `{token, previewDir, url}` (short-lived) |
| `GET /preview/:wsId/:ptok/*` | static file from `previewDir` (dir → index.html, pretty `.html` fallback) |
| `GET|POST /p/:ptok/:port/*` | reverse proxy to `127.0.0.1:port` (X-Frame-Options/CSP stripped) |

---

## 2. Browser ⇄ Hosted backend

Cookie session (`lf_session`, httpOnly, SameSite=Lax). All under the web app.

| Method/Path | Body | Response | Auth |
| --- | --- | --- | --- |
| `POST /api/auth/register` | `{email, password, name}` | `{user}` | public |
| `POST /api/auth/login` | `{email, password}` | `{user}` | public |
| `POST /api/auth/logout` | — | `{ok}` | session |
| `GET /api/auth/me` | — | `{user\|null}` | session |
| `GET /api/projects` | — | `{projects:[…]}` | session |
| `POST /api/projects` | `{name, description?, localPath?, companionLabel?}` | `{project}` | session |
| `PATCH /api/projects/:id` | partial | `{ok}` | session |
| `DELETE /api/projects/:id` | — | `{ok}` | session |
| `GET /api/billing/tiers` | — | `{tiers, enabled}` | public |
| `GET /api/billing/status` | — | `{enabled, tier, status, message?}` | session |
| `POST /api/billing/checkout` | `{tier}` | `{url, message}` — **503 + explanatory message while billing disabled** | session |
| `POST /api/billing/webhook` | Stripe event (signature-verified) | `{received}` | Stripe secret |
| `POST /api/usage` | `{kind, meta?}` | `{ok}` (silently skipped when anonymous) | session |
| `GET /api/usage` | — | `{events:[{kind,count,lastAt}]}` | session |

---

## 3. IDE ⇄ Agent runtime (internal, TypeScript)

`AgentRunner` config: `{companion, workspaceId, provider, model, params,
systemPrompt, task, contextMessages, tools, toolProtocol, maxTurns, onEvent,
approver, allowedPatterns, signal}`.

`onEvent` union (`AgentEvent`): `turn_start`, `text_delta`, `text_final`,
`tool_start`, `tool_end`, `approval_request`, `approval_decision`,
`model_error`, `usage`, `final`, `stage`, `notice`.

`PipelineRunner` config adds `stageModels` (per-stage model override) and
emits `stage` events tagged `planner|coder|tester|reviewer`.
