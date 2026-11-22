// Local model provider integration.
//
// The companion is the only process that talks to local inference servers,
// because it runs on the same machine/LAN as those servers. The browser IDE
// never needs direct access; it calls the companion's normalized /api/chat
// proxy, which speaks to:
//   - Ollama          (native /api/chat, NDJSON stream)
//   - LM Studio       (OpenAI-compatible /v1)
//   - llama.cpp       (llama-server, OpenAI-compatible /v1)
//   - Lemonade Server (OpenAI-compatible /api/v1)
//   - any other OpenAI-compatible endpoint
// Streaming is normalized into a single NDJSON protocol back to the browser.
import { Readable } from 'node:stream';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const PROBE_TIMEOUT = 900;

// ---- Lemonade credential retrieval (companion machine only) ----
// lemond stores its API key in /etc/lemonade/lemond.env as LEMONADE_API_KEY=…
// (LEMONADE_ENV_FILE overrides the path for non-standard installs). The key is
// used for outbound Authorization headers only: it is never logged and never
// returned to the browser.
const LEMONADE_ENV_CANDIDATES = [
  process.env.LEMONADE_ENV_FILE,
  '/etc/lemonade/lemond.env',
  '/etc/default/lemonade',
].filter(Boolean);

let lemonadeKeyCache; // undefined = not read yet, null = no usable key found
export function resolveLemonadeCredentials() {
  if (lemonadeKeyCache !== undefined) return lemonadeKeyCache;
  lemonadeKeyCache = null;
  for (const p of LEMONADE_ENV_CANDIDATES) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const m = text.match(/^\s*LEMONADE_API_KEY\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
      if (m && m[1].trim()) { lemonadeKeyCache = m[1].trim(); break; }
    } catch { /* missing or unreadable — try the next candidate */ }
  }
  return lemonadeKeyCache;
}

// Only attach the companion-resolved key to endpoints that are plausibly THIS
// machine's Lemonade (loopback host + Lemonade-ish port or /api/v1 path), so
// the credential can never leak to some other LAN endpoint.
function isLocalLemonade(base) {
  try {
    const u = new URL(base);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
    const lemonadeish = /\/api\/v1/.test(u.pathname) || u.port === '13305' || u.port === '8000';
    return loopback && lemonadeish;
  } catch { return false; }
}

// Credentials for an outbound call: the browser-supplied key wins; otherwise
// the companion-resolved Lemonade key applies to local Lemonade endpoints.
export function credentialFor(provider) {
  if (provider?.apiKey) return provider.apiKey;
  const envKey = resolveLemonadeCredentials();
  if (envKey && isLocalLemonade(normalizeBaseUrl(provider?.baseUrl))) return envKey;
  return undefined;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

async function fetchJson(url, { timeoutMs = PROBE_TIMEOUT, method = 'GET', body, headers } = {}) {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { method, signal, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    done();
  }
}

export function normalizeBaseUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(b)) b = 'http://' + b;
  return b;
}

// ---- discovery ----
export const DEFAULT_CANDIDATES = [
  'http://127.0.0.1:11434', // Ollama default
  'http://127.0.0.1:1234',  // LM Studio default
  'http://127.0.0.1:8080',  // llama.cpp llama-server default
  'http://127.0.0.1:8000',  // Lemonade Server default
  'http://127.0.0.1:13305', // Lemonade Server (lemond, Ubuntu Portable deployment)
  'http://127.0.0.1:1337',  // llama-server alternative
];

