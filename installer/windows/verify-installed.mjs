#!/usr/bin/env node
// RC4 — verify the EXACT installed LocalForge Companion Windows product.
//
// Runs on a windows-latest runner AFTER the real NSIS installer was silently
// installed. Hard-fails (exit 1) unless every mandatory check passes:
//   1. installed files: companion exe, tray exe, Windows-built pty.node
//   2. Start Menu shortcut resolves to $INSTDIR\LocalForgeCompanion\LocalForgeTray.exe
//   3. the INSTALLED companion exe starts and serves /health
//   4. /api/pty/capabilities reports the native node-pty backend
//   5. a REAL PowerShell PTY session: output visible, cwd + env persist across
//      separate inputs, resize accepted, Ctrl+C interrupt recovers to prompt,
//      stop reaps the session (list is clean)
//   6. uninstall removes files + shortcuts
// Graphical tray interaction is attempted best-effort and reported honestly
// (a headless CI desktop may refuse a tray app — that is logged, not fatal).
//
// Usage: node verify-installed.mjs [--port 7667]
// Env:   LF_INSTALL_DIR (auto-detected if unset), LF_SKIP_UNINSTALL=1
import { spawn, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const argvIdx = process.argv.indexOf('--port');
const PORT = Number(argvIdx > -1 ? process.argv[argvIdx + 1] : (process.env.LF_PORT || 7667));
const BASE = `http://127.0.0.1:${PORT}`;
const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const INSTALL_DIR = process.env.LF_INSTALL_DIR || path.join(LOCALAPPDATA, 'Programs', 'LocalForge Companion');
const APP_DIR = path.join(INSTALL_DIR, 'LocalForgeCompanion');
const HOME = path.join(LOCALAPPDATA, 'LocalForgeCompanion'); // default per-user home (config.js)
const START_MENU_LNK = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LocalForge', 'LocalForge Companion.lnk');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const log = (m) => console.log(`…     ${m}`);

function req(base, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${base}${p}`, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* SSE or non-JSON */ }
        resolve({ status: res.statusCode, json, text: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** Collect SSE 'out' events from a PTY session for `ms` milliseconds. */
function collectOutput(base, token, wsId, sessionId, ms) {
  return new Promise((resolve) => {
    const chunks = [];
    let request = null;
    const timer = setTimeout(() => { try { request?.destroy(); } catch { /* ignore */ } resolve(chunks.join('')); }, ms);
    request = http.get(`${base}/api/ws/${wsId}/pty/output?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              try {
                const ev = JSON.parse(line.slice(5).trim());
                if (ev.t === 'out' && typeof ev.d === 'string') chunks.push(ev.d);
              } catch { /* partial frame */ }
            }
          }
        }
      });
      res.on('error', () => { clearTimeout(timer); resolve(chunks.join('')); });
      res.on('end', () => { clearTimeout(timer); resolve(chunks.join('')); });
    });
    request.on('error', () => { clearTimeout(timer); resolve(chunks.join('')); });
  });
}

function readLnkTarget(lnkPath) {
  try {
    const ps = `& { $sh = New-Object -ComObject WScript.Shell; $sh.CreateShortcut('${lnkPath.replace(/'/g, "''")}').TargetPath }`;
    const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    return (out.stdout || '').trim();
  } catch { return ''; }
}

// ---- 0. resolve the installer version / artifact paths -----------------
const workspaceCwd = process.env.LF_WORKSPACE || process.cwd();
const distDir = process.env.LF_ARTIFACT_DIR || path.join(workspaceCwd, 'download', 'windows');
const setupExe = fs.readdirSync(distDir).find((f) => /^LocalForge-Companion-Setup-.*\.exe$/.test(f));
ok('installer artifact present', !!setupExe, `no Setup exe in ${distDir}`);

