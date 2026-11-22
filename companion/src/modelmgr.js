// LocalForge Model Manager: inventory, explicit profiles, on-demand lifecycle.
// Never starts an inference server merely because the IDE was opened.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { getState, saveState } from './config.js';
import { hardwareInventory } from './platform.js';
import { loadModel as providerLoad, unloadModel as providerUnload, listModels } from './providers.js';

const running = new Map();
function bad(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
function state() {
  const s = getState();
  if (!s.modelManager) s.modelManager = { dirs: [], profiles: [], external: [] };
  return s.modelManager;
}
function okId(id) { if (typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id)) bad('Invalid id'); return id; }
const max = (v, limit) => typeof v === 'string' && v.length > 0 && v.length <= limit;
function positive(v, name, lo = 1, hi = 100000000) {
  if (!Number.isInteger(Number(v)) || +v < lo || +v > hi) bad(`Invalid ${name}`);
  return +v;
}
function localUrl(profile) {
  let raw = profile.ollamaUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  return raw.replace(/\/$/, '').replace(/^http:\/\/0\.0\.0\.0(?=:)/, 'http://127.0.0.1');
}
async function httpJson(endpoint, opts = {}) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), opts.timeoutMs || 3000);
    try {
      const res = await fetch(endpoint, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: c.signal, redirect: 'error' });
      const json = await res.json().catch(() => null);
      return { reachable: res.ok, status: res.status, json };
    } finally { clearTimeout(t); }
  } catch { return { reachable: false, status: null, json: null }; }
}
function serverSnapshot(r) {
  const { process: _process, chunks: _chunks, byteOffset: _byteOffset, ...rest } = r;
  return { ...rest, hasDiagnostics: true };
}
function record(profile, ownership, endpoint) {
  return { id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name, backend: profile.backend,
    host: profile.host || '127.0.0.1', port: profile.port || null, endpoint,
    ownership, status: 'loading', pid: null, startedAt: Date.now(), readyAt: null, loadMs: null,
    exitCode: null, lastError: null, diagnostics: null, chunks: [], byteOffset: 0 };
}
function diagnostic(profile, command = null) {
  return { profileId: profile.id, name: profile.name, backend: profile.backend, startedAt: new Date().toISOString(),
    command, env: {}, healthAttempts: 0, healthTimeline: [], exitCode: null,
    stdoutTail: '', stderrTail: '', portBusy: false, fileMissing: false, suggestions: [] };
}
function capture(r, kind, buf) {
  const text = Buffer.from(buf).toString('utf8');
  const bytes = Buffer.byteLength(text);
  r.byteOffset += bytes;
  r.chunks.push({ start: r.byteOffset - bytes, data: text });
  let kept = r.chunks.reduce((n, x) => n + Buffer.byteLength(x.data), 0);
  while (kept > 256 * 1024 && r.chunks.length > 1) {
    kept -= Buffer.byteLength(r.chunks.shift().data);
  }
  if (r.diagnostics) {
    const key = kind === 'err' ? 'stderrTail' : 'stdoutTail';
    r.diagnostics[key] = (r.diagnostics[key] + text).slice(-8192);
  }
}
async function ollamaInfo() {
  const url = localUrl({});
  const [tags, loaded] = await Promise.all([httpJson(`${url}/api/tags`), httpJson(`${url}/api/ps`)]);
  const loadedSet = new Set((loaded.json?.models || []).map((x) => x.name));
  return { reachable: tags.reachable, url, models: (tags.json?.models || []).map((m) => ({
    name: m.name, sizeBytes: m.size || null, parameterSize: m.details?.parameter_size || null,
    quant: m.details?.quantization_level || null, state: loadedSet.has(m.name) ? 'loaded' : 'installed',
  })) };
}
function filesIn(dir, output, cap = 3000, depth = 0) {
  if (output.length >= cap || depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (output.length >= cap) break;
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) filesIn(full, output, cap, depth + 1);
    else if (e.isFile() && /\.gguf$/i.test(e.name)) {
      try { const s = fs.statSync(full); output.push({ path: full, name: e.name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString(), dir, estimatedRamBytes: Math.ceil(s.size * 1.2) }); } catch { /* removed concurrently */ }
    }
  }
}
export async function inventory() {
  const s = state();
  const [hardware, ollama] = await Promise.all([hardwareInventory(), ollamaInfo()]);
  hardware.inferenceRuntimes = [ ...(ollama.reachable ? ['ollama'] : []), ...new Set(s.profiles.map((x) => x.backend)) ];
  const gguf = [];
  for (const d of s.dirs) filesIn(d, gguf);
  const ext = await Promise.all(s.external.map(async (x) => {
    // Informational probing only; attaching does not launch or replace a server.
    const r = await httpJson(`${x.endpoint.replace(/\/$/, '')}/v1/models`, { timeoutMs: 1800 });
    return { ...x, reachable: r.reachable, state: r.reachable ? 'ready' : 'unreachable', models: (r.json?.data || []).map((m) => ({ id: m.id })) };
  }));
  const servers = [...running.values()].map(serverSnapshot);
  for (const m of ollama.models.filter((m) => m.state === 'loaded')) {
    if (!servers.some((x) => x.backend === 'ollama' && x.status === 'ready' && (x.profileName === m.name || s.profiles.some((p) => p.id === x.profileId && p.modelId === m.name)))) {
      servers.push({ id: `ollama:${m.name}`, profileId: '', profileName: m.name, backend: 'ollama', host: '127.0.0.1', port: null,
        endpoint: ollama.url, ownership: 'ollama', status: 'ready', startedAt: Date.now(), hasDiagnostics: false });
    }
  }
  return { hardware, dirs: [...s.dirs], gguf, ollama, external: ext, profiles: [...s.profiles], servers };
}
export function addDir(dir) {
  if (!max(dir, 2048)) bad('Directory path required');
  let real;
  try { real = fs.realpathSync(dir); if (!fs.statSync(real).isDirectory()) bad('Not a directory'); }
  catch { bad(`Directory does not exist: ${dir}`); }
  const s = state(); if (!s.dirs.includes(real)) s.dirs.push(real);
  saveState(); return { dirs: s.dirs };
}
export function removeDir(dir) {
  const s = state(); s.dirs = s.dirs.filter((x) => x !== dir);
  saveState(); return { dirs: s.dirs };
}
export function saveProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Invalid model profile');
  if (!max(body.name, 160) || !['llamacpp','ollama','external','foxai','openvino'].includes(body.backend)) bad('Invalid name or backend');
  const s = state();
  const id = body.id ? okId(body.id) : crypto.randomUUID();
  const old = s.profiles.find((x) => x.id === id);
  if (body.ctx !== undefined && body.ctx !== null) positive(body.ctx, 'ctx', 1, 1048576);
  for (const f of ['port', 'threads', 'parallel', 'timeoutMs']) if (body[f] !== undefined && body[f] !== null) positive(body[f], f, 1, f === 'port' ? 65535 : 2000000000);
  for (const f of ['modelPath','serverExe','modelId','endpoint','ollamaUrl','host']) if (body[f] !== undefined && body[f] !== null && (typeof body[f] !== 'string' || body[f].length > 2048)) bad(`Invalid ${f}`);
  if (body.extraArgs !== undefined && body.extraArgs !== null && !(Array.isArray(body.extraArgs) && body.extraArgs.every((x) => typeof x === 'string' && x.length < 500) && body.extraArgs.length <= 60) && !(typeof body.extraArgs === 'string' && body.extraArgs.length < 4096)) bad('Invalid extraArgs');
  const allowed = ['name','backend','modelPath','serverExe','modelId','endpoint','host','port','ctx','nPredict','threads','ngl','parallel','extraArgs','timeoutMs','toolProtocol','residency','ollamaUrl','enabled','notes'];
  const profile = { ...(old || {}), id, createdAt: old?.createdAt || new Date().toISOString() };
  for (const field of allowed) if (body[field] !== undefined) profile[field] = body[field];
  profile.updatedAt = new Date().toISOString();
  if (old) s.profiles[s.profiles.findIndex((x) => x.id === id)] = profile;
  else s.profiles.push(profile);
  saveState(); return { profile };
}
export function deleteProfile(id) {
  okId(id); const s = state();
  if ([...running.values()].some((r) => r.profileId === id && ['loading','ready'].includes(r.status))) bad('Stop the running server before deleting its profile', 409);
  const count = s.profiles.length;
  s.profiles = s.profiles.filter((x) => x.id !== id);
  saveState(); return { removed: s.profiles.length !== count };
}
export function addExternal(name, endpoint) {
  if (!max(name, 160) || !max(endpoint, 2048)) bad('Invalid endpoint');
  let parsed; try { parsed = new URL(endpoint); } catch { bad('Invalid endpoint URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) bad('Invalid endpoint URL');
  const s = state(); const ext = { id: crypto.randomUUID(), name, endpoint: parsed.origin + parsed.pathname.replace(/\/$/, ''), addedAt: new Date().toISOString() };
  s.external.push(ext); saveState(); return { endpoint: ext };
}
async function findServer(id) {
  const r = running.get(id);
  if (r) return { server: serverSnapshot(r), diagnostics: r.diagnostics };
  if (id.startsWith('ollama:')) {
    const modelId = id.slice('ollama:'.length);
    const ollama = await ollamaInfo();
    if (ollama.models.some((m) => m.name === modelId && m.state === 'loaded')) return {
      server: { id, profileId: '', profileName: modelId, backend: 'ollama', host: '127.0.0.1', port: null,
        endpoint: ollama.url, ownership: 'ollama', status: 'ready', startedAt: 0, hasDiagnostics: false }, diagnostics: null,
    };
  }
  bad('Unknown model server', 404);
}
export async function status(id) { return { server: (await findServer(id)).server }; }
export async function diagnostics(id) { return await findServer(id); }
export function output(id, since) {
  if (id.startsWith('ollama:') && !running.has(id)) {
    return { proc: { id, status: 'external', exitCode: null }, output: '', byteOffset: 0 };
  }
  const s = running.get(id); if (!s) bad('Unknown managed server', 404);
  const pos = Number(since); if (!Number.isInteger(pos) || pos < 0) bad('Invalid byte offset');
  const text = s.chunks.filter((x) => x.start + Buffer.byteLength(x.data) > pos).map((x) => {
    const skip = Math.max(0, pos - x.start); return Buffer.from(x.data).subarray(skip).toString('utf8');
  }).join('');
  return { proc: { id: s.id, status: s.status, exitCode: s.exitCode }, output: text, byteOffset: s.byteOffset };
}
function profileById(id) { const p = state().profiles.find((x) => x.id === id); if (!p) bad('Unknown model profile', 404); return p; }
function parseArgs(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  // Quoted arguments are supported, never evaluated by a shell.
  return String(v).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => /^['"]/.test(s) ? s.slice(1,-1) : s) || [];
}
export async function loadProfile(id) {
  const p = profileById(id);
  const existing = [...running.values()].find((r) => r.profileId === id && ['loading','ready'].includes(r.status));
  if (existing) return { server: serverSnapshot(existing), existingServerId: existing.id };
  if (p.backend === 'external' || p.backend === 'foxai' || p.backend === 'openvino') {
    return { unsupported: true, attachable: !!p.endpoint, error: 'This backend is attach-only: start it with its own server manager, then connect to its endpoint.' };
  }
  if (p.backend === 'ollama') {
    if (!p.modelId) bad('Ollama profile needs modelId');
    const endpoint = localUrl(p);
    const res = await providerLoad({ kind: 'ollama', baseUrl: endpoint }, p.modelId, p.residency === 'keep-loaded' ? '-1' : '15m');
    if (!res.ok) return { error: res.message, status: 502 };
    const r = record(p, 'ollama', endpoint); r.status = 'ready'; r.readyAt = Date.now(); r.loadMs = r.readyAt - r.startedAt;
    r.profileName = p.name; running.set(r.id, r); return { server: serverSnapshot(r) };
  }
  if (p.backend !== 'llamacpp') return { unsupported: true, error: 'Backend not implemented' };
  if (!p.serverExe || !p.modelPath || !p.port) bad('llama.cpp profile requires serverExe, modelPath and port');
  if (!fs.existsSync(p.serverExe) || !fs.existsSync(p.modelPath)) return { error: 'Server executable or GGUF model missing', diagnostics: { ...diagnostic(p), fileMissing: true }, status: 400 };
  const host = p.host || '127.0.0.1';
  if (!/^[\da-zA-Z.:-]{1,253}$/.test(host)) bad('Invalid host');
  const port = positive(p.port, 'port', 1, 65535);
  const endpoint = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const argv = ['--model', p.modelPath, '--host', host, '--port', String(port)];
  if (p.ctx != null) argv.push('--ctx-size', String(p.ctx));
  if (p.nPredict != null) argv.push('--n-predict', String(p.nPredict));
  if (p.threads != null) argv.push('--threads', String(p.threads));
  if (p.ngl != null) argv.push('--n-gpu-layers', String(p.ngl));
  if (p.parallel != null) argv.push('--parallel', String(p.parallel));
  argv.push(...parseArgs(p.extraArgs));
  const r = record(p, 'localforge-managed', endpoint);
  r.host = host; r.port = port;
  r.diagnostics = diagnostic(p, [p.serverExe, ...argv].map((s) => JSON.stringify(s)).join(' '));
  running.set(r.id, r);
  try {
    const proc = spawn(p.serverExe, argv, { cwd: path.dirname(p.serverExe), stdio: ['ignore','pipe','pipe'], windowsHide: true, shell: false });
    r.process = proc; r.pid = proc.pid;
    proc.stdout?.on('data', (d) => capture(r,'out',d));
    proc.stderr?.on('data', (d) => capture(r,'err',d));
    proc.on('error', (e) => { r.status = 'failed'; r.lastError = String(e.message); r.diagnostics.suggestions.push(String(e.message)); });
    proc.on('close', (code) => { r.exitCode = code; r.diagnostics.exitCode = code; if (r.status !== 'stopped') r.status = code === 0 ? 'exited' : 'failed'; });
  } catch(e) { r.status = 'failed'; r.lastError = String(e.message); return { server: serverSnapshot(r), diagnostics: r.diagnostics, error: r.lastError }; }
  // Give slow-loading local models their full configured startup window.
  const timeout = p.timeoutMs || 5 * 60_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && r.status === 'loading') {
    const response = await httpJson(`${endpoint}/health`, { timeoutMs: 2000 });
    r.diagnostics.healthAttempts++;
    if (r.diagnostics.healthTimeline.length < 100) r.diagnostics.healthTimeline.push({ at: Date.now(), status: response.status || 0, body: response.json ? JSON.stringify(response.json).slice(0,300) : '' });
    if (response.reachable && response.json?.status !== 'loading model') { r.status = 'ready'; r.readyAt = Date.now(); r.loadMs = r.readyAt-r.startedAt; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (r.status === 'loading') { r.status = 'failed'; r.lastError = `Model startup exceeded configured timeout (${timeout} ms)`; r.diagnostics.suggestions.push(r.lastError); try { r.process?.kill(); } catch { /* already exited */ } }
  return { server: serverSnapshot(r), diagnostics: r.diagnostics, ...(r.status !== 'ready' ? { error: r.lastError || 'Model process exited during startup' } : {}) };
}
export async function unloadProfile(body) {
  const r = body.serverId ? running.get(okId(body.serverId)) : [...running.values()].find((x) => x.profileId === body.profileId && x.status === 'ready');
  if (!r) return { error: 'Managed server not found', status: 404 };
  if (r.ownership === 'ollama') {
    const p = profileById(r.profileId);
    const response = await providerUnload({ kind: 'ollama', baseUrl: r.endpoint }, p.modelId);
    if (!response.ok) return { error: response.message, status: 502 };
    r.status = 'stopped'; return { server: serverSnapshot(r) };
  }
  if (r.ownership !== 'localforge-managed') return { unsupported: true, error: 'Cannot stop a server that LocalForge does not own' };
  if (r.process && r.status !== 'stopped') { r.status = 'stopped'; r.process.kill(); }
  return { server: serverSnapshot(r) };
}
export function stopManagedModels() {
  for (const r of running.values()) if (r.ownership === 'localforge-managed' && r.process && ['loading','ready'].includes(r.status)) {
    r.status = 'stopped'; try { r.process.kill(); } catch { /* best effort */ }
  }
}