export async function probeEndpoint(baseUrl, { apiKey } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const auth = authHeaders(apiKey);
  // Ollama?
  const tags = await fetchJson(`${base}/api/tags`, { headers: auth });
  if (tags.ok && tags.json?.models) {
    return {
      kind: 'ollama', baseUrl: base, name: 'Ollama', reachable: true, authOk: true, status: 200,
      answers: { ollama: tags.status },
      models: (tags.json.models || []).map((m) => ({
        id: m.name, display: m.name,
        sizeBytes: m.size || null,
        paramSize: m.details?.parameter_size || null,
        quant: m.details?.quantization_level || null,
        family: m.details?.family || null,
      })),
    };
  }
  // OpenAI-compatible /v1/models?
  const v1 = await fetchJson(`${base}/v1/models`, { headers: auth });
  if (v1.ok && v1.json?.data) {
    return {
      kind: 'openai', baseUrl: base + '/v1', name: guessOpenAiName(base, v1), reachable: true, authOk: true, status: 200,
      answers: { ollama: tags.status, openai: v1.status },
      models: (v1.json.data || []).map((m) => ({ id: m.id, display: m.id })),
    };
  }
  // Lemonade /api/v1/models?
  const lem = await fetchJson(`${base}/api/v1/models`, { headers: auth });
  if (lem.ok && lem.json?.data) {
    return {
      kind: 'openai', baseUrl: base + '/api/v1', name: 'Lemonade Server', reachable: true, authOk: true, status: 200,
      answers: { ollama: tags.status, openai: v1.status, lemonade: lem.status },
      models: (lem.json.data || []).map((m) => ({ id: m.id, display: m.id })),
    };
  }
  // Reachable but not (yet) usable: report WHY instead of pretending the
  // server is not there. A reachable server that requires authentication
  // must stay visible in discovery results.
  const answers = { ollama: tags.status, openai: v1.status, lemonade: lem.status };
  const statuses = Object.values(answers).filter((s) => s > 0);
  if (statuses.length) {
    const authRequired = statuses.includes(401) || statuses.includes(403);
    // The status the UI should talk about: an auth failure outranks 404s from
    // other API paths (lemond has no /v1 or /api/tags, so those 404s are
    // expected and must not mask the 401).
    const status = statuses.includes(401) ? 401 : statuses.includes(403) ? 403 : Math.max(...statuses);
    return {
      kind: 'openai', // treated as OpenAI-compatible once authentication succeeds
      baseUrl: lem.status === 401 || lem.ok ? base + '/api/v1' : base,
      name: authRequired && lem.status === 401 ? 'Lemonade Server' : guessOpenAiName(base, lem.ok ? lem : v1),
      reachable: true,
      authRequired,
      authOk: false,
      status,
      answers,
      models: [],
      error: authRequired
        ? `Server answered with HTTP ${status} (authentication required) on its model APIs.`
        : `Server answered (HTTP ${statuses.join(', ')}) but no known models API responded with data.`,
    };
  }
  return { kind: null, baseUrl: base, name: null, reachable: false, answers, models: [] };
}

function guessOpenAiName(base, res) {
  const server = (res.headers.get('server') || '').toLowerCase();
  if (server.includes('lmstudio') || server.includes('lm-studio')) return 'LM Studio';
  if (server.includes('llama.cpp')) return 'llama.cpp server';
  if (server.includes('uvicorn')) return 'Lemonade Server (uvicorn)';
  const ids = (res.json?.data || []).map((m) => String(m.id || '')).join(' ');
  if (/localforge|llama-server|llamacpp/.test(ids)) return 'llama.cpp server';
  return 'OpenAI-compatible';
}

export async function discoverProviders(extraUrls = [], { apiKey } = {}) {
  const envKey = resolveLemonadeCredentials();
  const urls = [...new Set([...extraUrls.map(normalizeBaseUrl), ...DEFAULT_CANDIDATES])];
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const first = await probeEndpoint(u);
      if (first.reachable && first.authRequired && !first.authOk) {
        // Credential ladder: companion-resolved lemond.env key first (it lives
        // on THIS machine), then the key the user typed in the IDE.
        if (envKey && envKey !== apiKey) {
          const retry = await probeEndpoint(u, { apiKey: envKey });
          if (retry.authOk) return { ...retry, authSource: 'companion-lemond-env' };
        }
        if (apiKey) {
          const retry = await probeEndpoint(u, { apiKey });
          if (retry.authOk) return { ...retry, authSource: 'user-provided' };
        }
        // Still locked out — keep the server visible with an honest status.
        return {
          ...first,
          authSource: first.authOk ? undefined : (envKey ? 'companion-key-rejected' : (apiKey ? 'user-key-rejected' : 'no-credentials')),
        };
      }
      return first;
    } catch {
      return { kind: null, baseUrl: u, name: null, reachable: false, models: [] };
    }
  }));
  const seen = new Set();
  return results.filter((r) => r.reachable && !seen.has(r.baseUrl) && seen.add(r.baseUrl));
}

