// LocalForge companion — shared browser driver (Forge upgrade — Part 6).
//
// Lets agents build AND verify graphical applications: launches/connects a
// local Chrome/Edge/Chromium over the DevTools protocol (CDP), opens locally
// developed apps, interacts with page elements, inspects console errors and
// captures verification evidence — visible for the user or headless in the
// background. No paid cloud browser; the user's own machine, the user's own
// browser.
//
// Availability contract: when no browser can be found or launched, every
// call resolves with { unavailable: reason } and verification callers MUST
// record UNVERIFIED — never a fake pass.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveInWorkspace, assertInsideReal } from './fsapi.js';

const sessions = new Map(); // wsId -> session

// ---- browser discovery -----------------------------------------------------

function candidateExecutables(platform) {
  if (platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lf = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(lf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Chromium\\Application\\chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/msedge', '/snap/bin/chromium', '/usr/bin/headless_shell'];
}

export function findBrowserExecutable() {
  for (const p of candidateExecutables(process.platform)) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return null;
}

// ---- CDP connection --------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.listeners = [];
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        try { this.handleEvent(msg); } catch { /* never crash the session on an event */ }
      }
    });
    const onFail = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
    ws.on('close', onFail);
    ws.on('error', onFail);
  }

  handleEvent(msg) {
    const { method, params } = msg;
    if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
      this.consoleErrors.push({ kind: 'console', text: (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300) });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      this.consoleErrors.push({ kind: 'exception', text: `${d.exception?.description || d.text || 'exception'}`.slice(0, 300) });
    } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
      this.consoleErrors.push({ kind: 'log', text: `${params.entry.source}: ${params.entry.text}`.slice(0, 300) });
    }
    for (const l of this.listeners) {
      try { l(msg); } catch { /* ignore */ }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP call timed out: ${method}`));
        }
      }, 15000);
    });
  }

  waitForEvent(method, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const l = (msg) => {
        if (msg.method === method) {
          this.listeners = this.listeners.filter((x) => x !== l);
          clearTimeout(t);
          resolve(msg.params);
        }
      };
      const t = setTimeout(() => {
        this.listeners = this.listeners.filter((x) => x !== l);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.listeners.push(l);
    });
  }
}

async function fetchJson(url, method = 'GET') {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url, { method });
      if (res.ok) return await res.json();
      if (res.status === 404 && method === 'PUT') {
        // older Chrome accepts /json/new only via GET
        return await fetchJson(url, 'GET');
      }
    } catch { /* browser not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('browser DevTools endpoint did not become ready');
}

// ---- session lifecycle -----------------------------------------------------

export function browserStatus(wsId) {
  const s = sessions.get(wsId);
  if (!s) return { running: false };
  return { running: true, url: s.currentUrl, visible: s.visible, startedAt: s.startedAt, consoleErrors: s.cdp?.consoleErrors?.length ?? 0 };
}

export async function browserOpen(ws, { url = 'about:blank', visible = false } = {}) {
  const exe = findBrowserExecutable();
  if (!exe) {
    return { unavailable: 'No local browser found (Chrome, Edge, Chromium or Brave). Install one to enable browser verification. Verification must be recorded as UNVERIFIED — not passed.' };
  }
  let s = sessions.get(ws.id);
  if (s) {
    // reuse the shared session; navigate to the new URL
    if (url !== 'about:blank') await browserNavigate(ws, url);
    return { reused: true, url: s.currentUrl, visible: s.visible };
  }
  const port = 9200 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `lf-browser-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--window-size=1280,900',
  ];
  if (!visible) args.push('--headless=new');
  if (process.platform === 'linux') args.push('--no-sandbox'); // containers/CI
  const child = spawn(exe, [...args, url], { stdio: 'ignore', detached: false });
  const startOk = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Failed to launch ${exe}: ${e.message}`)));
    setTimeout(() => resolve(), 300);
  });
  await startOk;
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    let target;
    try {
      target = await fetchJson(`http://127.0.0.1:${port}/json/new?url=${encodeURIComponent(url)}`, 'PUT');
    } catch {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find((t) => t.type === 'page');
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('no page target with a debugger URL');
    const { WebSocket } = await import('ws');
    const wsCdp = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { wsCdp.once('open', resolve); wsCdp.once('error', reject); });
    const cdp = new Cdp(wsCdp);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try { await cdp.send('Log.enable'); } catch { /* optional */ }
    s = { id: ws.id, child, port, dataDir, cdp, visible: !!visible, currentUrl: url, startedAt: new Date().toISOString() };
    sessions.set(ws.id, s);
    return { ok: true, url, visible: !!visible, browser: version.Browser || 'local browser', pid: child.pid };
  } catch (e) {
    try { child.kill(); } catch { /* ignore */ }
    return { unavailable: `Browser launched but the DevTools session failed: ${String(e.message || e)}` };
  }
}

export async function browserNavigate(ws, url) {
  const s = sessions.get(ws.id);
  if (!s) return { unavailable: 'No browser session is open. Call browser open first.' };
  s.cdp.consoleErrors = [];
  s.currentUrl = url;
  const loaded = s.cdp.waitForEvent('Page.loadEventFired', 15000).catch(() => null);
  await s.cdp.send('Page.navigate', { url });
  await loaded;
  const title = (await s.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.value;
  return { ok: true, url, title: title ?? '' };
}

export async function browserEval(ws, expression) {
  const s = sessions.get(ws.id);
  if (!s) return { unavailable: 'No browser session is open. Call browser open first.' };
  const r = await s.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { ok: false, error: r.exceptionDetails.exception?.description || r.exceptionDetails.text, consoleErrors: [...s.cdp.consoleErrors] };
  }
  return { ok: true, value: r.result?.value, type: r.result?.type, consoleErrors: [...s.cdp.consoleErrors] };
}

