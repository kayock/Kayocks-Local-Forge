// Command execution: batch exec (for agent builds/tests) and streaming runs
// (for the interactive terminal). Defense-in-depth command screening: a hard
// deny list (never runs) and a confirm list (runs only with explicit user
// confirmation passed as confirm:true after UI approval).
import { spawn } from 'node:child_process';
import path from 'node:path';

const OUTPUT_CAP = 400 * 1024; // per stream
const DEFAULT_TIMEOUT = 180_000;
const MAX_TIMEOUT = 600_000;

// ---- complete-command-log ring (Milestone 1) ----
// Tool results are intelligently truncated for the model, but nothing should
// be lost for the human: the full stdout/stderr of recent commands is kept in
// a bounded ring and served at GET /api/ws/<id>/exec/log?id=...
const FULL_LOG_CAP = 2 * 1024 * 1024;   // per exec
const EXEC_LOG_HISTORY = 20;
const execLogs = new Map(); // execId -> { id, cmd, cwd, exitCode, timedOut, durMs, createdAt, stdout, stderr, truncated }
let execSeq = 0;

function recordExecLog(info) {
  const id = `exec_${Date.now().toString(36)}_${++execSeq}`;
  const rec = { id, ...info };
  execLogs.set(id, rec);
  while (execLogs.size > EXEC_LOG_HISTORY) {
    execLogs.delete(execLogs.keys().next().value);
  }
  return id;
}

export function getExecLog(id) {
  return execLogs.get(String(id)) || null;
}
export { recordExecLog, FULL_LOG_CAP };