// ---- model listing ----
export async function listModels(provider) {
  const base = normalizeBaseUrl(provider.baseUrl);
  const auth = authHeaders(credentialFor(provider));
  if (provider.kind === 'ollama') {
    const r = await fetchJson(`${base}/api/tags`, { timeoutMs: 3000, headers: auth });
    if (!r.ok) throw new Error(`Ollama not reachable at ${base}: ${r.error || r.status}`);
    return (r.json.models || []).map((m) => ({
      id: m.name, display: m.name, sizeBytes: m.size || null,
      paramSize: m.details?.parameter_size || null, quant: m.details?.quantization_level || null,
    }));
  }
  // OpenAI-compatible: base may or may not already end with /v1
  const paths = [];
  if (/\/v\d+$/.test(base)) paths.push(`${base}/models`);
  paths.push(`${base}/v1/models`, `${base}/api/v1/models`, `${base}/models`);
  for (const path of paths) {
    const r = await fetchJson(path, { timeoutMs: 3000, headers: auth });
    if (r.ok && r.json?.data) return (r.json.data || []).map((m) => ({ id: m.id, display: m.id }));
    if (r.ok && Array.isArray(r.json)) return r.json.map((m) => ({ id: m.id || m, display: m.id || String(m) }));
    if (r.status === 401 || r.status === 403) {
      throw new Error(`Authentication required at ${path} (HTTP ${r.status}). The configured API key was rejected or none is configured.`);
    }
  }
  throw new Error(`No model list endpoint found at ${base} (tried ${paths.join(', ')}).`);
}

// ---- unified chat proxy ----
// Body: { provider:{kind,baseUrl,apiKey?}, model, messages, tools?, params? }
// Emits NDJSON: {t:'text',v} {t:'tool_call',id,name,args} {t:'end',finish,toolCalls,usage} {t:'error',message}
// ---- Inference timeout (0.4.4) ----
// Slow local hardware legitimately needs many minutes of PROMPT PROCESSING
// before the first byte (observed: 2–10+ min, one > 650 s). The old behavior
// inherited the runtime fetch default (Bun: 300 s, Node/undici: 300 s) and
// killed valid requests at ~305 s — reported to the user as "server
// unreachable" while Lemonade was still working. The inference timeout is
// now explicit and configurable, in this order:
//   1. params.timeoutMs            (per request, ms)
//   2. provider.chatTimeoutSec     (per provider, seconds — Settings field)
//   3. LOCALFORGE_CHAT_TIMEOUT_MS  (environment override)
//   4. DEFAULT_CHAT_TIMEOUT_MS     20 minutes
export const DEFAULT_CHAT_TIMEOUT_MS = 20 * 60 * 1000;

export function resolveChatTimeoutMs(provider, params = {}) {
  const perReq = Number(params.timeoutMs);
  if (Number.isFinite(perReq) && perReq > 0) return perReq;
  const perProvider = Number(provider?.chatTimeoutSec);
  if (Number.isFinite(perProvider) && perProvider > 0) return perProvider * 1000;
  const env = parseInt(process.env.LOCALFORGE_CHAT_TIMEOUT_MS || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_CHAT_TIMEOUT_MS;
}

// Classify a transport failure WITHOUT guessing: our deliberate timeout
// (`timedOut` flag) wins; otherwise match known disconnect signatures from
// the error itself (message, code, and the wrapped `cause` undici/Bun put
// the real error into). Everything else is 'unknown' — never reported as an
// outage when it was actually a slow-inference timeout.
export function classifyChatError(e) {
  const parts = [
    String(e?.message || ''),
    String(e?.code || ''),
    String(e?.name || ''),
    String(e?.cause?.code || e?.cause?.message || ''),
  ].join(' ');
  if (/timed?\s?out|TimeoutError/i.test(parts)) return 'timeout';
  if (/AbortError/i.test(parts)) return 'client-abort';
  if (/ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|network|fetch failed|Connect/i.test(parts)) return 'disconnect';
  return 'unknown';
}

// Upstream chat request over node:http/https (fetch replacement, 0.4.4b).
// Runtime fetch defaults are unconfigurable: Bun ignores its `timeout`
// option and kills idle requests at ~300 s (measured); Node/undici defaults
// headersTimeout/bodyTimeout to 300 s. node:http has NO default timeout, so
// the caller's AbortController (inference timer) is the single governing
// timeout. Resolves with the http.IncomingMessage once response HEADERS
// arrive; the caller consumes the body as a Node Readable.
function upstreamChatRequest(urlStr, headers, body, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const mod = urlStr.startsWith('https') ? https : http;
    const u = new URL(urlStr);
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
    }, (res) => { settled = true; resolve(res); });
    const onAbort = () => {
      const err = signal?.reason instanceof Error ? signal.reason : new Error('aborted by inference timeout');
      req.destroy(err);
      if (!settled) reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    req.end(body);
  });
}

