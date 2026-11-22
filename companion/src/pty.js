// Real PTY terminal sessions (Milestone 1).
//
// `node-pty` is an OPTIONAL dependency: when it is installed the companion
// offers genuine interactive terminal sessions (interactive shells, REPLs,
// vim, htop, correct ANSI handling, resize, shell signal handling, persistent
// environment within a session). When it is missing — e.g. inside the
// standalone compiled binary that cannot bundle native modules — every PTY
// endpoint degrades with an explicit `unavailable` payload and the existing
// NDJSON streaming-shell terminal keeps working unchanged.
//
// Design notes:
//  - sessions are persistent: the shell keeps running between commands, so
//    cd, exported environment variables and shell state survive (this is the
//    whole point vs. the per-command streaming shell).
//  - output is broadcast to every attached subscriber AND kept in a bounded
//    scrollback ring so a UI reconnect replays what it missed.
//  - Ctrl+C / Ctrl+Z are ordinary input bytes (\x03 / \x1a) processed by the
//    tty line discipline — no special casing needed in a real PTY.
//  - lifecycle: hard cap on live sessions (LRU-evict oldest idle), full
//    process-tree kill on stop/exit, everything reaped on shutdown.
import path from 'node:path';
import { config, findWorkspace } from './config.js';
import { log } from './config.js';

// Optional dependency, loaded lazily like `ws` in server.js.
let pty = null;
let ptyLoadError = null;
try {
  pty = (await import('node-pty')).default ?? (await import('node-pty'));
} catch (e) {
  ptyLoadError = String(e?.message || e).slice(0, 200);
}

const SCROLLBACK_BYTES = 256 * 1024;
const MAX_SESSIONS = 12;
const EXIT_GRACE_MS = 5_000; // keep exited session records briefly for late subscribers

function unavailablePayload() {
  return {
    available: false,
    backend: 'unavailable',
    reason: ptyLoadError
      ? `node-pty is not available in this companion (${ptyLoadError}). The NDJSON streaming terminal remains fully functional.`
      : 'node-pty is not installed. Install it with: npm i @localforge/companion (node-pty ships as an optional dependency), or keep using the NDJSON streaming terminal.',
    fallback: 'ndjson-stream',
  };
}

export function ptyCapabilities() {
  if (!pty) return unavailablePayload();
  return {
    available: true,
    backend: 'node-pty',
    fallback: 'ndjson-stream',
  };
}

function defaultShell(platform) {
  if (platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function shellArgs(platform, shell) {
  if (platform === 'win32') return []; // ConPTY launches the shell directly
  // Login shell so .profile/.bashrc run: PATH, nvm, pyenv behave like a real terminal.
  return shell === defaultShell(platform) ? ['-l'] : [];
}

const sessions = new Map(); // sessionId -> record

function sessionListPayload(rec) {
  return {
    sessionId: rec.id,
    workspaceId: rec.workspaceId,
    cwd: rec.cwd,
    shell: rec.shell,
    platform: rec.platform,
    cols: rec.cols,
    rows: rec.rows,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    exited: rec.exited,
    exitCode: rec.exitCode,
    subscribers: rec.subscribers.size,
  };
}

function broadcast(rec, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of rec.subscribers) {
    try { res.write(frame); } catch { rec.subscribers.delete(res); }
  }
}

function evictIfNeeded() {
  const live = [...sessions.values()].filter((r) => !r.exited);
  if (live.length < MAX_SESSIONS) return;
  live.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const r of live.slice(0, live.length - MAX_SESSIONS + 1)) {
    try { stopSession(r.id); } catch { /* ignore */ }
  }
}

function killTree(pid) {
  if (!pid) return;
  import('node:child_process').then(({ spawn }) => {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    // node-pty spawns the shell as a session/process-group leader on POSIX.
    try { process.kill(-pid, 'SIGHUP'); } catch { try { process.kill(pid, 'SIGHUP'); } catch { /* already gone */ } }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }, 800).unref?.();
  }).catch(() => {});
}

