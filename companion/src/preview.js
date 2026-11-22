// Preview serving: the IDE shows the built/created app in an iframe.
//  - GET /preview/:wsId/:ptok/*  -> serves static files from the workspace's
//    previewDir (configurable; e.g. "dist" for built apps, "." for static).
//  - GET|POST /p/:ptok/:port/*   -> reverse proxy to 127.0.0.1:port for dev
//    servers (vite/next). X-Frame-Options / CSP frame headers are stripped so
//    the IDE can embed it. (HMR websockets are not proxied in v1.)
// Preview tokens are short-lived and minted only for authenticated sessions.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInWorkspace, assertInsideReal, FsError } from './fsapi.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const previewTokens = new Map(); // ptok -> {wsId, exp}

export function mintPreviewToken(wsId, ttlMs = 3600_000) {
  const ptok = crypto.randomBytes(16).toString('hex');
  previewTokens.set(ptok, { wsId, exp: Date.now() + ttlMs });
  if (previewTokens.size > 100) {
    const now = Date.now();
    for (const [k, v] of previewTokens) if (v.exp < now) previewTokens.delete(k);
  }
  return ptok;
}

function checkPreviewToken(ptok, wsId) {
  const rec = previewTokens.get(ptok);
  if (!rec || rec.wsId !== wsId || rec.exp < Date.now()) return false;
  return true;
}

async function serveStatic(res, previewRoot, filePath, depthGuard = 0) {
  await assertInsideReal({ path: previewRoot }, filePath);
  let st = await fsp.stat(filePath).catch(() => null);
  if (st && st.isDirectory()) {
    return serveStatic(res, previewRoot, path.join(filePath, 'index.html'), depthGuard + 1);
  }
  if (!st && depthGuard === 0) {
    // pretty URLs: /about -> about.html
    return serveStatic(res, previewRoot, filePath + '.html', 1);
  }
  if (!st) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Preview: not found');
    return;
  }
  const data = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export async function handlePreview(req, res, url, ws) {
  // URL path: /preview/<wsId>/<ptok>/<file...>
  const parts = url.pathname.split('/').filter(Boolean); // [preview, wsId, ptok, ...file]
  if (parts.length < 3) {
    res.writeHead(400); res.end('Bad preview URL'); return;
  }
  const [, wsId, ptok, ...fileParts] = parts;
  if (!checkPreviewToken(ptok, wsId)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Preview token invalid or expired. Click refresh in the preview panel.');
    return;
  }
  const rel = fileParts.map(decodeURIComponent).join('/') || '.';
  try {
    const previewRoot = resolveInWorkspace(ws, ws.previewDir || '.');
    await assertInsideReal(ws, previewRoot);
    const abs = resolveInWorkspace({ path: previewRoot }, rel);
    await serveStatic(res, previewRoot, abs);
  } catch (e) {
    const status = e instanceof FsError ? e.status : 400;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end('Preview error: ' + e.message);
  }
}

// Reverse proxy for dev servers. Strips framing headers.
export function handleDevProxy(req, res, url, { ws, ptok, port, rest }) {
  if (!checkPreviewToken(ptok, ws.id)) {
    res.writeHead(403); res.end('Preview token invalid or expired.'); return;
  }
  const target = `http://127.0.0.1:${port}${rest || '/'}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  headers.accept = headers.accept || '*/*';
  const proxied = fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    duplex: 'half',
  }).then(async (up) => {
    const h = new Headers(up.headers);
    h.delete('x-frame-options');
    h.delete('content-security-policy');
    h.delete('content-security-policy-report-only');
    const out = {};
    h.forEach((v, k) => { out[k] = v; });
    res.writeHead(up.status, out);
    if (up.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(up.body).pipe(res);
    } else res.end();
  }).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    res.end(`<html><body style="font-family:sans-serif;background:#17171c;color:#e4e4e7;padding:24px">
      <h2>Dev server not reachable</h2><p>Companion could not connect to <code>127.0.0.1:${port}</code>.</p>
      <p style="color:#a1a1aa">${String(e.message || e)}</p>
      <p>Start your dev server (e.g. <code>npm run dev</code> in the terminal panel), then refresh.</p></body></html>`);
  });
  req.on('close', () => { /* fetch handles abort via body stream */ });
  return proxied;
}