// ---- 1. installed files ------------------------------------------------
ok('companion exe installed', fs.existsSync(path.join(APP_DIR, 'localforge-companion.exe')), APP_DIR);
ok('tray exe installed at the correct path', fs.existsSync(path.join(APP_DIR, 'LocalForgeTray.exe')), APP_DIR);
ok('Windows console interrupt helper installed', fs.existsSync(path.join(APP_DIR, 'LocalForgePtyInterrupt.exe')), APP_DIR);
const ptyNodeCandidates = [
  path.join(APP_DIR, 'pty-sidecar', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
  path.join(APP_DIR, 'pty-sidecar', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'),
  path.join(APP_DIR, 'pty-sidecar', 'node-pty', 'build', 'Release', 'conpty.node'),
  path.join(APP_DIR, 'pty-sidecar', 'node-pty', 'build', 'Release', 'pty.node'),
];
const nativePtyFile = ptyNodeCandidates.find((p) => fs.existsSync(p));
ok('native PTY binary inside the installer sidecar', !!nativePtyFile, `none of ${ptyNodeCandidates.join(', ')}`);
ok('sidecar package manifest present', fs.existsSync(path.join(APP_DIR, 'pty-sidecar', 'node-pty', 'package.json')));

// ---- 2. shortcut resolution --------------------------------------------
const lnkTarget = readLnkTarget(START_MENU_LNK);
ok(`Start Menu shortcut exists (${path.basename(START_MENU_LNK)})`, fs.existsSync(START_MENU_LNK));
ok('Start Menu shortcut resolves to the installed tray exe',
  lnkTarget.toLowerCase() === path.join(APP_DIR, 'LocalForgeTray.exe').toLowerCase(),
  `target = ${lnkTarget || '(unreadable)'}`);

// ---- 3. launch the INSTALLED companion ---------------------------------
if (!fs.existsSync(path.join(APP_DIR, 'localforge-companion.exe'))) {
  console.log('FAIL  cannot proceed: installed companion exe missing');
  process.exit(1);
}
const companionLog = path.join(distDir, 'installed-companion.log');
const child = spawn(path.join(APP_DIR, 'localforge-companion.exe'),
  ['--port', String(PORT), '--show-code'], {
    cwd: APP_DIR,
    stdio: ['ignore', fs.openSync(companionLog, 'a'), fs.openSync(companionLog, 'a')],
    detached: false,
    windowsHide: true,
  });
let healthy = false;
for (let i = 0; i < 120; i++) {
  try { const r = await req(BASE, 'GET', '/health'); if (r.status === 200) { healthy = true; break; } } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 500));
}
ok('INSTALLED companion starts and serves /health', healthy, `see ${companionLog}`);
if (!healthy) { try { child.kill(); } catch {} process.exit(1); }

// ---- 4. pair through the REAL home state ------------------------------
const stateFile = path.join(HOME, 'state.json');
ok('default per-user home state.json exists', fs.existsSync(stateFile), stateFile);
let token = '';
if (fs.existsSync(stateFile)) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const pair = await req(BASE, 'POST', '/pair', { code: state.pairingCode, deviceLabel: 'rc4-installer-verify' });
  ok('pairing the installed companion works', pair.status === 200, JSON.stringify(pair.json || {}));
  token = pair.json?.token || '';
}

// ---- 5. native PTY backend --------------------------------------------
const caps = await req(BASE, 'GET', '/api/pty/capabilities', undefined, token);
ok('/api/pty/capabilities reachable', caps.status === 200, JSON.stringify(caps.json || {}));
const realPtyBackend = caps.json?.available === true &&
  (caps.json?.backend === 'bun-conpty' || String(caps.json?.backend || '').startsWith('node-pty'));
ok('real native PTY backend reported (Bun ConPTY or node-pty)', realPtyBackend,
  `caps = ${JSON.stringify(caps.json)} — NDJSON fallback is NOT the installed product's terminal`);
if (!realPtyBackend) {
  try { child.kill(); } catch {}
  process.exit(1);
}

// ---- 6. real PowerShell PTY session -----------------------------------
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rc4-verify-'));
fs.writeFileSync(path.join(wsDir, 'probe.txt'), 'hello from the installer\n');
const w = await req(BASE, 'POST', '/api/workspaces', { path: wsDir, name: 'rc4-verify' }, token);
ok('workspace created on the installed companion', w.status === 200 && w.json?.workspace?.id, JSON.stringify(w.json || {}));
const wsId = w.json?.workspace?.id;
if (!wsId) { try { child.kill(); } catch {} process.exit(1); }

const shellEnv = process.env.LF_PTY_SHELL || 'powershell.exe';
const start = await req(BASE, 'POST', `/api/ws/${wsId}/pty/start`, { cols: 100, rows: 30, shell: shellEnv }, token);
ok('PTY session starts (real ' + shellEnv + ')', start.status === 200 && start.json?.sessionId, JSON.stringify(start.json || {}));
const sessionId = start.json?.sessionId;
if (!sessionId) { try { child.kill(); } catch {} process.exit(1); }

