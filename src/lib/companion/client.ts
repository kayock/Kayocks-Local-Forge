// CompanionClient — the browser's bridge to the LocalForge companion running
// on the customer's machine.
//
// Three connection modes:
//  - 'direct':  browser → http://127.0.0.1:7337 (default: the user's own
//               machine; model traffic and files stay 100% local).
//  - 'remote':  browser → an explicit user-configured companion URL (e.g. a
//               second machine or LAN box running the companion with --lan).
//  - 'gateway': browser → same-origin gateway path with XTransformPort query
//               (sandbox/demo deployments where the companion runs behind the
//               host gateway; identical REST contract).
//
// All model traffic and all file contents flow browser ↔ companion. The
// hosted backend (accounts/billing) never sees prompts or source code.
import type {
  DiscoveredProvider,
  InferenceParams,
  ModelInfo,
  ProviderConfig,
  UnifiedStreamChunk,
  WireMessage,
} from '@/lib/types';
import type { ProcInfo } from '@/lib/agent/types';

export interface CompanionConfig {
  mode: 'direct' | 'remote' | 'gateway';
  directUrl: string;   // e.g. http://127.0.0.1:7337
  remoteUrl?: string;  // mode 'remote': explicit companion endpoint, e.g. http://192.168.1.20:7337
  gatewayPort: number; // e.g. 7337 (used with XTransformPort-style gateways)
  // Same-origin path prefix that proxies to the companion (runtime-gated
  // route handler /lf-companion/*). When set, gateway mode uses it;
  // when empty, gateway mode uses the XTransformPort query style.
  gatewayPath?: string;
  token: string | null;
}

export interface OpenFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class CompanionError extends Error {
  constructor(message: string, public status?: number, public payload?: unknown) {
    super(message);
  }
}

type CfgGetter = () => CompanionConfig;

export class CompanionClient {
  constructor(private getCfg: CfgGetter) {}

  private cfg(): CompanionConfig {
    return this.getCfg();
  }

  buildUrl(path: string, query?: Record<string, string>): string {
    const c = this.cfg();
    if (c.mode === 'gateway') {
      if (c.gatewayPath) {
        const qs = new URLSearchParams(query || {});
        const q = qs.toString();
        return `${c.gatewayPath}${path}${q ? '?' + q : ''}`;
      }
      const qs = new URLSearchParams({ XTransformPort: String(c.gatewayPort), ...(query || {}) });
      return `${path}?${qs.toString()}`;
    }
    const base = (c.mode === 'remote' ? (c.remoteUrl || c.directUrl) : c.directUrl).replace(/\/+$/, '');
    const qs = new URLSearchParams(query || {});
    const q = qs.toString();
    return `${base}${path}${q ? '?' + q : ''}`;
  }

