'use client';

// Integrated terminal: real shell execution on the user's machine via the
// companion, streamed over NDJSON. Local line editing, history and Ctrl+C.
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useWorkspace } from '@/lib/store/workspace';
import type { CompanionClient } from '@/lib/companion/client';

const PROMPT = (cwd: string) => `${cwd} ❯ `;

export function TerminalPanel({ client, active }: { client: CompanionClient; active: boolean }) {
  const ws = useWorkspace();
  const termRef = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<any>(null);
  const runningRef = useRef(false);
  const lineRef = useRef('');
  const cwdRef = useRef('.');
  const historyRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);

  useEffect(() => {
    if (!active || !hostRef.current || termRef.current) return;
    let disposed = false;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !hostRef.current) return;
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
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      term.write('\x1b[1;35mLocalForge terminal\x1b[0m — commands run on your machine via the companion.\r\n');
      term.write(PROMPT(cwdRef.current));
      term.onData(onData);
      const ro = new ResizeObserver(() => fitRef.current?.fit());
      ro.observe(hostRef.current);
      return () => ro.disconnect();
    })();
    return () => { disposed = true; };
     
  }, [active]);

  function onData(data: string) {
    const term = termRef.current;
    if (!term) return;
    const code = data.charCodeAt(0);
    if (runningRef.current) {
      // allow Ctrl+C interrupt while running
      if (data === '\x03') {
        term.write('^C');
        // sessionId is tracked per-run below via currentRun
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
      // clear current line
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

  const currentSigRef = useRef<null | (() => void)>(null);

  async function runCommand(cmd: string, confirm = false) {
    const term = termRef.current;
    if (!term || !ws.workspaceId) return;
    runningRef.current = true;
    let sessionId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentSigRef.current = () => {
      client.signalTerm(ws.workspaceId!, sessionId).catch(() => {});
    };
    try {
      const exit = await client.term(ws.workspaceId, {
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

  // "!confirm <cmd>" runs a command the companion flagged as destructive
  async function runCommandUser(cmd: string) {
    if (cmd.startsWith('!confirm ')) {
      const real = cmd.slice('!confirm '.length).trim();
      await runCommand(real, true);
      return;
    }
    await runCommand(cmd);
  }

  return (
    <div className="h-full w-full min-h-0" ref={hostRef} data-terminal-host />
  );
}