// Bounded error-body reader for non-2xx upstream responses.
function readBodyText(res, cap = 800) {
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => { try { res.destroy(); } catch { /* ignore */ } resolve(out); }, 3000);
    res.on('data', (c) => {
      out += c.toString('utf8');
      if (out.length >= cap) { clearTimeout(timer); try { res.destroy(); } catch { /* ignore */ } resolve(out.slice(0, cap)); }
    });
    res.on('end', () => { clearTimeout(timer); resolve(out.slice(0, cap)); });
    res.on('error', () => { clearTimeout(timer); resolve(out.slice(0, cap)); });
  });
}

// Native Ollama thinking control. OpenAI-compatible servers do not get this
// field: their request shape is different and an unknown flag can fail the call.
export function applyOllamaThinking(payload, params) {
  if (!payload || !params) return payload;
  if (params.think === 'enabled') payload.think = true;
  else if (params.think === 'disabled') payload.think = false;
  return payload;
}

export async function proxyChat(body, { write, onClose }) {
  const { provider, model, messages, tools, params = {} } = body;
  if (!provider?.baseUrl) throw new ChatProxyError('Missing provider.baseUrl');
  if (!model) throw new ChatProxyError('Missing model');
  const base = normalizeBaseUrl(provider.baseUrl);
  const kind = provider.kind === 'ollama' ? 'ollama' : 'openai';
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = credentialFor(provider);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeoutMs = resolveChatTimeoutMs(provider, params);
  const ac = new AbortController();
  onClose(() => ac.abort());
  // One governing timer for the WHOLE inference (connect + prompt processing
  // + generation): fires ac.abort() and marks the failure as OUR timeout so
  // it is classified as 'timeout', never as an outage.
  let timedOut = false;
  const abortTimer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch { /* already aborted */ } }, timeoutMs);
  // Transport: node:http/https (see upstreamChatRequest) — no runtime fetch
  // defaults, so the inference timer above is the only timeout.

  let url, payload;
  let chatRouteCandidates;
  if (kind === 'ollama') {
    url = `${base}/api/chat`;
    chatRouteCandidates = [url]; // Ollama has a single, stable chat route
    payload = {
      model,
      messages: toOllamaMessages(messages),
      stream: true,
      options: {},
    };
    if (params.temperature != null) payload.options.temperature = params.temperature;
    if (params.topP != null) payload.options.top_p = params.topP;
    // Explicitly-set values only: the IDE marks numCtx/maxTokensExplicit when
    // the user changed them; untouched defaults must NOT override the model
    // server's configured context or generation budget.
    if (params.maxTokensExplicit === true && params.maxTokens != null) payload.options.num_predict = params.maxTokens;
    if (params.numCtxExplicit === true && params.numCtx != null) payload.options.num_ctx = params.numCtx;
    applyOllamaThinking(payload, params);
    if (tools?.length) {
      payload.tools = tools.map(openAiToolToOllama);
      payload.tool_choice = 'auto';
    }
  } else {
    // Model-server routing (tool-call repair mission): a base WITHOUT a
    // version suffix tries /v1 first, then /api/v1 (Lemonade/lemond shape).
    // A base that already names a versioned interface is used as-is.
    chatRouteCandidates = /\/(v\d+|api\/v\d+)$/.test(base)
      ? [`${base}/chat/completions`]
      : [`${base}/v1/chat/completions`, `${base}/api/v1/chat/completions`];
    payload = {
      model,
      messages: toOpenAiMessages(messages),
      stream: true,
    };
    if (params.temperature != null) payload.temperature = params.temperature;
    if (params.topP != null) payload.top_p = params.topP;
    if (params.maxTokensExplicit === true && params.maxTokens != null) payload.max_tokens = params.maxTokens;
    // Ollama's OpenAI route honors options.num_ctx. Send it only when the
    // user explicitly set a context, and only to an Ollama port, so a model
    // tag's own context (for example 193000) is not used and other servers
    // are left unchanged.
    if (/:11434(\/|$)/.test(base) && params.numCtxExplicit === true && params.numCtx != null) {
      payload.options = { num_ctx: params.numCtx };
    }
    if (tools?.length) {
      payload.tools = tools;
      payload.tool_choice = params.toolChoice || 'auto';
    }
  }

  let res;
  try {
    let lastRouteError = null;
    for (const candidate of chatRouteCandidates) {
      try {
        const r = await upstreamChatRequest(candidate, headers, JSON.stringify(payload), ac.signal);
        if (r.statusCode === 404 || r.statusCode === 405) {
          lastRouteError = new ChatProxyError(`Model server route ${candidate} not found (HTTP ${r.statusCode}).`, 'http-404');
          continue; // try the next interface shape
        }
        res = r;
        url = candidate;
        break;
      } catch (e) {
        if (timedOut) {
          lastRouteError = new ChatProxyError(
            `Inference timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${candidate} to respond. The model server may still be processing the request (slow hardware / long prompt / queued behind another inference). This is NOT a connection failure — raise "Inference timeout" for this provider in Settings → Providers if needed.`,
            'timeout');
        } else {
          lastRouteError = new ChatProxyError(`Cannot reach ${candidate}: ${String(e.message || e)}`, classifyChatError(e));
        }
        break; // connection-level failure — no route shape will fix it
      }
    }
    if (!res) throw lastRouteError ?? new ChatProxyError(`Cannot reach any chat interface of ${base}`, 'disconnect');
  } finally {
    // If a response stream was established, the timer stays armed for the
    // whole generation and is cleared when the stream ends (see below). Only
    // clear it here when nothing was connected yet.
    if (!res) clearTimeout(abortTimer);
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.readable) {
    const text = await readBodyText(res);
    clearTimeout(abortTimer); // the response is a terminal error — nothing left to govern
    throw new ChatProxyError(`Model server error ${res.statusCode} at ${url}: ${text}`, 'http-error');
  }

  const toolCallsAcc = new Map(); // index -> {id, name, argsStr, sawArgs}
  const ollamaToolCalls = [];
  let finish = null;
  let usage = null;

  await pipeLines(res, async (line) => {
    if (!line.trim()) return;
    let chunk = null;
    if (kind === 'ollama') {
      try { chunk = JSON.parse(line); } catch { return; }
      if (chunk.error) { write({ t: 'error', message: String(chunk.error) }); return; }
      const msg = chunk.message || {};
      if (msg.thinking) write({ t: 'thinking', v: msg.thinking });
      if (msg.content) write({ t: 'text', v: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const ollArgs = tc.function?.arguments;
          ollamaToolCalls.push({
            id: `oll_${ollamaToolCalls.length}`,
            name: tc.function?.name || '',
            // Precise Argument-State Handling: an Ollama tool call without an
            // arguments field is ABSENT — never invented into {} here.
            args: ollArgs === undefined ? undefined : ollArgs,
            argsState: ollArgs === undefined ? 'absent'
              : (ollArgs !== null && typeof ollArgs === 'object' && Object.keys(ollArgs).length === 0 ? 'empty' : 'object'),
          });
        }
      }
      if (chunk.done) {
        finish = chunk.done_reason || 'stop';
        usage = {
          promptTokens: chunk.prompt_eval_count ?? null,
          completionTokens: chunk.eval_count ?? null,
        };
      }
    } else {
      const data = line.startsWith('data:') ? line.slice(5).trim() : null;
      if (!data) return;
      if (data === '[DONE]') return;
      try { chunk = JSON.parse(data); } catch { return; }
      const choice = chunk.choices?.[0];
      if (chunk.error) { write({ t: 'error', message: String(chunk.error.message || chunk.error) }); return; }
      if (choice?.delta?.content) write({ t: 'text', v: choice.delta.content });
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolCallsAcc.get(idx) || { id: null, name: '', argsStr: '', sawArgs: false };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) {
            // Some OpenAI-compatible servers resend the FULL name in every
            // delta; concatenating duplicates corrupted the call name
            // (write_filewrite_file…). Dedupe: append only genuinely new
            // fragments (standards-conformant servers send the name once).
            acc.name = acc.name.includes(tc.function.name) ? acc.name : acc.name + tc.function.name;
          }
          // sawArgs distinguishes ABSENT (the model never sent an arguments
          // field) from EMPTY (it sent one whose fragments concatenate to '')
          if (tc.function?.arguments !== undefined) { acc.argsStr += tc.function.arguments; acc.sawArgs = true; }
          toolCallsAcc.set(idx, acc);
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? null, completionTokens: chunk.usage.completion_tokens ?? null };
    }
  }, { onStreamError: (e) => {
    // The upstream stream broke mid-generation. Distinguish honestly:
    if (timedOut) {
      throw new ChatProxyError(
        `Inference timed out after ${Math.round(timeoutMs / 1000)}s (generation still in progress). The model server may keep processing — a retry would queue a DUPLICATE request behind it. Raise "Inference timeout" for this provider in Settings → Providers and continue.`,
        'timeout');
    }
    // A deliberate abort (the requesting client went away) destroys the socket
    // in ways the raw error does not always identify as an AbortError — check
    // the signal itself instead of string-matching the failure shape.
    if (ac.signal.aborted) {
      throw new ChatProxyError('Client disconnected — inference stream closed by the requesting client.', 'client-abort');
    }
    throw new ChatProxyError(`Model server connection failed during streaming at ${url}: ${String(e?.message || e)}`, classifyChatError(e));
  } }).catch((err) => { clearTimeout(abortTimer); throw err; });

  const toolCalls = kind === 'ollama'
    ? ollamaToolCalls
    : [...toolCallsAcc.entries()].sort((a, b) => a[0] - b[0]).map(([i, a]) => {
        // Precise Argument-State Handling (transport layer):
        //   ABSENT   — no arguments field in any delta → args stays undefined
        //   EMPTY    — arguments field present but empty → args {}
        //   VALID or MALFORMED — the RAW STRING passes through untouched;
        //             the IDE parses it exactly once (with narrowly-scoped,
        //             standards-compliant recovery for invalid escapes).
        // The transport never parses-fails into {_raw} and never invents {}.
        let args, argsState;
        if (!a.sawArgs) { args = undefined; argsState = 'absent'; }
        else if (a.argsStr === '') { args = {}; argsState = 'empty'; }
        else { args = a.argsStr; argsState = 'string'; }
        return { id: a.id || `call_${i}`, name: a.name, args, argsState };
      });
  write({ t: 'end', finish: finish || 'stop', toolCalls, usage });
  clearTimeout(abortTimer); // successful completion — stop the inference timer
}

