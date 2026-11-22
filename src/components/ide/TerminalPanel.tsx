'use client';

// Integrated terminal (Milestone 1): a REAL interactive terminal when the
// companion has node-pty — persistent shell sessions (cd/env/state survive),
// full ANSI colors and cursor movement, resize, vim/htop/REPLs, Ctrl+C and
// Ctrl+Z as ordinary tty bytes. Multiple sessions per workspace, reconnects
// replay the scrollback.
//
// When node-pty is unavailable (e.g. the standalone compiled binary), the
// panel transparently falls back to the original per-command NDJSON streaming
// shell with local line editing — preserved exactly as before.
import { useEffect, useRef, useState, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useWorkspace } from '@/lib/store/workspace';
import { useSettings } from '@/lib/store/settings';
import type { CompanionClient } from '@/lib/companion/client';

const PROMPT = (cwd: string) => `${cwd} ❯ `;

type PtySession = { sessionId: string; cwd: string; shell: string; exited: boolean };

export function TerminalPanel({ client, active }: { client: CompanionClient; active: boolean }) {
  const ws = useWorkspace();
  const settings = useSettings();
  const termRef = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<any>(null);
  const modeRef = useRef<'pty' | 'legacy' | 'pending'>('pending');
  // PTY state
  const [ptyMode, setPtyMode] = useState<boolean | null>(null); // null = probing
  const [sessions, setSessions] = useState<PtySession[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const inputQueueRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // legacy state (fallback — unchanged behavior)
  const runningRef = useRef(false);
  const lineRef = useRef('');
  const cwdRef = useRef('.');
  const historyRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const currentSigRef = useRef<null | (() => void)>(null);
  const wsIdRef = useRef<string | null>(null);
  wsIdRef.current = ws.workspaceId;

  const makeTerm = useCallback(async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
      theme: {
        background: '#1d1d23',
        foreground: '#e4e4e7',
        cursor: '#a78bfa',
        black: '#1d1d23', green: '#4ade80', red: '#f87171', blue: '#a78bfa', yellow: '#fbbf24',
        selectionBackground: '#4c3a78aa',
      },
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    fit.fit();
    return { term, fit };
  }, []);

  // ---- PTY input: queue keystrokes and flush in order (batching keeps a
  // fast typist from racing the companion with one request per byte) ----
  const flushInput = useCallback(() => {
    flushTimerRef.current = null;
    const wsId = wsIdRef.current;
    const sess = activeSessionRef.current;
    if (!wsId || !sess || !inputQueueRef.current.length) return;
    const data = inputQueueRef.current.join('');
    inputQueueRef.current = [];
    client.ptyInput(wsId, sess, data).catch(() => {});
  }, [client]);

  const queueInput = useCallback((data: string) => {
    inputQueueRef.current.push(data);
    if (flushTimerRef.current == null) {
      flushTimerRef.current = setTimeout(flushInput, 8);
    }
  }, [flushInput]);

  const attachSession = useCallback(async (sessionId: string) => {
    const term = termRef.current;
    const wsId = wsIdRef.current;
    if (!term || !wsId) return;
    esRef.current?.close();
    activeSessionRef.current = sessionId;
    term.reset();
    const es = client.ptyOutputStream(wsId, sessionId, settings.companion.token);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'out') {
          term.write(msg.d);
          if (!msg.replay && activeSessionRef.current === sessionId) {
            // cwd tracking: naive but useful for the fallback prompt-less UI chip
          }
        } else if (msg.t === 'exit') {
          term.write(`\r\n\x1b[33m[session ended (code ${msg.code})]\x1b[0m\r\n`);
          setSessions((prev) => prev.map((s) => s.sessionId === sessionId ? { ...s, exited: true } : s));
          es.close();
          if (activeSessionRef.current === sessionId) activeSessionRef.current = null;
        } else if (msg.t === 'attached') {
          term.resize(msg.cols ?? term.cols, msg.rows ?? term.rows);
        }
      } catch { /* malformed frame */ }
    };
    es.onerror = () => { /* EventSource retries; on reconnect companion replays scrollback */ };
    setSessions((prev) => prev.map((s) => (s.sessionId === sessionId ? { ...s, exited: false } : s)));
  }, [client, settings.companion.token]);

  const startNewSession = useCallback(async () => {
    const wsId = wsIdRef.current;
    const term = termRef.current;
    if (!wsId || !term) return;
    try {
      const r = await client.ptyStart(wsId, { cols: term.cols, rows: term.rows, cwd: ws.terminalCwd || '.' });
      setSessions((prev) => [...prev.filter((s) => !s.exited), { sessionId: r.sessionId, cwd: r.cwd, shell: r.shell, exited: false }]);
      await attachSession(r.sessionId);
      term.write(`\x1b[1;35mPTY session\x1b[0m ${r.shell} — persistent shell on your machine.\r\n`);
    } catch (e: any) {
      term.write(`\x1b[31m[pty error] ${e.message}\x1b[0m\r\n`);
    }
  }, [client, attachSession, ws.terminalCwd]);

  const closeSession = useCallback(async (sessionId: string) => {
    const wsId = wsIdRef.current;
    if (!wsId) return;
    try { await client.ptyStop(wsId, sessionId); } catch { /* already gone */ }
    if (activeSessionRef.current === sessionId) {
      activeSessionRef.current = null;
      esRef.current?.close();
      termRef.current?.reset();
    }
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, [client]);

  // ---- main effect: probe capabilities, build terminal, connect ----
  useEffect(() => {
    if (!active || !hostRef.current || termRef.current) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const wsId = wsIdRef.current;
      if (!wsId) return;
      const { term, fit } = await makeTerm();
      if (disposed || !hostRef.current) { term.dispose(); return; }
      termRef.current = term;
      fitRef.current = fit;

      // Probe the companion: real PTY or legacy streaming shell?
      let caps: { available: boolean; backend: string; reason?: string; fallback: string } | null = null;
      try { caps = await client.ptyCapabilities(); } catch { /* older companion */ }
      if (disposed) return;
      const ptyOk = !!caps?.available;
      setPtyMode(ptyOk);
      modeRef.current = ptyOk ? 'pty' : 'legacy';

      if (ptyOk) {
        term.onData((d) => queueInput(d));
        term.onResize(({ cols, rows }) => {
          const sess = activeSessionRef.current;
          if (sess && wsIdRef.current) client.ptyResize(wsIdRef.current, sess, cols, rows).catch(() => {});
        });
        term.write('\x1b[1;35mLocalForge terminal\x1b[0m — real PTY via node-pty.\r\n');
        // Reattach to surviving sessions (companion restarts wipe them; the
        // IDE lists whatever the companion still owns).
        try {
          const list = await client.ptyList(wsId);
          if (disposed) return;
          const live = list.sessions.filter((s) => !s.exited);
          if (live.length) {
            setSessions(live);
            await attachSession(live[live.length - 1].sessionId);
          } else {
            await startNewSession();
          }
        } catch { /* start lazily instead */ }
      } else {
        modeRef.current = 'legacy';
        term.onData(onDataLegacy);
        term.write('\x1b[1;35mLocalForge terminal\x1b[0m — commands run on your machine via the companion.\r\n');
        if (caps && !caps.available && caps.reason) {
          term.write(`\x1b[33m${caps.reason}\x1b[0m\r\n`);
        }
        term.write(PROMPT(cwdRef.current));
      }

      ro = new ResizeObserver(() => fitRef.current?.fit());
      ro.observe(hostRef.current);
      // workspace switches invalidate sessions
      return () => ro?.disconnect();
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      esRef.current?.close();
      esRef.current = null;
    };
    // legacy handler is stable enough for wiring; it reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ws.workspaceId]);

  // Reset everything when the workspace changes
  useEffect(() => {
    cwdRef.current = ws.terminalCwd || '.';
  }, [ws.terminalCwd]);

  // ---- legacy per-command streaming shell (fallback, unchanged semantics) ----
  function onDataLegacy(data: string) {
    const term = termRef.current;
    if (!term) return;
    const code = data.charCodeAt(0);
    if (runningRef.current) {
      if (data === '\x03') {
        term.write('^C');
        currentSigRef.current?.();
      }
      return;
    }
    if (data === '\r') {
      const cmd = lineRef.current.trim();
      term.write('\r\n');
      lineRef.current = '';
      if (cmd) {
        historyRef.current.push(cmd);
        historyIdx.current = historyRef.current.length;
        runCommandUser(cmd);
      } else {
        term.write(PROMPT(cwdRef.current));
      }
      return;
    }
    if (data === '\x7f') { // backspace
      if (lineRef.current.length) {
        lineRef.current = lineRef.current.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }
    if (data === '\x03') { // Ctrl+C at prompt
      term.write('^C\r\n');
      lineRef.current = '';
      term.write(PROMPT(cwdRef.current));
      return;
    }
    if (data === '\x1b[A' || data === '\x1b[B') { // history
      const h = historyRef.current;
      if (!h.length) return;
      if (data === '\x1b[A') historyIdx.current = Math.max(0, historyIdx.current - 1);
      else historyIdx.current = Math.min(h.length, historyIdx.current + 1);
      const cmd = h[historyIdx.current] ?? '';
      term.write('\x1b[2K\r' + PROMPT(cwdRef.current));
      lineRef.current = cmd;
      term.write(cmd);
      return;
    }
    if (code >= 32 && code < 127) {
      lineRef.current += data;
      term.write(data);
    }
  }

  async function runCommand(cmd: string, confirm = false) {
    const term = termRef.current;
    if (!term || !wsIdRef.current) return;
    runningRef.current = true;
    let sessionId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentSigRef.current = () => {
      client.signalTerm(wsIdRef.current!, sessionId).catch(() => {});
    };
    try {
      const exit = await client.term(wsIdRef.current, {
        cmd,
        cwd: cwdRef.current,
        confirm,
        sessionId,
        onChunk: (stream, d) => {
          term.write(d.replace(/\r?\n/g, '\r\n'));
        },
      });
      if (exit.cwd) {
        cwdRef.current = exit.cwd;
        ws.setTerminalCwd(exit.cwd);
      }
      if (exit.code !== 0) {
        term.write(`\x1b[31m[exit ${exit.code}${exit.timedOut ? ' (timeout)' : ''}]\x1b[0m\r\n`);
      }
    } catch (e: any) {
      if (e?.name === 'NeedsConfirmError') {
        term.write(`\x1b[33m[blocked] ${e.message}\x1b[0m\r\n`);
        term.write(`Confirm by running with \x1b[1m!confirm <cmd>\x1b[0m\r\n`);
      } else {
        term.write(`\x1b[31m[error] ${e.message}\x1b[0m\r\n`);
      }
    } finally {
      runningRef.current = false;
      currentSigRef.current = null;
      term.write(PROMPT(cwdRef.current));
    }
  }

  async function runCommandUser(cmd: string) {
    if (cmd.startsWith('!confirm ')) {
      await runCommand(cmd.slice('!confirm '.length).trim(), true);
      return;
    }
    await runCommand(cmd);
  }

  const showSessionBar = ptyMode === true && sessions.length >= 0;

  return (
    <div className="h-full w-full min-h-0 flex flex-col" data-terminal-host>
      {showSessionBar && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-white/10 bg-black/30 overflow-x-auto shrink-0">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => attachSession(s.sessionId)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap ${
                activeSessionRef.current === s.sessionId
                  ? 'bg-violet-500/30 text-violet-100 border border-violet-400/40'
                  : s.exited ? 'text-zinc-500 border border-transparent' : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
              title={`${s.shell} @ ${s.cwd}`}
            >
              {s.exited ? '✕ ' : '▮ '}term {s.sessionId.slice(-4)} · {s.cwd === '.' ? '~root' : s.cwd}
            </button>
          ))}
          <button
            onClick={startNewSession}
            className="px-2 py-0.5 rounded text-[11px] text-emerald-300 hover:bg-emerald-500/20"
            title="New terminal session"
          >＋ new</button>
          {activeSessionRef.current && (
            <button
              onClick={() => activeSessionRef.current && closeSession(activeSessionRef.current)}
              className="px-2 py-0.5 rounded text-[11px] text-red-300 hover:bg-red-500/20"
              title="Kill active session"
            >kill</button>
          )}
          <span className="ml-auto text-[10px] text-zinc-500 pl-2 shrink-0">PTY persistent shell</span>
        </div>
      )}
      <div className="flex-1 min-h-0 relative" ref={hostRef} data-terminal-inner />
    </div>
  );
}
