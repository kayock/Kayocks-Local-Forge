// Adapter from Bun's built-in native Terminal / ConPTY to the small node-pty
// interface consumed by LocalForge's PTY session manager. Bun 1.4+ implements
// ConPTY on Windows; this avoids .node relative paths inside compiled bunfs.
// This backend is only selected for a compiled Windows Bun executable.
// Node.js and Linux paths continue using the original node-pty implementation.
import fs from 'node:fs';
import path from 'node:path';

export function isStandaloneWindowsBunPty() {
  return process.platform === 'win32' &&
    typeof Bun !== 'undefined' &&
    Bun.isStandaloneExecutable === true &&
    typeof Bun.Terminal === 'function' &&
    typeof Bun.spawn === 'function';
}

export function createBunPtyBackend() {
  return {
    spawn(file, args = [], options = {}) {
      const onData = new Set();
      const onExit = new Set();
      const decoder = new TextDecoder();
      let didExit = false;
      let exitResult = null;
      let child;

      const terminal = new Bun.Terminal({
        cols: options.cols || 80,
        rows: options.rows || 24,
        name: options.name || 'xterm-256color',
        data(_terminal, bytes) {
          const chunk = decoder.decode(bytes, { stream: true });
          if (!chunk) return;
          for (const fn of [...onData]) {
            try { fn(chunk); } catch { /* subscriber must not crash the PTY */ }
          }
        },
      });
      try {
        // The shell runs ONCE and stays alive. Commands are sent as PTY bytes;
        // cwd/environment changes in one command survive subsequent inputs.
        const argv = Array.isArray(args) ? args : (args ? [String(args)] : []);
        child = Bun.spawn([file, ...argv], {
          cwd: options.cwd,
          env: options.env,
          terminal,
          windowsHide: true,
        });
      } catch (error) {
        try { terminal.close(); } catch {}
        throw error;
      }

      const finish = (code) => {
        if (didExit) return;
        didExit = true;
        exitResult = { exitCode: typeof code === 'number' ? code : -1 };
        // The child has exited, so closing ConPTY will not block its lifetime.
        try { terminal.close(); } catch {}
        for (const fn of [...onExit]) {
          try { fn(exitResult); } catch { /* preserve cleanup */ }
        }
      };
      Promise.resolve(child.exited).then(finish, () => finish(-1));

      return {
        get pid() { return child.pid; },
        write(data) {
          const bytes = String(data);
          // Bun's Windows ConPTY can relay ETX as raw input without generating
          // CTRL_C_EVENT for the foreground application. When a user presses
          // Ctrl+C, dispatch the real Windows console-control event into this
          // PTY's shell console via our tiny, separately packaged helper.
          // This affects only this managed session, not the Companion itself.
          if (bytes === '\x03') {
            const helper = path.join(path.dirname(process.execPath), 'LocalForgePtyInterrupt.exe');
            if (fs.existsSync(helper)) {
              try {
                const interrupt = Bun.spawn([helper, String(child.pid)], {
                  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
                });
                void Promise.resolve(interrupt.exited).then((code) => {
                  if (code !== 0) {
                    console.warn('LocalForge PTY: native Ctrl+C helper failed (' + code + '); falling back to ETX');
                    try { terminal.write(bytes); } catch {}
                  }
                }, () => { try { terminal.write(bytes); } catch {} });
                return;
              } catch (e) {
                console.warn('LocalForge PTY: native Ctrl+C helper could not start:', String(e?.message || e));
              }
            }
          }
          terminal.write(bytes);
        },
        resize(cols, rows) { terminal.resize(cols, rows); },
        onData(fn) {
          onData.add(fn);
          return { dispose: () => onData.delete(fn) };
        },
        onExit(fn) {
          onExit.add(fn);
          if (didExit) queueMicrotask(() => { if (onExit.has(fn)) fn(exitResult); });
          return { dispose: () => onExit.delete(fn) };
        },
        kill() {
          try { child.kill(); } catch {}
          // Closing a terminal with a live child can hang on older Windows.
          // Wait for child.exited, whose handler closes the PTY safely.
        },
      };
    },
  };
}