  private headers(json = true): Record<string, string> {
    const c = this.cfg();
    const h: Record<string, string> = {};
    if (c.token) h.Authorization = `Bearer ${c.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new CompanionError(json?.error || `Companion request failed (${res.status})`, res.status, json);
    }
    return json as T;
  }

  // ---- pairing / status ----
  async health(): Promise<{
    ok: boolean; name: string; version: string; platform: string; paired: boolean;
    workspaces?: { id: string; name: string; path: string }[];
    resources?: { cpus: number; load1: number; memTotal: number; memFree: number; uptimeSec: number; hostname: string };
  }> {
    const res = await fetch(this.buildUrl('/health'));
    if (!res.ok) throw new CompanionError(`Companion health check failed (${res.status})`);
    return res.json();
  }

  async pair(code: string, deviceLabel: string): Promise<{ token: string; companion: { name: string; version: string; platform: string } }> {
    const res = await fetch(this.buildUrl('/pair'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceLabel }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new CompanionError(json?.error || 'Pairing failed', res.status, json);
    return json;
  }

  // ---- workspaces ----
  listWorkspaces() {
    return this.req<{ workspaces: { id: string; path: string; name: string; previewDir?: string; lastOpenedAt?: string }[] }>('GET', '/api/workspaces');
  }

  openWorkspace(path: string, name?: string) {
    return this.req<{ workspace: { id: string; path: string; name: string } }>('POST', '/api/workspaces', { path, name });
  }

  updateWorkspace(id: string, patch: { previewDir?: string; name?: string }) {
    return this.req('PATCH', `/api/workspaces/${id}`, patch);
  }

  // ---- filesystem ----
  tree(wsId: string, depth = 4) {
    return this.req<{ root: string; entries: { path: string; type: 'dir' | 'file'; size?: number }[] }>('GET', `/api/ws/${wsId}/tree`, undefined, { depth: String(depth) });
  }

  readFile(wsId: string, path: string) {
    return this.req<{ path: string; content: string; size: number; modifiedAt: string }>('GET', `/api/ws/${wsId}/file`, undefined, { path });
  }

  writeFile(wsId: string, path: string, content: string) {
    return this.req<{ path: string; bytes: number }>('PUT', `/api/ws/${wsId}/file`, { path, content });
  }

  mkdir(wsId: string, path: string) {
    return this.req('POST', `/api/ws/${wsId}/mkdir`, { path });
  }

  deletePath(wsId: string, path: string, confirm: boolean) {
    return this.req('POST', `/api/ws/${wsId}/delete`, { path, confirm });
  }

  rename(wsId: string, from: string, to: string) {
    return this.req('POST', `/api/ws/${wsId}/rename`, { from, to });
  }

  // Forge upgrade — Problem B: true existence/emptiness inspection. A missing
  // path and an empty directory return distinguishable payloads instead of
  // both collapsing into an empty listing.
  statPath(wsId: string, path: string) {
    return this.req<{ path: string; absolute?: string; exists: boolean; parentExists?: boolean; reason?: string; type?: 'dir' | 'file' | 'other'; size?: number; entryCount?: number; empty?: boolean }>('GET', `/api/ws/${wsId}/stat`, undefined, { path });
  }

  // Forge upgrade — Problem B: archive extraction with nested-root detection
  // (the "calculator repo/calculator repo/" regression) and an explicit,
  // jailed destination. Older companions return 404 — callers degrade with a
  // clear message instead of guessing.
  extractArchive(wsId: string, path: string, opts?: { dest?: string; flatten?: boolean; overwrite?: boolean; stripComponents?: number }) {
    return this.req<{
      archive: string; dest: string; destAbsolute?: string; extracted: number; skippedExisting: number;
      bytes: number; nestedRoot: string | null; flattened: boolean; note?: string; sample: string[]; totalEntries: number;
    }>('POST', `/api/ws/${wsId}/extract`, {
      path, dest: opts?.dest || '.', flatten: !!opts?.flatten, overwrite: !!opts?.overwrite, stripComponents: opts?.stripComponents,
    });
  }

  search(wsId: string, q: string, opts?: { isRegex?: boolean; glob?: string; max?: number }) {
    return this.req<{ count: number; results: { path: string; line: number; text: string }[] }>('GET', `/api/ws/${wsId}/search`, undefined, {
      q,
      isRegex: opts?.isRegex ? '1' : '0',
      glob: opts?.glob || '',
      max: String(opts?.max ?? 300),
    });
  }

  // ---- command execution (batch) ----
  async exec(wsId: string, cmd: string, opts?: { cwd?: string; timeoutMs?: number; confirm?: boolean }): Promise<{
    exitCode: number | null; stdout: string; stderr: string; cwd: string | null; durMs: number; timedOut: boolean;
  }> {
    try {
      return await this.req('POST', `/api/ws/${wsId}/exec`, {
        cmd, cwd: opts?.cwd || '.', timeoutMs: opts?.timeoutMs, confirm: opts?.confirm || false,
      });
    } catch (e) {
      if (e instanceof CompanionError && e.status === 403 && (e.payload as any)?.needsConfirm) {
        throw new NeedsConfirmError((e.payload as any).error || 'Confirmation required');
      }
      throw e;
    }
  }

  // ---- streaming terminal (NDJSON over POST) ----
  // Returns the final exit event; emits chunks via onChunk as they arrive.
  async term(wsId: string, opts: {
    cmd: string; cwd?: string; confirm?: boolean; timeoutMs?: number; sessionId?: string;
    onChunk?: (stream: 'out' | 'err', data: string) => void;
    signal?: AbortSignal;
  }): Promise<{ code: number | null; cwd: string; durMs: number; timedOut: boolean }> {
    const res = await fetch(this.buildUrl(`/api/ws/${wsId}/term`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ cmd: opts.cmd, cwd: opts.cwd || '.', confirm: opts.confirm || false, timeoutMs: opts.timeoutMs, sessionId: opts.sessionId }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({}));
      if ((json as any)?.needsConfirm) throw new NeedsConfirmError((json as any).error);
      throw new CompanionError((json as any)?.error || `Terminal failed (${res.status})`, res.status, json);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let exit = { code: null as number | null, cwd: opts.cwd || '.', durMs: 0, timedOut: false };
    let sessionId: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.t === 'start') sessionId = ev.sessionId;
        else if (ev.t === 'out' || ev.t === 'err') opts.onChunk?.(ev.t, ev.d ?? '');
        else if (ev.t === 'exit') exit = { code: ev.code, cwd: ev.cwd || opts.cwd || '.', durMs: ev.durMs || 0, timedOut: !!ev.timedOut };
      }
    }
    return exit;
  }

  signalTerm(wsId: string, sessionId: string) {
    return this.req('POST', `/api/ws/${wsId}/term/signal`, { sessionId });
  }

  // ---- detached processes (GUI/desktop apps, dev servers) ----
  // Start returns immediately; the companion tracks the real lifecycle.
  procStart(wsId: string, cmd: string, opts?: { cwd?: string }) {
    return this.req<{ proc: ProcInfo }>('POST', `/api/ws/${wsId}/proc/start`, { cmd, cwd: opts?.cwd || '.', confirm: true }).then((r) => r.proc);
  }

  procList(wsId: string) {
    return this.req<{ processes: ProcInfo[] }>('GET', `/api/ws/${wsId}/proc/list`).then((r) => r.processes);
  }

  procOutput(wsId: string, id: string, sinceBytes = 0) {
    return this.req<{ proc: ProcInfo; output: string; outputBytes: number }>('GET', `/api/ws/${wsId}/proc/output`, undefined, { id, since: String(sinceBytes) });
  }

  procStop(wsId: string, id: string) {
    return this.req<{ proc: ProcInfo }>('POST', `/api/ws/${wsId}/proc/stop`, { id }).then((r) => r.proc);
  }

  // ---- shared browser (Forge upgrade — Part 6) ----
  // One CDP session per workspace: visible for the user, headless for
  // automated verification. Unavailability is reported honestly — callers
  // must record UNVERIFIED, never a fake pass.
  browserOpen(wsId: string, opts?: { url?: string; visible?: boolean }) {
    return this.req<{ ok?: boolean; reused?: boolean; url?: string; visible?: boolean; browser?: string; pid?: number; unavailable?: string }>('POST', `/api/ws/${wsId}/browser/open`, { url: opts?.url, visible: opts?.visible });
  }

  browserNavigate(wsId: string, url: string) {
    return this.req<{ ok: boolean; url: string; title?: string; unavailable?: string }>('POST', `/api/ws/${wsId}/browser/navigate`, { url });
  }

  browserEval(wsId: string, expression: string) {
    return this.req<{ ok: boolean; value?: unknown; type?: string; error?: string; consoleErrors?: { kind: string; text: string }[]; unavailable?: string }>('POST', `/api/ws/${wsId}/browser/eval`, { expression });
  }

  browserScreenshot(wsId: string, savePath?: string) {
    return this.req<{ ok: boolean; savedTo?: string; bytes?: number; dataBase64?: string; note?: string; unavailable?: string }>('POST', `/api/ws/${wsId}/browser/screenshot`, { path: savePath });
  }

  browserVerify(wsId: string, opts: { url: string; checks?: { selector?: string; contains?: string; minCount?: number; evaluate?: string; expected?: unknown }[]; saveScreenshot?: string }) {
    return this.req<{
      ok?: boolean; url?: string; title?: string; checks?: { check: string; pass: boolean; count?: number; text?: string | null; value?: unknown; error?: string }[];
      checksPassed?: number; checksTotal?: number; consoleErrors?: { kind: string; text: string }[]; screenshotPath?: string;
      verdict?: string; verifiedAt?: string; unavailable?: string;
    }>('POST', `/api/ws/${wsId}/browser/verify`, opts);
  }

  browserClose(wsId: string) {
    return this.req<{ ok: boolean; note?: string }>('POST', `/api/ws/${wsId}/browser/close`, {});
  }

  browserStatus(wsId: string) {
    return this.req<{ running: boolean; url?: string; visible?: boolean; startedAt?: string; consoleErrors?: number }>('GET', `/api/ws/${wsId}/browser/status`);
  }

  // ---- preview ----
  async previewToken(wsId: string, previewDir?: string): Promise<{ token: string; previewDir: string; url: string }> {
    const r = await this.req<{ token: string; previewDir: string; url: string }>('POST', `/api/ws/${wsId}/preview-token`, previewDir !== undefined ? { previewDir } : {});
    return r;
  }

  // Absolute URL for the preview iframe.
  previewUrl(wsId: string, ptok: string): string {
    const c = this.cfg();
    if (c.mode === 'gateway') {
      if (c.gatewayPath) {
        return `${c.gatewayPath}/preview/${wsId}/${ptok}/`;
      }
      return `/preview/${wsId}/${ptok}/?XTransformPort=${c.gatewayPort}`;
    }
    return `${c.directUrl.replace(/\/+$/, '')}/preview/${wsId}/${ptok}/`;
  }

  // ---- providers & models ----
  discoverProviders(extraUrls: string[] = [], apiKey?: string) {
    return this.req<{ providers: DiscoveredProvider[]; credentials?: { lemonadeEnvKey: 'available' | 'not-found' } }>('POST', '/api/providers/discover', { extraUrls, apiKey });
  }

  // Single-endpoint probe for the "Add endpoint" flow (0.4.4): registers a URL
  // even when the server needs an API key or hides its model list.
  probeEndpoint(url: string, apiKey?: string) {
    return this.req<DiscoveredProvider & { error?: string }>('POST', '/api/providers/probe', { url, apiKey });
  }

  listModels(provider: ProviderConfig) {
    return this.req<{ models: ModelInfo[] }>('POST', '/api/providers/models', { provider });
  }

  loadModel(provider: ProviderConfig, model: string, keepAlive?: string) {
    return this.req<{ ok: boolean; message: string }>('POST', '/api/models/load', { provider, model, keepAlive });
  }

  unloadModel(provider: ProviderConfig, model: string) {
    return this.req<{ ok: boolean; message: string }>('POST', '/api/models/unload', { provider, model });
  }

  probeTools(provider: ProviderConfig, model: string) {
    return this.req<{ nativeTools: 'yes' | 'no' | 'weak' | 'unknown'; detail?: string }>('POST', '/api/models/probe-tools', { provider, model });
  }

  testConnection(provider: ProviderConfig, model: string) {
    return this.req<{ ok: boolean; latencyMs?: number; reply?: string; message?: string }>('POST', '/api/models/test', { provider, model });
  }

  // ---- streaming chat proxy (NDJSON) ----
  // Streams unified chunks; resolves when the upstream stream ends.
  async chat(opts: {
    provider: ProviderConfig;
    model: string;
    messages: WireMessage[];
    tools?: OpenFunctionTool[];
    params?: Partial<InferenceParams>;
    onChunk?: (c: UnifiedStreamChunk) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string; end?: UnifiedStreamChunk }> {
    const res = await fetch(this.buildUrl('/api/chat'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        provider: opts.provider,
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        params: opts.params || {},
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new CompanionError((json as any)?.error || `Chat proxy failed (${res.status})`, res.status, json);
    }
    if (!res.body) throw new CompanionError('Chat proxy returned no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let end: UnifiedStreamChunk | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let chunk: UnifiedStreamChunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.t === 'text') text += chunk.v || '';
        if (chunk.t === 'error') throw new CompanionError(chunk.message || 'Model stream error');
        opts.onChunk?.(chunk);
        if (chunk.t === 'end') end = chunk;
      }
    }
    return { text, end };
  }

  // ---- events (SSE) ----
  openEvents(): EventSource {
    const c = this.cfg();
    if (c.mode === 'gateway') {
      if (c.gatewayPath) {
        const qs = new URLSearchParams({ token: c.token || '' });
        return new EventSource(`${c.gatewayPath}/api/events?${qs.toString()}`);
      }
      const qs = new URLSearchParams({ XTransformPort: String(c.gatewayPort), token: c.token || '' });
      return new EventSource(`/api/events?${qs.toString()}`);
    }
    const qs = new URLSearchParams({ token: c.token || '' });
    return new EventSource(`${c.directUrl.replace(/\/+$/, '')}/api/events?${qs.toString()}`);
  }
}

export class NeedsConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsConfirmError';
  }
}