// Never executes, regardless of confirm.
const HARD_DENY = [
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
  // rm -rf / (also inside a wrapper shell) — the root may be followed by a
  // closing quote or command separator (sh -c "rm -rf /"), not only whitespace.
  /\b(?:ba|z|fi|da)?sh\s+-c\s+['"]?.*\brm\s+-[a-z]*r[a-z]*f?\s+\/["';&|]?(\s|$)/,
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/["';&|]?(\s|$)/,
  /\bchmod\s+-R\s+777\s+\/["']?(\s|$)/,
];

// Executes only when the request carries confirm:true (UI-level approval).
const NEEDS_CONFIRM = [
  /\bsudo\b/,
  /\bsu\s+-?\s*\w*/,
  /\brm\s+(?=[^|;&]*-[a-z]*[rf])[a-z\- ]*\s+(\/|~|\$HOME|\*)(\s|$)/, // rm -r/-f on home or root
  /\brm\s+-[a-z]*r[a-z]*f?[^&|;]*\s+(\/|~)(\/|\s|$)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/,
  /\bwget\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/,
  /\bnc\b\s+-l/,
  /\bmktemp\b.*\|\s*(ba)?sh/,
  /\bgit\s+push\s+.*--force/,
  /\bdiskutil\b/,
  /\breg\s+(add|delete)\b/i,
  /\bRemove-Item\b.*-Recurse.*-Force/i,
  /\bformat\b.*:/i,
];

export function screenCommand(cmd, { confirm = false } = {}) {
  const c = String(cmd || '');
  for (const re of HARD_DENY) {
    if (re.test(c)) return { allowed: false, reason: 'This command is on the companion hard-deny list and cannot be run.', needsConfirm: false };
  }
  for (const re of NEEDS_CONFIRM) {
    if (re.test(c)) {
      if (!confirm) return { allowed: false, reason: 'Potentially destructive command requires explicit confirmation.', needsConfirm: true };
      return { allowed: true, flagged: true };
    }
  }
  return { allowed: true };
}

function shellWrap(cmd) {
  if (process.platform === 'win32') {
    // %CD% reflects cd changes within the same invocation
    return ['/d', '/s', '/c', `${cmd} & call echo __LF_EOF %%CD%% %%errorlevel%%`];
  }
  return [
    '-lc',
    `{ ${cmd}\n} ; __LF_RC=$? ; printf '\n__LF_EOF %s %s' "$(pwd | tr -d '\\n' | base64 | tr -d '\\n')" "$__LF_RC"`,
  ];
}

const shellBin = () => (process.platform === 'win32' ? 'cmd.exe' : 'bash');
export { shellWrap, shellBin };

export function buildExecEnv() {
  const env = { ...process.env };
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PAGER = 'cat';
  env.GIT_PAGER = 'cat';
  env.TERM = 'dumb';
  return env;
}

// Runs a command. onChunk(stream, data) receives 'out'/'err' as it arrives.
// If a registry is given, the child registers under sessionId so callers can
// interrupt (Ctrl+C) it while running.
// Returns { exitCode, timedOut, cwd, durMs, truncatedOut, truncatedErr }.
export function runCommand({ cmd, cwd, timeoutMs, onChunk, sessionId, registry }) {
  return new Promise((resolve) => {
    const t = Math.min(Math.max(timeoutMs || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
    const args = shellWrap(cmd);
    const child = spawn(shellBin(), args, {
      cwd: cwd || undefined,
      env: buildExecEnv(),
      detached: process.platform !== 'win32', // own process group for clean kills
    });
    if (registry && sessionId) registry.set(sessionId, child);

    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let outTrunc = false;
    let errTrunc = false;
    const started = Date.now();
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, t);
    let timedOut = false;

    const collect = (buf, data, wasTrunc) => {
      let b = buf;
      let trunc = wasTrunc;
      if (b.length < OUTPUT_CAP) {
        const room = OUTPUT_CAP - b.length;
        b = Buffer.concat([b, data.subarray(0, room)]);
        if (data.length > room) trunc = true;
      } else trunc = true;
      return [b, trunc];
    };

    child.stdout.on('data', (d) => {
      [out, outTrunc] = collect(out, d, outTrunc);
      if (onChunk) onChunk('out', d.toString('utf8'));
    });
    child.stderr.on('data', (d) => {
      [err, errTrunc] = collect(err, d, errTrunc);
      if (onChunk) onChunk('err', d.toString('utf8'));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (registry && sessionId) registry.delete(sessionId);
      if (!settled) {
        settled = true;
        resolve({ exitCode: -1, spawnError: String(e.message), cwd, durMs: Date.now() - started, timedOut: false, truncatedOut: outTrunc, truncatedErr: errTrunc, stdout: out.toString('utf8'), stderr: err.toString('utf8') });
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (registry && sessionId) registry.delete(sessionId);
      const rawStdout = out.toString('utf8');
      let finalCwd = cwd || null;
      let exitCode = code;
      // parse the marker FIRST (from raw output), then strip it from returned output
      if (process.platform !== 'win32') {
        const m = lastMarker(rawStdout, /__LF_EOF ([A-Za-z0-9+/=]+) (-?\d+)/, (mm) => [Buffer.from(mm[1], 'base64').toString('utf8'), Number(mm[2])]);
        if (m) { finalCwd = m[0]; exitCode = m[1]; }
      } else {
        const m = lastMarker(rawStdout, /__LF_EOF (.+) (-?\d+)\s*$/, (mm) => [mm[1].trim(), Number(mm[2])]);
        if (m) { finalCwd = m[0]; exitCode = m[1]; }
      }
      const stripMarker = (s) => s.split('\n').filter((l) => !l.includes('__LF_EOF')).join('\n');
      const stdout = stripMarker(rawStdout);
      const stderr = stripMarker(err.toString('utf8'));
      const execId = recordExecLog({
        cmd, cwd, exitCode: exitCode ?? null, timedOut, durMs: Date.now() - started,
        createdAt: new Date().toISOString(),
        stdout: stdout.slice(0, FULL_LOG_CAP),
        stderr: stderr.slice(0, FULL_LOG_CAP),
        truncated: stdout.length > FULL_LOG_CAP || stderr.length > FULL_LOG_CAP,
      });
      if (!settled) {
        settled = true;
        resolve({
          exitCode: exitCode ?? null,
          timedOut,
          cwd: finalCwd,
          durMs: Date.now() - started,
          truncatedOut: outTrunc,
          truncatedErr: errTrunc,
          stdout,
          stderr,
          execLogId: execId,
        });
      }
    });
  });
}

function lastMarker(stdout, re, map) {
  const lines = stdout.split('\n').filter((l) => l.startsWith('__LF_EOF'));
  if (!lines.length) return null;
  const m = lines[lines.length - 1].trim().match(re);
  return m ? map(m) : null;
}

// Kill a process AND its whole tree. On Windows child.kill() only terminates
// the wrapper cmd.exe — python/GUI children kept running after a timeout, so
// use taskkill /T /F (also covers detached processes). POSIX uses the process
// group (children spawned with detached:true get their own group).
function killPidTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true; // taskkill is async; errors surface as non-zero exit (ignored)
    }
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
  }
}

function killTree(child) {
  killPidTree(child.pid);
}

export { killPidTree };

export function killSession(registry, sessionId) {
  const child = registry.get(sessionId);
  if (child && typeof child.kill === 'function') {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGINT'); else child.kill('SIGINT'); } catch {}
    setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }, 1200);
    return true;
  }
  return false;
}

// Registry of running streaming sessions (for interrupts).
export function makeSessionRegistry() {
  const sessions = new Map();
  return sessions;
}

export { DEFAULT_TIMEOUT, MAX_TIMEOUT, OUTPUT_CAP };