export class ChatProxyError extends Error {
  constructor(message, kind = 'unknown') {
    super(message);
    this.name = 'ChatProxyError';
    this.kind = kind; // 'timeout' | 'disconnect' | 'http-404' | 'http-error' | 'unknown'
  }
}

async function pipeLines(stream, onLine, { onStreamError } = {}) {
  const nodeStream = typeof stream.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  let buf = '';
  try {
    for await (const chunk of nodeStream) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        await onLine(line);
      }
    }
    if (buf.trim()) await onLine(buf);
  } catch (e) {
    if (onStreamError) throw onStreamError(e);
    throw e;
  }
}

function ensureV1(base) {
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

// ---- message format conversion ----
// Unified internal message: {role:'system'|'user'|'assistant'|'tool', content,
//   toolCalls?:[{id,name,args}], toolCallId?, name?}
function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId || m.name || 'tool', content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) },
        })),
      };
    }
    return { role: m.role, content: String(m.content ?? '') };
  });
}

function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', name: m.name || 'tool', content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            // History replay preserves the original payload: strings pass
            // through as strings, ABSENT stays absent (the key is omitted).
            arguments: tc.args === undefined ? undefined : tc.args,
          },
        })),
      };
    }
    return { role: m.role, content: String(m.content ?? '') };
  });
}

