# LocalForge Companion Phase 2 control plane (source-only candidate)

This work builds on the repaired `Companion v0.4.4` source. Version `0.4.5`
adds the API contract already used by `src/lib/mesh/client.ts` to the **existing
local Companion**. The installed/tray Windows executables have **not** been
rebuilt. Do not assume any installed companion has this code until it is
explicitly built/installed and verified.

## Added API surface (existing paired bearer token required)

| Group | Routes / semantics |
|---|---|
| Hardware | `GET /api/hardware`: CPU, RAM, optional GPU inspection; missing vendor probes reported as unknown |
| Models | `GET /api/models`: configured GGUF dirs, Ollama discovery, external endpoints, saved profiles, attached/managed server list |
| Models | `POST/DELETE /api/models/dirs`; `POST /api/models/profiles`; `DELETE /api/models/profiles/:id` |
| Models | `POST /api/models/load` with `{profileId}`; `POST /api/models/unload` with `{serverId}` or `{profileId}` |
| Models | `GET /api/models/status/:id`, `GET /api/models/diagnostics/:id`, `GET /api/models/output/:id?since=` |
| Models | `POST /api/models/external` with `{name,endpoint}` |
| Mesh | `GET /api/mesh/status`, `POST /api/mesh/connect` with `{url,code?,name?}`, `GET/DELETE /api/mesh/peers/:id`, `POST /api/mesh/peers/:id/pair` |
| Mesh | `METHOD /api/mesh/:id/proxy/api/(models|hardware|network|agents|ws revision)...` forwards an already-paired peer's control-plane operation |
| Network | `GET/POST /api/network` records desired bind host and port; **requires restart**; `POST /api/network/test` probes a LAN Companion |
| Memory | `GET/PUT /api/agents/:workspace/scratchpad/:agent`, `GET/POST /api/agents/:workspace/notebook`, `GET/POST /api/agents/:workspace/assignments` |
| Revision | `GET /api/ws/:workspace/revision` hashes relative paths, sizes, and modification times (skips symlinks) |

### Existing compatibility

`POST /api/models/load` with `{provider,model,keepAlive}` and
`POST /api/models/unload` with `{provider,model}` retain their prior behavior.
No existing chat, file, terminal, pairing, preview, or provider routes were
intentionally changed. The browser `MeshClient` also now honors the same
`gateway` URL configuration as `CompanionClient`.

### Model ownership and safety

- Reading `/api/models` **never launches or loads an inference server**.
- An **Ollama** profile uses Ollama's existing model-load API. On-demand is
  preserved and user-provided `ctx` values remain in profiles.
- A **llamacpp** profile may explicitly spawn a configured executable and GGUF
  file when the user clicks Load. Arguments are passed directly (no shell).
  It is stopped on explicit unload or Companion shutdown. Startup has a
  configurable profile timeout (default five minutes, no changes to the
  existing **20-minute chat timeout**). Logs/diagnostics are bounded.
- **external, foxai, openvino** profiles are currently **attach-only**; the
  Companion does not claim to own or stop those providers' processes.
- Inference settings for real heterogeneous GPU hardware have **not** been
  validated. A fake llama-server and fake Ollama provide lifecycle contract
  coverage; they are not performance benchmarks.

### Mesh security and limits

The client uses the Companion's **existing pairing-code and bearer-token**
mechanism; no additional authentication gate was introduced. Explicit peer
URLs must resolve to LAN or loopback addresses. The pairing token received
from the remote Companion is stored in a separate local credentials file with
`0600` permissions on POSIX and is **never returned in mesh status**. Windows
filesystem permissions require separate verification. A limited allowlist
forbids shell/FS execution through the mesh proxy; peer access cannot be used
as an arbitrary URL forwarder through the documented routes. No public WAN
connectivity or general network scan is added.

**Still outstanding:** native mDNS discovery (status returns `discovered: []`),
remote process owners' native consoles, cross-platform installer rebuilds,
physical two-machine LAN/GPU tests, full symlink-race protection, complete
WebSocket/HMR reverse proxy, deeper OS process isolation and hardened DNS
rebind defenses, a task execution scheduler (assignments are durable records,
not a dispatch engine). A Caddy gateway sample now only proxies
`XTransformPort=7337` to avoid an arbitrary-local-port forwarding rule.

## Verification

```
cd companion
npm test
# control plane only:
node --test test/controlplane.integration.test.mjs
```

- The new integration test starts **two independent real Companion HTTP
  processes** with fresh temporary data homes, pairs them, exercises an
  authenticated peer proxy, and blocks requests for remote exec.
- It tests inventory against an isolated fake Ollama server and verifies no
  load requests on inventory. It tests profile-based Ollama load/unload.
- On POSIX it starts a disposable fake HTTP inference process with the
  llama-server argument contract, waits for readiness, checks diagnostics and
  output, and stops the process.
- It checks authenticated workspace memory, notebook and assignments,
  revisions, saved model paths, and network restart reporting.
- **It does not install anything, contact user hardware, or use a real GPU.**

The full Next.js build / browser UI and Windows installer were not verified
in the initial offline environment. Run workflow CI and real-host smoke tests
before shipping a binary as an official version.