export function startSession(wsId, { cols = 80, rows = 24, cwd = '.', shell } = {}) {
  if (!pty) {
    const e = new Error(unavailablePayload().reason);
    e.status = 501;
    e.payload = unavailablePayload();
    throw e;
  }
  const ws = findWorkspace(wsId);
  if (!ws) { const e = new Error(`Unknown workspace: ${wsId}`); e.status = 404; throw e; }

  // cwd is jailed to the workspace root (same policy as every fs/exec route).
  let startDir = ws.path;
  if (cwd && cwd !== '.' && cwd !== './') {
    const abs = path.resolve(ws.path, String(cwd));
    if (abs !== ws.path && !abs.startsWith(ws.path + path.sep)) {
      const e = new Error('cwd escapes the authorized workspace.'); e.status = 400; throw e;
    }
    startDir = abs;
  }

  evictIfNeeded();

  const platform = process.platform;
  const sh = shell || defaultShell(platform);
  const record = {
    id: `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: wsId,
    shell: sh,
    platform,
    cwd: cwd && cwd !== '.' ? String(cwd) : '.',
    cols: Math.min(Math.max(Number(cols) || 80, 2), 500),
    rows: Math.min(Math.max(Number(rows) || 24, 2), 300),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    subscribers: new Set(),
    scrollback: [],
    scrollbackBytes: 0,
    exited: false,
    exitCode: null,
  };
  sessions.set(record.id, record);

  try {
    const term = pty.spawn(sh, shellArgs(platform, sh), {
      name: 'xterm-256color',
      cols: record.cols,
      rows: record.rows,
      cwd: startDir,
      env: buildPtyEnv(),
      // Windows: ConPTY (default on Win10+). handleFlowControl not needed at our scale.
      useConpty: platform === 'win32' ? true : undefined,
    });
    record.pty = term;
    term.onData((data) => {
      record.lastUsedAt = Date.now();
      pushScrollback(record, data);
      broadcast(record, { t: 'out', sessionId: record.id, d: data });
    });
    term.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitCode = typeof exitCode === 'number' ? exitCode : (exitCode?.code ?? null);
      broadcast(record, { t: 'exit', sessionId: record.id, code: record.exitCode });
      log('pty_exit', { sessionId: record.id, code: record.exitCode });
      for (const res of record.subscribers) { try { res.end(); } catch { /* ignore */ } }
      record.subscribers.clear();
      setTimeout(() => { if (record.exited) sessions.delete(record.id); }, EXIT_GRACE_MS).unref?.();
    });
    log('pty_start', { sessionId: record.id, wsId, shell: sh, platform });
    return { sessionId: record.id, shell: sh, cwd: record.cwd, cols: record.cols, rows: record.rows, backend: 'node-pty' };
  } catch (e) {
    sessions.delete(record.id);
    const err = new Error(`Failed to start PTY shell "${sh}": ${String(e?.message || e)}`);
    err.status = 500;
    throw err;
  }
}

function buildPtyEnv() {
  // A real terminal env: colors on, TERM set, no forced PAGER overrides — the
  // existing batch-exec env hardening (buildExecEnv) intentionally stays for
  // agent commands; interactive users get a normal shell experience.
  const env = { ...process.env };
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}

function pushScrollback(rec, data) {
  rec.scrollback.push(data);
  rec.scrollbackBytes += Buffer.byteLength(data);
  while (rec.scrollbackBytes > SCROLLBACK_BYTES && rec.scrollback.length > 1) {
    const dropped = rec.scrollback.shift();
    rec.scrollbackBytes -= Buffer.byteLength(dropped);
  }
}

export function getSession(sessionId) {
  return sessions.get(String(sessionId)) || null;
}

export function writeInput(sessionId, data) {
  const rec = sessions.get(String(sessionId));
  if (!rec || rec.exited) return false;
  if (typeof data !== 'string' || !data) return false;
  rec.lastUsedAt = Date.now();
  try { rec.pty.write(data); return true; } catch { return false; }
}

export function resizeSession(sessionId, cols, rows) {
  const rec = sessions.get(String(sessionId));
  if (!rec || rec.exited) return false;
  const c = Math.min(Math.max(Number(cols) || rec.cols, 2), 500);
  const r = Math.min(Math.max(Number(rows) || rec.rows, 2), 300);
  try { rec.pty.resize(c, r); rec.cols = c; rec.rows = r; return true; } catch { return false; }
}

// Signals beyond the line-discipline bytes (Ctrl+C=\x03, Ctrl+Z=\x1a are input).
export function signalSession(sessionId, signal = 'SIGINT') {
  const rec = sessions.get(String(sessionId));
  if (!rec || rec.exited) return false;
  const allowed = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGTSTP', 'SIGCONT', 'SIGQUIT'];
  if (!allowed.includes(signal)) { const e = new Error(`Signal not allowed: ${signal}`); e.status = 400; throw e; }
  try {
    rec.pty.kill?.(signal);
    if (signal === 'SIGKILL') { rec.exited = true; }
    return true;
  } catch { return false; }
}

export function stopSession(sessionId) {
  const rec = sessions.get(String(sessionId));
  if (!rec) return false;
  try { rec.pty?.kill?.('SIGHUP'); } catch { /* ignore */ }
  killTree(rec.pty?.pid);
  try { rec.pty?.kill?.('SIGKILL'); } catch { /* ignore */ }
  sessions.delete(sessionId);
  log('pty_stop', { sessionId });
  return true;
}

export function scrollback(sessionId) {
  const rec = sessions.get(String(sessionId));
  if (!rec) return null;
  return { sessionId: rec.id, data: rec.scrollback.join(''), truncatedBytes: rec.scrollbackBytes > SCROLLBACK_BYTES ? rec.scrollbackBytes - SCROLLBACK_BYTES : 0, exited: rec.exited };
}

export function listSessions(workspaceId) {
  const out = [];
  for (const rec of sessions.values()) {
    if (workspaceId && rec.workspaceId !== workspaceId) continue;
    out.push(sessionListPayload(rec));
  }
  return out;
}

export function attachSubscriber(sessionId, res) {
  const rec = sessions.get(String(sessionId));
  if (!rec) { const e = new Error('Unknown PTY session'); e.status = 404; throw e; }
  rec.subscribers.add(res);
  rec.lastUsedAt = Date.now();
  res.on('close', () => { rec.subscribers.delete(res); });
  return rec;
}

// Shutdown: reap every PTY child so a stopped companion leaves no shells.
export function stopAllSessions() {
  let killed = 0;
  for (const [id, rec] of sessions) {
    try { rec.pty?.kill?.('SIGHUP'); } catch { /* ignore */ }
    killTree(rec.pty?.pid);
    killed++;
  }
  sessions.clear();
  return killed;
}

export { sessions as ptySessions };