function openAiToolToOllama(t) {
  const f = t.function || t;
  return { type: 'function', function: { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } } };
}

// ---- model load / unload (supported where the API allows) ----
export async function loadModel(provider, model, keepAlive = '15m') {
  const base = normalizeBaseUrl(provider.baseUrl);
  if (provider.kind === 'ollama') {
    const r = await fetchJson(`${base}/api/generate`, { method: 'POST', timeoutMs: 120000, body: { model, prompt: '', keep_alive: keepAlive, stream: false } });
    if (!r.ok && r.status !== 200) return { ok: false, message: `Ollama load failed (${r.status}): ${String(r.text || '').slice(0, 300)}` };
    return { ok: true, message: `Model ${model} loaded (keep_alive=${keepAlive}).` };
  }
  if (/lmstudio/i.test(provider.name || '')) {
    const r = await fetchJson(`${base}/api/v0/load`, { method: 'POST', timeoutMs: 120000, body: { model } });
    return { ok: r.ok, message: r.ok ? `Loaded ${model} in LM Studio.` : `LM Studio load failed: ${r.status} ${String(r.text || '').slice(0, 200)}` };
  }
  return { ok: false, message: 'Load/unload is not exposed by this provider type. llama.cpp/Lemonade load models at server start.' };
}

export async function unloadModel(provider, model) {
  const base = normalizeBaseUrl(provider.baseUrl);
  if (provider.kind === 'ollama') {
    const r = await fetchJson(`${base}/api/generate`, { method: 'POST', timeoutMs: 15000, body: { model, prompt: '', keep_alive: 0, stream: false } });
    return { ok: r.ok, message: r.ok ? `Model ${model} unloaded from memory.` : `Ollama unload failed (${r.status}).` };
  }
  if (/lmstudio/i.test(provider.name || '')) {
    const r = await fetchJson(`${base}/api/v0/unload`, { method: 'POST', timeoutMs: 15000, body: { model } });
    return { ok: r.ok, message: r.ok ? `Unloaded ${model} from LM Studio.` : `LM Studio unload failed: ${r.status}` };
  }
  return { ok: false, message: 'Unload is not exposed by this provider type.' };
}