const collector = collectOutput(BASE, token, wsId, sessionId, 14000);
await new Promise((r) => setTimeout(r, 1500));
await req(BASE, 'POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: 'Set-Location C:\\Windows; $env:LF_PROBE="pty-works"\r\n' }, token);
await new Promise((r) => setTimeout(r, 2500));
await req(BASE, 'POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: 'Write-Output "cwd=$((Get-Location).Path) env=$env:LF_PROBE"\r\n' }, token);
await new Promise((r) => setTimeout(r, 3000));
const out = await collector;
ok('session output is visible (real terminal, not a dry record)', out.trim().length > 0, '(no output captured)');
ok('cwd persisted across separate inputs', /cwd=C:\\Windows/i.test(out), `tail: ${JSON.stringify(out.slice(-400))}`);
ok('environment persisted across separate inputs', /env=pty-works/.test(out), `tail: ${JSON.stringify(out.slice(-400))}`);

// resize
const rz = await req(BASE, 'POST', `/api/ws/${wsId}/pty/resize`, { sessionId, cols: 120, rows: 40 }, token);
ok('terminal resize accepted', rz.status === 200, JSON.stringify(rz.json || {}));

// interrupt: start a long command, then Ctrl+C, then prove the shell is alive
const collector2 = collectOutput(BASE, token, wsId, sessionId, 12000);
await req(BASE, 'POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: 'ping.exe -n 30 127.0.0.1\r\n' }, token);
await new Promise((r) => setTimeout(r, 2000));
await req(BASE, 'POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: '\x03' }, token); // Ctrl+C
await new Promise((r) => setTimeout(r, 1500));
await req(BASE, 'POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: 'Write-Output "RECOVERED-INTERRUPT"\r\n' }, token);
await new Promise((r) => setTimeout(r, 2500));
const out2 = await collector2;
ok('Ctrl+C interrupt recovers to a live prompt', /RECOVERED-INTERRUPT/.test(out2) && !/RECOVERED-INTERRUPT[\s\S]*ping/.test(out2.split('RECOVERED-INTERRUPT')[1] || ''),
  `tail: ${JSON.stringify(out2.slice(-400))}`);

// stop + cleanup
const stop = await req(BASE, 'POST', `/api/ws/${wsId}/pty/stop`, { sessionId }, token);
ok('PTY stop accepted', stop.status === 200, JSON.stringify(stop.json || {}));
await new Promise((r) => setTimeout(r, 1200));
const list = await req(BASE, 'GET', `/api/ws/${wsId}/pty/list`, undefined, token);
ok('process cleanup: no sessions remain after stop', (list.json?.sessions || []).every((s) => s.sessionId !== sessionId),
  `sessions = ${JSON.stringify(list.json?.sessions || [])}`);

// ---- 7. tray launch attempt (honest, best-effort on a headless runner) --
try {
  const trayProc = spawn(path.join(APP_DIR, 'LocalForgeTray.exe'), [], { cwd: APP_DIR, windowsHide: true });
  await new Promise((r) => setTimeout(r, 3000));
  const alive = !trayProc.killed && trayProc.exitCode === null;
  log(`tray launch attempt: process ${alive ? 'started and stayed alive for 3s (no missing-file error)' : `exited (code ${trayProc.exitCode}) — headless runners often lack an interactive desktop; graphical tray behavior remains UNVERIFIED here`}`);
  try { trayProc.kill(); } catch { /* ignore */ }
} catch (e) {
  log(`tray launch attempt failed to start: ${e.message} — graphical tray behavior remains UNVERIFIED here`);
}

// ---- 8. shutdown + uninstall ------------------------------------------
try { child.kill(); } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 1000));

if (process.env.LF_SKIP_UNINSTALL === '1') {
  console.log(`\n${failures === 0 ? 'ALL MANDATORY CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const uninstaller = path.join(INSTALL_DIR, 'Uninstall.exe');
ok('uninstaller installed', fs.existsSync(uninstaller), INSTALL_DIR);
if (fs.existsSync(uninstaller)) {
  execSync(`"${uninstaller}" /S _?=${INSTALL_DIR}`, { timeout: 120000, stdio: 'ignore' });
  // NSIS silent uninstall returns immediately; wait for the files to go
  let gone = false;
  for (let i = 0; i < 40; i++) {
    if (!fs.existsSync(path.join(APP_DIR, 'localforge-companion.exe'))) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok('uninstall removed the installed application', gone, APP_DIR);
  ok('uninstall removed the Start Menu shortcut', !fs.existsSync(START_MENU_LNK));
}

console.log(`\n${failures === 0 ? 'ALL MANDATORY CHECKS PASSED — the installed product works end to end' : `${failures} CHECK(S) FAILED — see the log above`}`);
process.exit(failures === 0 ? 0 : 1);
