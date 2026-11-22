// Detached process manager (spec §3.5): starts GUI/desktop applications and
// long-running servers WITHOUT waiting for them to exit, tracks their real
// lifecycle (running / exited / stopped / failed), keeps a bounded output
// ring buffer, and stops whole process trees on request.
//
// Rationale (real-world test evidence, docs/HARNESS_UPGRADE.md): launching a
// Tkinter app through the blocking exec path held the agent for ~19 minutes
// and ended in "exit code: null (TIMED OUT)" even though the app was running
// fine. Starting a GUI is not the same as waiting for its event loop.
import { spawn } from 'node:child_process';
import { shellWrap, shellBin, buildExecEnv, killPidTree } from './exec.js';

const OUTPUT_CAP = 256 * 1024; // tail ring buffer per process
const KEEP_HISTORY = 100;      // remember the last N processes for accurate reports

const procs = new Map(); // id -> record

export function startProc({ cmd, cwd }) {
  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id,
    cmd: String(cmd),
    cwd: cwd || null,
    pid: null,
    status: 'running', // running | exited | stopped | failed
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    durMs: null,
    spawnError: null,
    buf: [],
    bufLen: 0,
    truncated: false,
    killedByUs: false,
  };
  let child;
  try {
    child = spawn(shellBin(), shellWrap(String(cmd)), {
      cwd: cwd || undefined,
      env: buildExecEnv(),
      detached: true, // own process group (POSIX) / detached console (Windows)
      windowsHide: true, // hide the wrapper console; GUI windows still appear
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    rec.status = 'failed';
    rec.spawnError = String(e.message || e);
    rec.endedAt = Date.now();
    rec.durMs = 0;
    return rec;
  }
  rec.pid = child.pid ?? null;
  const append = (buf, data) => {
    if (rec.bufLen >= OUTPUT_CAP) { rec.truncated = true; return; }
    rec.buf.push(data);
    rec.bufLen += data.length;
    if (rec.bufLen > OUTPUT_CAP) { rec.truncated = true; }
  };
  child.stdout.on('data', (d) => append('out', d));
  child.stderr.on('data', (d) => append('err', d));
  child.on('error', (e) => {
    rec.status = 'failed';
    rec.spawnError = String(e.message || e);
    rec.endedAt = Date.now();
    rec.durMs = rec.endedAt - rec.startedAt;
  });
  child.on('close', (code) => {
    // The wrapper shell's own exit code is 0 (printf runs last); the REAL
    // child exit code arrives via the __LF_EOF marker, same as exec.js.
    let exitCode = code;
    const text = Buffer.concat(rec.buf).toString('utf8');
    const lines = text.split('\n').filter((l) => l.startsWith('__LF_EOF'));
    if (lines.length) {
      const last = lines[lines.length - 1].trim();
      const m = last.match(/^__LF_EOF\s+(.+?)\s+(-?\d+)$/);
      if (m) exitCode = Number(m[2]);
    }
    // strip marker lines from the stored output (tools must not see them)
    if (lines.length) {
      const cleaned = text.split('\n').filter((l) => !l.startsWith('__LF_EOF')).join('\n');
      rec.buf = [Buffer.from(cleaned, 'utf8')];
      rec.bufLen = Buffer.byteLength(cleaned, 'utf8');
    }
    rec.exitCode = exitCode;
    rec.endedAt = Date.now();
    rec.durMs = rec.endedAt - rec.startedAt;
    // A window being closed is a normal outcome, not a failure.
    rec.status = rec.killedByUs ? 'stopped' : 'exited';
  });
  procs.set(id, rec);
  trimHistory();
  // NOTE: return the live record (not a snapshot) so callers polling the
  // object see the real lifecycle; HTTP handlers serialize via snapshot().
  return rec;
}

function trimHistory() {
  const running = [...procs.entries()].filter(([, r]) => r.status === 'running');
  const done = [...procs.entries()]
    .filter(([, r]) => r.status !== 'running')
    .sort((a, b) => (b[1].endedAt || 0) - (a[1].endedAt || 0));
  for (const [id] of done.slice(KEEP_HISTORY)) procs.delete(id);
  if (running.length > 50) {
    for (const [id, r] of running.sort((a, b) => a[1].startedAt - b[1].startedAt).slice(0, running.length - 50)) {
      try { killPidTree(r.pid); } catch { /* ignore */ }
      procs.delete(id);
    }
  }
}

function snapshot(rec) {
  return {
    id: rec.id,
    pid: rec.pid,
    cmd: rec.cmd,
    cwd: rec.cwd,
    status: rec.status,
    exitCode: rec.exitCode,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durMs: rec.durMs,
    spawnError: rec.spawnError,
    outputBytes: rec.bufLen,
    truncated: rec.truncated,
  };
}

export function listProcs() {
  return [...procs.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot);
}

export function procOutput(id, sinceBytes = 0) {
  const rec = procs.get(String(id || ''));
  if (!rec) return null;
  let out = '';
  if (rec.bufLen > sinceBytes && sinceBytes >= 0) {
    let acc = 0;
    const parts = [];
    for (const chunk of rec.buf) {
      const start = Math.max(0, sinceBytes - acc);
      if (start < chunk.length) parts.push(chunk.subarray(start));
      acc += chunk.length;
      if (acc >= sinceBytes) break;
    }
    out = Buffer.concat(parts).toString('utf8');
  }
  return { proc: snapshot(rec), output: out, outputBytes: rec.bufLen };
}

export async function stopProc(id) {
  const rec = procs.get(String(id || ''));
  if (!rec) return null;
  if (rec.status === 'running') {
    rec.killedByUs = true;
    const ok = killPidTree(rec.pid);
    if (!ok) rec.killedByUs = false;
    // the close handler records the real exit code and final status
    await new Promise((r) => setTimeout(r, 250));
    if (rec.status === 'running') {
      // grace period elapsed without close — report it as still running
      rec.killedByUs = false;
    }
  }
  return snapshot(rec);
}

export function stopAllProcs() {
  let n = 0;
  for (const rec of procs.values()) {
    if (rec.status === 'running') {
      rec.killedByUs = true;
      try { killPidTree(rec.pid); n++; } catch { /* ignore */ }
    }
  }
  return n;
}
