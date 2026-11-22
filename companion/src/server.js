#!/usr/bin/env node
// LocalForge Companion — main server.
// Connects the LocalForge browser IDE to: local AI model servers, authorized
// project directories, command execution, and app previewing.
//
// Run: node src/server.js  (or: npm i -g @localforge/companion && localforge-companion)
import http from 'node:http';
import path from 'node:path';

// `ws` is an OPTIONAL dependency: without it the WebSocket terminal channel is
// disabled and everything else (HTTP API, NDJSON streaming, SSE events,
// preview) works exactly the same.
let WebSocketServer = null;
try {
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.log('  [ws] optional dependency not installed — WebSocket channel disabled (HTTP streaming still fully works).');
}

import {
  config, VERSION, ensureHome, loadState, getState, saveState,
  addToken, log, upsertWorkspace, removeWorkspace, findWorkspace, workspaceId,
  isTokenValid, resetPairingCode, writeStatus,
} from './config.js';
import { sendJson, readBody, handlePreflight, withCors } from './http-utils.js';
import { handlePair, authOk, extractToken } from './auth.js';
import * as fsapi from './fsapi.js';
import { runCommand, makeSessionRegistry, killSession, screenCommand, getExecLog } from './exec.js';
import {
  ptyCapabilities, startSession, writeInput, resizeSession, signalSession,
  stopSession, listSessions, attachSubscriber, scrollback as ptyScrollback, stopAllSessions,
} from './pty.js';
import { startProc, listProcs, procOutput, stopProc } from './procs.js';
import {
  browserOpen, browserNavigate, browserEval, browserScreenshot, browserVerify,
  browserClose, browserStatus, closeHeadlessSessions,
} from './browser.js';
import {
  discoverProviders, listModels, proxyChat, loadModel, unloadModel,
  probeToolSupport, testConnection, ChatProxyError, normalizeBaseUrl,
  probeEndpoint, resolveLemonadeCredentials,
} from './providers.js';
import { mintPreviewToken, handlePreview, handleDevProxy } from './preview.js';
import { routeControl, mesh, model } from './controlplane.js';
import { startDiscovery, stopDiscovery, discoveryStatus } from './discovery.js';

await ensureHome();
const state = loadState();
mesh.applySavedNetwork();

const sessions = makeSessionRegistry(); // running streaming terminal sessions
const sseClients = new Set();           // event stream subscribers

function broadcastEvent(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

const BANNER = `
  _                 _____ _                      _   
 | |               |  ___| |                    | |  
 | |     ___   ___ | |__ | | ___   ___  ___  ___| |_ 
 | |    / _ \\ / _ \\|  __|| |/ _ \\ / _ \\/ __|/ _ \\| __|
 | |___| (_) | (_) | |___| | (_) | (_) \\__ \\ (_) | |_ 
 |______\\___/ \\___/\\____/|_|\\___/ \\___/|___/\\___/ \\__|
  local companion v${VERSION} — your models, your machine.
`;

function printHelp() {
  console.log(`
Usage: localforge-companion [--port 7337] [--host 127.0.0.1] [--workspace /path]
                            [--home ~/.localforge-companion] [--show-code] [--lan]
`);
}

if (config.help) { printHelp(); process.exit(0); }

// ---- request routing ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return handlePreflight(req, res);
  withCors(req, res); // every response carries CORS headers (browser IDE is cross-origin in direct mode)

  try {
    // ---- public routes ----
    if (p === '/health') {
      // Forge upgrade — Fleet Map: expose lightweight machine resources with
      // the health payload (no polling loop on the IDE side; read on demand).
      const osmod = await import('node:os');
      return sendJson(res, 200, {
        ok: true, name: 'localforge-companion', version: VERSION,
        platform: process.platform, host: config.host, port: config.port,
        paired: getState().tokens.length > 0,
        workspaces: getState().workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
        resources: {
          cpus: osmod.cpus().length,
          load1: osmod.loadavg()[0],
          memTotal: osmod.totalmem(),
          memFree: osmod.freemem(),
          uptimeSec: Math.round(osmod.uptime()),
          hostname: osmod.hostname(),
        },
      });
    }

    if (p === '/pair' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      return await handlePair(req, res, body);
    }

    if (p.startsWith('/preview/')) {
      const parts = p.split('/').filter(Boolean);
      const ws = findWorkspace(parts[1]);
      if (!ws) { res.writeHead(404); return res.end('Unknown workspace'); }
      return await handlePreview(req, res, url, ws);
    }

    // /p/<ptok>/<port>/<rest...>
    if (p.startsWith('/p/')) {
      const parts = p.split('/').filter(Boolean); // [p, ptok, port, ...rest]
      if (parts.length < 3) { res.writeHead(400); return res.end('Bad proxy URL'); }
      const [, ptok, port, ...rest] = parts;
      const anyWs = getState().workspaces[0];
      return handleDevProxy(req, res, url, {
        ws: anyWs || { id: 'x', path: '.' },
        ptok, port: Number(port),
        rest: '/' + rest.map(decodeURIComponent).join('/'),
      });
    }

    // ---- authenticated API ----
    if (p.startsWith('/api/')) {
      if (!authOk(req, url)) {
        return sendJson(res, 401, { error: 'Not paired. Pair this browser with the code shown in the companion console.' });
      }
      return await routeApi(req, res, url, p);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    log('http_error', { path: p, error: String(e.message || e) });
    sendJson(res, e.status || 500, { error: String(e.message || e) });
  }
});

