#!/usr/bin/env node
// Fail the Windows installer build unless the actual npm-installed node-pty
// package can create a native ConPTY-backed shell. node-pty 1.1.x can load
// N-API addons from prebuilds/win32-x64 rather than build/Release.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(process.cwd(), 'node_modules', 'node-pty');
const candidates = [
  'prebuilds/win32-x64/conpty.node',
  'prebuilds/win32-x64/pty.node',
  'build/Release/conpty.node',
  'build/Release/pty.node',
];
const present = candidates.filter((p) => fs.existsSync(path.join(root, p)));
console.log('node-pty native Windows addon files:', present);
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('This assertion must run on windows-x64 (actual installer builder).');
  process.exit(1);
}
if (!present.length) {
  console.error('No native Windows node-pty addon found. Check npm-install.log for an optional-dependency failure.');
  process.exit(1);
}

let pty;
try {
  pty = require(path.join(root, 'lib', 'index.js'));
  if (typeof pty.spawn !== 'function') throw new Error('node-pty does not export spawn()');
} catch (error) {
  console.error('node-pty installed but cannot load its Windows native module:', error);
  process.exit(1);
}

try {
  const output = await new Promise((resolve, reject) => {
    const shell = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo LF_NATIVE_PTY_OK'], {
      cols: 80, rows: 24, name: 'xterm-color', env: process.env,
    });
    let stdout = '';
    const timeout = setTimeout(() => {
      try { shell.kill(); } catch { /* best effort */ }
      reject(new Error('Native Windows PTY launch timed out'));
    }, 20000);
    shell.onData((data) => { stdout += data; });
    shell.onExit(() => {
      clearTimeout(timeout);
      resolve(stdout);
    });
  });
  if (!output.includes('LF_NATIVE_PTY_OK')) {
    throw new Error('Native PTY launched but echo output was missing: ' + JSON.stringify(output));
  }
  console.log('PASS: native Windows node-pty shell produced LF_NATIVE_PTY_OK');
  // On Windows, node-pty/ConPTY can retain native libuv handles even after
  // onExit fires and the shell exits. The probe has completed all assertions:
  // terminate the probe process explicitly instead of waiting on those handles
  // until the GitHub Actions step timeout. The installed-product test separately
  // verifies live sessions, interrupts, process cleanup, and uninstall.
  process.exit(0);
} catch (error) {
  console.error('FAIL: native Windows PTY smoke test:', error);
  process.exit(1);
}
