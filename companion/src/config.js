// LocalForge companion — configuration, persistent state, logging.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VERSION = '0.4.5';

// Node, Bun, and compiled executable launchers can include different numbers
// of runtime/entry-point arguments. Scan every argv item after argv[0] for
// known flags instead of guessing whether options start at index 1, 2, or 3.
// Non-option arguments are ignored as before.
export function parseArgs(argv) {
  const out = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--show-code') out.showCode = true;
    else if (a === '--lan') out.lan = true;
    else if (a === '--no-mdns') out.noMdns = true;
    else if (a === '--no-browser-hint') out.noHint = true;
    // Tray/installer integration: keep a small JSON status file (port, pid,
    // pairing code, workspaces, devices) next to the state dir so a GUI can
    // display it without scraping the console. Local-machine secret only.
    else if (a === '--status-file') out.statusFile = argv[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (process.env.LOCALFORGE_CI_ARGV_TRACE === '1') {
  console.log('[localforge-ci-cli-flags]', JSON.stringify(process.argv.map((s, i) => ({
    position: i, flag: typeof s === 'string' && s.startsWith('--') ? s : null,
  }))));
}

export const config = {
  home: args.home || process.env.LOCALFORGE_HOME || defaultHome(),
  port: args.port !== undefined ? args.port : (process.env.LOCALFORGE_PORT ? Number(process.env.LOCALFORGE_PORT) : 7337),
  host: args.host || process.env.LOCALFORGE_HOST || '127.0.0.1',
  lan: args.lan || false,
  workspace: args.workspace || null,
  showCode: !!args.showCode,
  statusFile: args.statusFile || null,
  help: !!args.help,
  noMdns: !!args.noMdns,
};

// Windows installers put per-user app data in %LOCALAPPDATA%; keep the POSIX
// default unchanged for macOS/Linux and developer use.
function defaultHome() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'LocalForgeCompanion');
  }
  return path.join(os.homedir(), '.localforge-companion');
}

export async function ensureHome() {
  await fsp.mkdir(config.home, { recursive: true });
  await fsp.mkdir(path.join(config.home, 'logs'), { recursive: true });
}

const stateFile = () => path.join(config.home, 'state.json');

// state: { pairingCode, tokens: [{tokenHash,label,createdAt}], workspaces: [{id,path,name,previewDir}] }
let state = null;
const startedAt = new Date().toISOString();

export function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = { pairingCode: null, tokens: [], workspaces: [] };
  }
  if (!state.tokens) state.tokens = [];
  if (!state.workspaces) state.workspaces = [];
  if (!state.pairingCode) state.pairingCode = newPairingCode();
  // One-time migration: tokens stored as plaintext by companion <=0.1.0 are
  // replaced by their SHA-256 hashes (raw token never persisted at rest).
  let migrated = false;
  for (const t of state.tokens) {
    if (t.token && !t.tokenHash) {
      t.tokenHash = hashToken(t.token);
      delete t.token;
      migrated = true;
    }
  }
  if (migrated) log('tokens_migrated', { count: state.tokens.length });
  saveState();
  writeStatus();
  return state;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function saveState() {
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile());
  writeStatus();
}

export function getState() {
  return state;
}

// Best-effort JSON status file for the Windows tray GUI. Never blocks or
// crashes the companion: failures are logged and swallowed.
export function writeStatus(extra = {}) {
  if (!config.statusFile || !state) return;
  try {
    const payload = {
      pid: process.pid,
      version: VERSION,
      platform: process.platform,
      host: config.host,
      port: config.port,
      url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`,
      pairingCode: state.pairingCode,
      startedAt: startedAt,
      workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
      devices: state.tokens.map((t) => ({ label: t.label, pairedAt: t.createdAt })),
      ...extra,
    };
    const tmp = config.statusFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, config.statusFile);
  } catch (e) {
    try { log('status_write_failed', { message: String(e && e.message) }); } catch { /* ignore */ }
  }
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
export function newPairingCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += B32[b % B32.length];
  return s.slice(0, 8);
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Diagnostic seam (documented in tests): LF_REPORT_PLATFORM lets a Linux CI
// host honestly report 'win32'/'darwin' through the REPORTING routes only —
// shell selection, exec and FS behavior always use the real process.platform.
export function reportPlatform() {
  const r = String(process.env.LF_REPORT_PLATFORM || '').toLowerCase().trim();
  return ['linux', 'win32', 'darwin'].includes(r) ? r : process.platform;
}

export function resetPairingCode() {
  state.pairingCode = newPairingCode();
  saveState();
  return state.pairingCode;
}

// ---- token auth ----
// Tokens are stored only as SHA-256 hashes; the raw bearer token exists in
// memory at mint time and on the paired browser, never on this disk.
export function isTokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  const h = hashToken(token);
  return state.tokens.some((t) => t.tokenHash === h);
}

export function addToken(label) {
  const token = newToken();
  state.tokens.push({ tokenHash: hashToken(token), label: label || 'device', createdAt: new Date().toISOString() });
  // keep at most 20 tokens
  while (state.tokens.length > 20) state.tokens.shift();
  saveState();
  return token;
}

// ---- workspaces ----
export function workspaceId(realPath) {
  return crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 12);
}

export function findWorkspace(id) {
  return state.workspaces.find((w) => w.id === id) || null;
}

export function upsertWorkspace(realPath, name) {
  const id = workspaceId(realPath);
  const existing = state.workspaces.find((w) => w.id === id);
  if (existing) {
    existing.lastOpenedAt = new Date().toISOString();
    saveState();
    return existing;
  }
  const ws = {
    id,
    path: realPath,
    name: name || path.basename(realPath),
    previewDir: '.',
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
  state.workspaces.push(ws);
  if (state.workspaces.length > 50) state.workspaces.shift();
  saveState();
  return ws;
}

export function removeWorkspace(id) {
  const before = state.workspaces.length;
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  saveState();
  return state.workspaces.length < before;
}

// ---- structured local log (JSONL, no prompt/file content) ----
// The stream is created lazily with a crash-proof error handler: a full disk
// or missing directory must never take the companion down.
let logStream = null;
export function log(event, data = {}) {
  try {
    const rec = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    if (!logStream || logStream.destroyed) {
      try { fs.mkdirSync(path.join(config.home, 'logs'), { recursive: true }); } catch { /* ignore */ }
      const day = new Date().toISOString().slice(0, 10);
      logStream = fs.createWriteStream(path.join(config.home, `logs/companion-${day}.log`), { flags: 'a' });
      logStream.on('error', () => { try { logStream.destroy(); } catch { /* ignore */ } logStream = null; });
    }
    if (logStream) logStream.write(rec + '\n');
    if (process.env.LOCALFORGE_VERBOSE) console.log(rec);
  } catch { /* logging must never crash the companion */ }
}