async function routeApi(req, res, url, p) {
  if (await routeControl(req, res, url, p)) return;
  const method = req.method;

  if (p === '/api/pty/capabilities' && method === 'GET') {
    // Milestone 1: tells the IDE whether a real PTY terminal is available or
    // the NDJSON streaming terminal remains the active backend.
    return sendJson(res, 200, ptyCapabilities());
  }

  // ---- workspaces ----
  if (p === '/api/workspaces' && method === 'GET') {
    return sendJson(res, 200, { workspaces: getState().workspaces });
  }
  if (p === '/api/workspaces' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body.path) return sendJson(res, 400, { error: 'Missing path' });
    const pathmod = await import('node:path');
    const real = await fsapifspReal(body.path);
    if (!real) return sendJson(res, 400, { error: `Directory not found: ${body.path}` });
    const ws = upsertWorkspace(real, body.name);
    if (body.previewDir) { ws.previewDir = body.previewDir; saveState(); }
    log('workspace_open', { id: ws.id, path: real });
    broadcastEvent('workspace_open', { workspaceId: ws.id, name: ws.name });
    return sendJson(res, 200, { workspace: ws });
  }
  if (p.startsWith('/api/workspaces/') && method === 'DELETE') {
    const id = p.split('/')[3];
    const ok = removeWorkspace(id);
    return sendJson(res, ok ? 200 : 404, { removed: ok });
  }
  if (p.startsWith('/api/workspaces/') && method === 'PATCH') {
    const id = p.split('/')[3];
    const ws = findWorkspace(id);
    if (!ws) return sendJson(res, 404, { error: 'Unknown workspace' });
    const body = await readBody(req, 64 * 1024);
    if (body.previewDir !== undefined) { ws.previewDir = body.previewDir; saveState(); }
    if (body.name !== undefined) { ws.name = body.name; saveState(); }
    return sendJson(res, 200, { workspace: ws });
  }

  // ---- pairing management ----
  if (p === '/api/pairing/reset' && method === 'POST') {
    const code = (await import('./config.js')).resetPairingCode();
    console.log(`\n  New pairing code: ${code}\n`);
    return sendJson(res, 200, { message: 'Pairing code reset. See companion console.' });
  }

  // ---- workspace-scoped FS + execution ----
  const wsMatch = p.match(/^\/api\/ws\/([^/]+)(\/.*)?$/);
  if (wsMatch) {
    const ws = findWorkspace(wsMatch[1]);
    if (!ws) return sendJson(res, 404, { error: 'Unknown workspace. Re-open the folder.' });
    const sub = wsMatch[2] || '';

    if (sub === '/tree' && method === 'GET') {
      const depth = Number(url.searchParams.get('depth') || 3);
      const tree = await fsapi.listTree(ws, { depth });
      return sendJson(res, 200, tree);
    }
    if (sub === '/file' && method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      return sendJson(res, 200, await fsapi.readFileContent(ws, rel));
    }
    if (sub === '/file' && method === 'PUT') {
      const body = await readBody(req);
      const r = await fsapi.writeFileContent(ws, body.path, body.content ?? '', {
        createDirs: body.createDirs !== false,
        ifUnmodifiedSince: body.ifUnmodifiedSince ?? null,
        returnDiff: body.returnDiff === true,
      });
      log('fs_write', { wsId: ws.id, path: body.path, bytes: r.bytes });
      broadcastEvent('fs_write', { workspaceId: ws.id, path: body.path });
      return sendJson(res, 200, r);
    }
    if (sub === '/diff/preview' && method === 'POST') {
      // Milestone 1: unified diff BEFORE a write is approved. Read-only.
      const body = await readBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, await fsapi.previewDiff(ws, body.path, body.content ?? ''));
    }
    if (sub === '/file/append' && method === 'POST') {
      // Large-file assembly (tool-call repair mission): append text to a
      // file, created with parents when missing. Jailed like every other fs
      // operation; atomic per call.
      const body = await readBody(req);
      const r = await fsapi.appendFileContent(ws, body.path, body.content ?? '');
      log('fs_append', { wsId: ws.id, path: body.path, bytes: r.bytes });
      broadcastEvent('fs_write', { workspaceId: ws.id, path: body.path });
      return sendJson(res, 200, r);
    }
    if (sub === '/mkdir' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      return sendJson(res, 200, await fsapi.makeDir(ws, body.path));
    }
    if (sub === '/delete' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      const r = await fsapi.deletePath(ws, body.path, { confirm: !!body.confirm });
      log('fs_delete', { wsId: ws.id, path: body.path });
      return sendJson(res, 200, r);
    }
    if (sub === '/rename' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      return sendJson(res, 200, await fsapi.renamePath(ws, body.from, body.to, { overwrite: body.overwrite === true }));
    }
    if (sub === '/stat' && method === 'GET') {
      // Forge upgrade — Problem B: exists/empty/parentExists distinction so an
      // agent can tell "successful empty directory" from "path missing".
      const rel = url.searchParams.get('path') || '.';
      return sendJson(res, 200, await fsapi.statPath(ws, rel));
    }
    if (sub === '/extract' && method === 'POST') {
      // Forge upgrade — Problem B: archive extraction with nested-root
      // detection ("calculator repo/calculator repo/" regression) and an
      // explicit, jailed destination. Overwrites only via overwrite:true.
      const body = await readBody(req, 64 * 1024);
      const r = await fsapi.extractArchive(ws, body.path, {
        dest: body.dest || '.',
        flatten: !!body.flatten,
        overwrite: !!body.overwrite,
        stripComponents: Number(body.stripComponents) || 0,
      });
      log('fs_extract', { wsId: ws.id, archive: body.path, extracted: r.extracted, nestedRoot: r.nestedRoot, flattened: r.flattened });
      broadcastEvent('fs_extract', { workspaceId: ws.id, archive: body.path, extracted: r.extracted });
      return sendJson(res, 200, r);
    }
    if (sub === '/search' && method === 'GET') {
      const r = await fsapi.searchWorkspace(ws, {
        q: url.searchParams.get('q') || '',
        isRegex: url.searchParams.get('isRegex') === '1',
        glob: url.searchParams.get('glob') || '',
        maxResults: Math.min(Number(url.searchParams.get('max') || 300), 1000),
        ignoreCase: url.searchParams.get('ignoreCase') !== '0',
      });
      return sendJson(res, 200, r);
    }
    if (sub === '/exec' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      const screen = screenCommand(body.cmd, { confirm: !!body.confirm });
      if (!screen.allowed) {
        return sendJson(res, screen.needsConfirm ? 403 : 400, {
          error: screen.reason, needsConfirm: !!screen.needsConfirm,
        });
      }
      log('exec_start', { wsId: ws.id, cmd: String(body.cmd).slice(0, 200) });
      broadcastEvent('exec_start', { workspaceId: ws.id, cmd: body.cmd });
      const r = await runCommand({
        cmd: body.cmd,
        cwd: body.cwd ? safeJoin(ws.path, body.cwd) : ws.path,
        timeoutMs: body.timeoutMs,
      });
      log('exec_end', { wsId: ws.id, exitCode: r.exitCode, durMs: r.durMs, timedOut: r.timedOut });
      broadcastEvent('exec_end', { workspaceId: ws.id, exitCode: r.exitCode, durMs: r.durMs });
      return sendJson(res, 200, { ...r, cwd: r.cwd ? relativeTo(ws.path, r.cwd) : null, execLogId: r.execLogId });
    }
    if (sub === '/exec/log' && method === 'GET') {
      // Complete output of a recently executed command (tool results truncate
      // for the model; the human can always open the full log here).
      const id = url.searchParams.get('id') || '';
      const rec = getExecLog(id);
      if (!rec) return sendJson(res, 404, { error: `Unknown exec log: ${id}` });
      return sendJson(res, 200, rec);
    }

    // streaming terminal (NDJSON): POST {cmd, cwd, sessionId}
    if (sub === '/term' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      const screen = screenCommand(body.cmd, { confirm: !!body.confirm });
      if (!screen.allowed) {
        return sendJson(res, screen.needsConfirm ? 403 : 400, {
          error: screen.reason, needsConfirm: !!screen.needsConfirm,
        });
      }
      const sessionId = body.sessionId || `s_${Date.now()}`;
      withCors(req, res);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const wsRoot = ws.path;
      const startedCwd = body.cwd ? safeJoin(wsRoot, body.cwd) : wsRoot;
      writeNd(res, { t: 'start', sessionId, cmd: body.cmd });
      log('term_start', { wsId: ws.id, cmd: String(body.cmd).slice(0, 200) });
      broadcastEvent('term_start', { workspaceId: ws.id, cmd: body.cmd });
      const proc = runCommand({
        cmd: body.cmd,
        cwd: startedCwd,
        timeoutMs: body.timeoutMs,
        sessionId,
        registry: sessions,
        onChunk: (stream, data) => {
          // strip the __LF_EOF marker line from user-visible output
          if (stream === 'out' && data.includes('__LF_EOF')) {
            data = data.split('\n').filter((l) => !l.startsWith('__LF_EOF')).join('\n');
            if (!data) return;
          }
          writeNd(res, { t: stream, d: data });
        },
      });
      const r = await proc;
      log('term_end', { wsId: ws.id, exitCode: r.exitCode, durMs: r.durMs });
      broadcastEvent('term_end', { workspaceId: ws.id, exitCode: r.exitCode, durMs: r.durMs });
      const relCwd = r.cwd ? relativeTo(wsRoot, r.cwd) : (body.cwd || '.');
      writeNd(res, { t: 'exit', code: r.exitCode, timedOut: r.timedOut, cwd: relCwd || '.', durMs: r.durMs });
      return res.end();
    }
    if (sub === '/term/signal' && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const ok = killSession(sessions, body.sessionId);
      return sendJson(res, 200, { signaled: ok });
    }

    // ---- real PTY terminal sessions (Milestone 1) ----
    // A persistent interactive shell per session. node-pty optional: without
    // it, start returns 501 {unavailable, fallback:'ndjson-stream'} and the
    // existing NDJSON terminal keeps working untouched.
    if (sub === '/pty/start' && method === 'POST') {
      const body = await readBody(req, 32 * 1024);
      const r = startSession(ws.id, body);
      log('pty_start', { wsId: ws.id, sessionId: r.sessionId });
      broadcastEvent('pty_start', { workspaceId: ws.id, sessionId: r.sessionId });
      return sendJson(res, 200, r);
    }
    if (sub === '/pty/list' && method === 'GET') {
      return sendJson(res, 200, { sessions: listSessions(ws.id), capabilities: ptyCapabilities() });
    }
    if (sub === '/pty/input' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      const ok = writeInput(body.sessionId, typeof body.data === 'string' ? body.data : '');
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (sub === '/pty/resize' && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const ok = resizeSession(body.sessionId, body.cols, body.rows);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (sub === '/pty/signal' && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const ok = signalSession(body.sessionId, body.signal);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (sub === '/pty/stop' && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const ok = stopSession(body.sessionId);
      if (ok) broadcastEvent('pty_stop', { workspaceId: ws.id, sessionId: body.sessionId });
      return sendJson(res, ok ? 200 : 404, { stopped: ok });
    }
    if (sub === '/pty/output' && method === 'GET') {
      // SSE stream of one session's output; replay scrollback first so a
      // reconnecting terminal resumes exactly where it left off.
      const sessionId = url.searchParams.get('sessionId') || '';
      const rec = ptyScrollback(sessionId);
      if (!rec) return sendJson(res, 404, { error: 'Unknown PTY session' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (rec.data) res.write(`data: ${JSON.stringify({ t: 'out', sessionId, d: rec.data, replay: true })}\n\n`);
      const rec2 = attachSubscriber(sessionId, res);
      res.write(`data: ${JSON.stringify({ t: 'attached', sessionId, exited: rec2.exited, cols: rec2.cols, rows: rec2.rows })}\n\n`);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      res.on('close', () => clearInterval(ping));
      return;
    }

    // ---- detached processes (GUI/desktop apps, dev servers): start returns
    // immediately with an id+pid; lifecycle is tracked for accurate reports.
    if (sub === '/proc/start' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      if (!body.cmd) return sendJson(res, 400, { error: 'Missing cmd' });
      const screen = screenCommand(body.cmd, { confirm: body.confirm !== false });
      if (!screen.allowed) {
        return sendJson(res, screen.needsConfirm ? 403 : 400, {
          error: screen.reason, needsConfirm: !!screen.needsConfirm,
        });
      }
      log('proc_start', { wsId: ws.id, cmd: String(body.cmd).slice(0, 200) });
      broadcastEvent('proc_start', { workspaceId: ws.id, cmd: body.cmd });
      const proc = startProc({ cmd: body.cmd, cwd: body.cwd ? safeJoin(ws.path, body.cwd) : ws.path });
      return sendJson(res, 200, { proc: { ...proc, buf: undefined } });
    }
    if (sub === '/proc/list' && method === 'GET') {
      return sendJson(res, 200, { processes: listProcs() });
    }
    if (sub === '/proc/output' && method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const since = Number(url.searchParams.get('since') || 0);
      const r = procOutput(id, Number.isFinite(since) ? since : 0);
      if (!r) return sendJson(res, 404, { error: `Unknown process id: ${id}` });
      return sendJson(res, 200, r);
    }
    if (sub === '/proc/stop' && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const r = await stopProc(body.id);
      if (!r) return sendJson(res, 404, { error: `Unknown process id: ${body.id}` });
      log('proc_stop', { wsId: ws.id, id: body.id, status: r.status });
      return sendJson(res, 200, { proc: r });
    }
    // ---- shared browser (Forge upgrade — Part 6) ----
    // One shared CDP session per workspace; visible:false keeps it in the
    // background for automated verification. Unavailability is reported
    // honestly (agents must record UNVERIFIED, never a fake pass).
    if (sub === '/browser/open' && method === 'POST') {
      const body = await readBody(req, 64 * 1024).catch(() => ({}));
      const r = await browserOpen(ws, { url: body.url, visible: !!body.visible });
      log('browser_open', { wsId: ws.id, ok: !!r.ok, unavailable: r.unavailable });
      return sendJson(res, 200, r);
    }
    if (sub === '/browser/navigate' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      return sendJson(res, 200, await browserNavigate(ws, body.url));
    }
    if (sub === '/browser/eval' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      return sendJson(res, 200, await browserEval(ws, String(body.expression ?? '')));
    }
    if (sub === '/browser/screenshot' && method === 'POST') {
      const body = await readBody(req, 64 * 1024).catch(() => ({}));
      return sendJson(res, 200, await browserScreenshot(ws, body.path));
    }
    if (sub === '/browser/verify' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      const r = await browserVerify(ws, body);
      log('browser_verify', { wsId: ws.id, verdict: r.verdict || r.unavailable || '?', checks: r.checksTotal, consoleErrors: r.consoleErrors?.length });
      broadcastEvent('browser_verify', { workspaceId: ws.id, verdict: r.verdict || r.unavailable || '?' });
      return sendJson(res, 200, r);
    }
    if (sub === '/browser/close' && method === 'POST') {
      return sendJson(res, 200, await browserClose(ws.id));
    }
    if (sub === '/browser/status' && method === 'GET') {
      return sendJson(res, 200, browserStatus(ws.id));
    }
    if (sub === '/preview-token' && method === 'POST') {
      const body = await readBody(req, 8 * 1024).catch(() => ({}));
      if (body.previewDir !== undefined) { ws.previewDir = body.previewDir; saveState(); }
      const ptok = mintPreviewToken(ws.id);
      return sendJson(res, 200, {
        token: ptok,
        previewDir: ws.previewDir,
        url: `/preview/${ws.id}/${ptok}/`,
      });
    }
    return sendJson(res, 404, { error: `Unknown workspace route ${sub}` });
  }

  // ---- providers ----
  if (p === '/api/providers/discover' && method === 'POST') {
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    const found = await discoverProviders(body.extraUrls || [], {
      apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined,
    });
    // Credential availability hint for accurate UI messaging. The key itself
    // never crosses this boundary.
    return sendJson(res, 200, {
      providers: found,
      credentials: { lemonadeEnvKey: resolveLemonadeCredentials() ? 'available' : 'not-found' },
    });
  }
  if (p === '/api/providers/probe' && method === 'POST') {
    // Single-endpoint probe used by the IDE "Add endpoint" flow.
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    if (!body.url || typeof body.url !== 'string') {
      return sendJson(res, 400, { error: 'Missing provider url.' });
    }
    const r = await probeEndpoint(body.url, {
      apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined,
    });
    if (!r.reachable) {
      return sendJson(res, 200, { ...r, error: `No server answered at ${normalizeBaseUrl(body.url)}.` });
    }
    return sendJson(res, 200, r);
  }
  if (p === '/api/providers/models' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const models = await listModels(body.provider);
    return sendJson(res, 200, { models });
  }
  if (p === '/api/chat' && method === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    withCors(req, res);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    let aborted = false;
    req.on('close', () => { aborted = true; });
    // Keepalive (0.4.4): multi-minute prompt processing produces NO bytes;
    // emit a keepalive frame every 15 s so no intermediate hop (browser
    // fetch, proxies) mistakes the silence for a dead connection.
    const keepalive = setInterval(() => { if (!aborted && !res.writableEnded) writeNd(res, { t: 'keepalive' }); }, 15_000);
    try {
      await proxyChat(body, {
        write: (chunk) => { if (!aborted && !res.writableEnded) writeNd(res, chunk); },
        onClose: (fn) => req.on('close', fn),
      });
    } catch (e) {
      // errorKind (0.4.4): lets the IDE distinguish a slow-inference TIMEOUT
      // (server fine, request still processing) from a real DISCONNECT.
      const kind = e?.kind || 'unknown';
      writeNd(res, { t: 'error', message: String(e.message || e), errorKind: kind });
      log('chat_error', { kind, error: String(e.message || e).slice(0, 300) });
    } finally {
      clearInterval(keepalive);
    }
    if (!res.writableEnded) res.end();
    return;
  }
  if (p === '/api/models/load' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    return sendJson(res, 200, await loadModel(body.provider, body.model, body.keepAlive));
  }
  if (p === '/api/models/unload' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    return sendJson(res, 200, await unloadModel(body.provider, body.model));
  }
  if (p === '/api/models/probe-tools' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    return sendJson(res, 200, await probeToolSupport(body.provider, body.model));
  }
  if (p === '/api/models/test' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    return sendJson(res, 200, await testConnection(body.provider, body.model));
  }

  // ---- events (SSE) ----
  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  return sendJson(res, 404, { error: `Unknown API route: ${p}` });
}

function writeNd(res, obj) {
  if (res.writableEnded) return;
  try { res.write(JSON.stringify(obj) + '\n'); } catch {}
}

function relativeTo(root, abs) {
  const rel = path.relative(root, abs);
  return rel || '.';
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return root;
  return abs;
}

async function fsapifspReal(p) {
  try {
    const fsMod = await import('node:fs/promises');
    const real = await fsMod.realpath(p);
    const st = await fsMod.stat(real);
    if (!st.isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

// ---- WebSocket (direct mode: raw ws://127.0.0.1:7337/ws) ----
// Only wired when the optional `ws` package is installed; without it the
// HTTP/NDJSON/SSE surface below works identically.
const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;
server.on('upgrade', (req, socket, head) => {
  if (!wss) { socket.destroy(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (!isTokenValid(extractToken(req, url))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

if (wss) wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));
    if (msg.t === 'term_run') {
      const st = getState();
      const wsRec = findWorkspace(msg.wsId);
      if (!wsRec) return ws.send(JSON.stringify({ t: 'error', message: 'Unknown workspace' }));
      const screen = screenCommand(msg.cmd, { confirm: !!msg.confirm });
      if (!screen.allowed) {
        return ws.send(JSON.stringify({ t: 'denied', sessionId: msg.sessionId, message: screen.reason, needsConfirm: !!screen.needsConfirm }));
      }
      const sessionId = msg.sessionId || `s_${Date.now()}`;
      log('term_start', { wsId: wsRec.id, via: 'ws', cmd: String(msg.cmd).slice(0, 200) });
      const r = await runCommand({
        cmd: msg.cmd,
        cwd: msg.cwd ? safeJoin(wsRec.path, msg.cwd) : wsRec.path,
        timeoutMs: msg.timeoutMs,
        sessionId,
        registry: sessions,
        onChunk: (stream, data) => {
          if (stream === 'out' && data.includes('__LF_EOF')) {
            data = data.split('\n').filter((l) => !l.startsWith('__LF_EOF')).join('\n');
            if (!data) return;
          }
          try { ws.send(JSON.stringify({ t: stream, sessionId, d: data })); } catch {}
        },
      });
      const relCwd = r.cwd ? relativeTo(wsRec.path, r.cwd) : (msg.cwd || '.');
      try { ws.send(JSON.stringify({ t: 'exit', sessionId, code: r.exitCode, cwd: relCwd || '.', durMs: r.durMs, timedOut: r.timedOut })); } catch {}
    } else if (msg.t === 'term_sig') {
      killSession(sessions, msg.sessionId);
    }
  });
});

// ---- start ----
server.listen(config.port, config.host, () => {
  const bound = server.address();
  const boundPort = typeof bound === 'object' ? bound.port : config.port;
  config.port = boundPort;
  console.log(BANNER);
  console.log(`  Listening on http://${config.host}:${boundPort}`);
  // Milestone 2: mDNS advertisement + browsing (never pairs automatically;
  // the pairing code flow stays the only access grant). Disable with --no-mdns.
  const disc = startDiscovery({ enabled: !config.noMdns });
  if (disc.started) {
    console.log(`  LAN discovery: advertising via mDNS (${disc.serviceType}). Peers can find this machine; pairing still requires your code.`);
  } else if (disc.reason) {
    console.log(`  LAN discovery unavailable: ${disc.reason} — manual IP entry works as usual.`);
  }
  if (config.host !== '127.0.0.1' && !config.lan) {
    console.log('  WARNING: binding to a non-loopback address. Pass --lan to acknowledge.');
  }
  if (config.workspace) {
    upsertWorkspace(path.resolve(config.workspace), path.basename(config.workspace));
  }
  console.log(`
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │   PAIRING CODE:  ${getState().pairingCode}                        │
  │                                                 │
  │   Paste this code in the LocalForge IDE when    │
  │   prompted to connect this computer.            │
  │   Re-print any time:  localforge-companion --show-code │
  │                                                 │
  └─────────────────────────────────────────────────┘
`);
  console.log(`  Authorized workspaces: ${getState().workspaces.length}`);
  console.log(`  Logs: ${config.home}/logs/  (execution metadata only, never file contents)`);
  writeStatus(); // publish boot state for the tray GUI / installer tooling
});

function shutdown() {
  console.log('\n  Companion shutting down.');
  // Kill every running streaming session (build/dev-server children included)
  // so a stopped companion leaves no orphaned processes behind.
  let killed = 0;
  for (const [id] of sessions) {
    if (killSession(sessions, id)) killed++;
  }
  if (killed) console.log(`  Stopped ${killed} running session(s).`);
  // Milestone 1: reap every PTY shell (interactive terminals) too.
  let ptysKilled = 0;
  try { ptysKilled = stopAllSessions(); } catch { /* ignore */ }
  if (ptysKilled) console.log(`  Closed ${ptysKilled} PTY terminal(s).`);
  // Close headless browser sessions started for automated verification
  // (visible windows belong to the user and stay open, same policy as
  // detached processes).
  closeHeadlessSessions().catch(() => {});
  stopDiscovery();
  model.stopManagedModels();
  try { writeStatus({ stopping: true, stoppedAt: new Date().toISOString() }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