// Keep screenshot writes under the same realpath boundary checks as the
// file editor. Only accept binary bytes from the local DevTools session.
export async function saveBrowserScreenshot(ws, savePath, bytes) {
  const abs = resolveInWorkspace(ws, savePath);
  await assertInsideReal(ws, abs);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await assertInsideReal(ws, abs);
  await fsp.writeFile(abs, bytes);
  return { ok: true, savedTo: savePath, bytes: bytes.length };
}

export async function browserScreenshot(ws, savePath) {
  const s = sessions.get(ws.id);
  if (!s) return { unavailable: 'No browser session is open. Call browser open first.' };
  const shot = await s.cdp.send('Page.captureScreenshot', { format: 'png' });
  if (savePath) return saveBrowserScreenshot(ws, savePath, Buffer.from(shot.data, 'base64'));
  return { ok: true, dataBase64: shot.data.slice(0, 100) + '…', bytes: Math.round(shot.data.length * 0.75), note: 'Pass a path to save the full screenshot into the workspace.' };
}

// The verification workhorse: open (or reuse), navigate, run checks, collect
// console errors, optionally save a screenshot — structured evidence only.
export async function browserVerify(ws, { url, checks = [], saveScreenshot, timeoutMs = 15000 } = {}) {
  if (!url) return { unavailable: 'browser verify requires a url' };
  let open = await browserOpen(ws, { url, visible: false });
  if (open.unavailable) return open;
  const nav = await browserNavigate(ws, url);
  if (nav.unavailable) return nav;
  // browserVerify must read the active session after opening/navigating.
  // Previously this variable was undefined, causing HTTP 500 whenever Chrome
  // was available (CI caught it; browserless local tests could not).
  const s = sessions.get(ws.id);
  if (!s) return { unavailable: 'Browser session closed during verification.' };

  const results = [];
  for (const c of checks.slice(0, 12)) {
    try {
      if (c.evaluate) {
        const r = await browserEval(ws, c.evaluate);
        const pass = r.ok && (r.value === true || r.value === c.expected || (c.expected !== undefined && String(r.value) === String(c.expected)));
        results.push({ check: c.evaluate.slice(0, 120), pass, value: r.value === undefined ? null : r.value, error: r.error });
      } else if (c.selector) {
        const expr = `(function(){ const els = document.querySelectorAll(${JSON.stringify(c.selector)});` +
          ` const n = els.length;` +
          ` const text = n ? els[0].textContent.trim().slice(0,200) : null;` +
          ` return JSON.stringify({n, text}); })()`;
        const r = await browserEval(ws, expr);
        if (!r.ok) { results.push({ check: `selector ${c.selector}`, pass: false, error: r.error }); continue; }
        const parsed = JSON.parse(r.value || '{"n":0,"text":null}');
        let pass = parsed.n > (c.minCount ?? 0);
        if (c.contains && pass) pass = String(parsed.text || '').toLowerCase().includes(String(c.contains).toLowerCase());
        results.push({ check: `selector ${c.selector}${c.contains ? ` contains "${c.contains}"` : ''}`, pass, count: parsed.n, text: parsed.text });
      } else {
        results.push({ check: '(empty check)', pass: false, error: 'check needs "selector" or "evaluate"' });
      }
    } catch (e) {
      results.push({ check: c.selector || c.evaluate || '?', pass: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  let screenshot = null;
  if (saveScreenshot) {
    try { screenshot = await browserScreenshot(ws, saveScreenshot); } catch (e) { screenshot = { error: String(e.message || e) }; }
  }

  const consoleErrors = [...(s?.cdp?.consoleErrors ?? [])];
  const allPassed = results.length > 0 && results.every((r) => r.pass);
  const evidence = {
    ok: true,
    url: s.currentUrl,
    title: nav.title,
    checks: results,
    checksPassed: results.filter((r) => r.pass).length,
    checksTotal: results.length,
    consoleErrors,
    screenshotPath: screenshot?.savedTo,
    verifiedAt: new Date().toISOString(),
    verdict: allPassed && consoleErrors.filter((e) => e.kind !== 'console').length === 0 ? 'BROWSER VERIFICATION PASSED' : allPassed ? 'BROWSER VERIFICATION PASSED (with console warnings/errors — review)' : 'BROWSER VERIFICATION FAILED',
  };
  return evidence;
}

export async function browserClose(wsId) {
  const s = sessions.get(wsId);
  if (!s) return { ok: true, note: 'No browser session was open.' };
  sessions.delete(wsId);
  try { await s.cdp.send('Browser.close'); } catch { /* already gone */ }
  try { s.child.kill(); } catch { /* ignore */ }
  try { await fsp.rm(s.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true };
}

// Companion shutdown closes headless sessions (visible windows belong to the
// user and are left alone by design, same policy as detached processes).
export async function closeHeadlessSessions() {
  for (const [id, s] of sessions) {
    if (!s.visible) {
      try { await browserClose(id); } catch { /* ignore */ }
    }
  }
}