// ---- native tool-calling probe ----
const PROBE_TOOL = [{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Returns the current time. Call this when asked about time.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}];

export async function probeToolSupport(provider, model) {
  try {
    const chunks = [];
    await proxyChat({
      provider,
      model,
      messages: [{ role: 'user', content: 'Call the get_time tool now. Do not answer in text.' }],
      tools: PROBE_TOOL,
      params: { maxTokens: 200, temperature: 0 },
    }, { write: (c) => chunks.push(c), onClose: () => {} });
    const err = chunks.find((c) => c.t === 'error');
    if (err) return { nativeTools: 'no', detail: err.message?.slice(0, 300) };
    const end = chunks.find((c) => c.t === 'end');
    if (end?.toolCalls?.length) return { nativeTools: 'yes', detail: 'Model emitted a tool call in response to a probe.' };
    const text = chunks.filter((c) => c.t === 'text').map((c) => c.v).join('');
    if (text && text.length > 0) return { nativeTools: 'weak', detail: 'Model replied in text without calling the tool.' };
    return { nativeTools: 'unknown', detail: 'No conclusive response from probe.' };
  } catch (e) {
    const msg = String(e.message || e);
    if (/tool/i.test(msg)) return { nativeTools: 'no', detail: msg.slice(0, 300) };
    return { nativeTools: 'unknown', detail: msg.slice(0, 300) };
  }
}

// ---- connection test (used by IDE "Test connection" button) ----
export async function testConnection(provider, model) {
  const started = Date.now();
  try {
    const chunks = [];
    await proxyChat({
      provider, model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      params: { maxTokens: 8, temperature: 0 },
    }, { write: (c) => chunks.push(c), onClose: () => {} });
    const err = chunks.find((c) => c.t === 'error');
    if (err) return { ok: false, message: err.message };
    const text = chunks.filter((c) => c.t === 'text').map((c) => c.v).join('').trim();
    const usage = chunks.find((c) => c.t === 'end')?.usage;
    return { ok: true, latencyMs: Date.now() - started, reply: text.slice(0, 100), usage };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}
