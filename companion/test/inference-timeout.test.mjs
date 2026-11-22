// Inference timeout suite (0.4.4): slow local inference is NOT an outage.
//
// Covers the exact behaviors the 0.4.4 release promised:
//   - configurable timeout ladder (request > provider > env > 20 min default)
//   - the transport uses node:http (no runtime fetch idle-kill at ~300 s)
//   - a slow model server produces text + end frames, never a false outage
//   - when the inference timeout DOES fire it is classified 'timeout' and the
//     request is NOT retried (no duplicate queued behind the busy server)
//   - a client disconnect is classified 'client-abort' (not a failure)
//   - the /api/chat route emits keepalive frames during silent processing
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  proxyChat, ChatProxyError,
  resolveChatTimeoutMs, DEFAULT_CHAT_TIMEOUT_MS, classifyChatError,
} from '../src/providers.js';

// ---- shared mock model server ----
let upstream = null;
let upstreamPort = 0;
let upstreamHits = 0;
let upstreamHandler = null; // (req, res) => void, set per test

before(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits++;
    const h = upstreamHandler || ((rq, rs) => { rs.end(); });
    h(req, res);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
});

after(() => {
  try { upstream?.close(); } catch { /* ignore */ }
});

function openaiSse(res, { firstByteDelayMs = 0, chunks = ['Hello'], holdOpenMs = 0 } = {}) {
  const writeChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) writeChunk({ choices: [{ delta: { content: c } }] });
    writeChunk({ choices: [{ finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    const finish = () => res.end();
    holdOpenMs ? setTimeout(finish, holdOpenMs) : finish();
  }, firstByteDelayMs);
}

function callProxyChat({ params = {}, provider } = {}) {
  const frames = [];
  let closeFn = null;
  const promise = proxyChat(
    {
      provider: provider ?? { kind: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}` },
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      params,
    },
    { write: (f) => frames.push(f), onClose: (fn) => { closeFn = fn; } },
  );
  return { promise, frames, abortFromClient: () => closeFn?.() };
}

// ---- timeout ladder ----
test('resolveChatTimeoutMs: request params win over provider, env and default', () => {
  assert.equal(resolveChatTimeoutMs({ chatTimeoutSec: 60 }, { timeoutMs: 5000 }), 5000);
  assert.equal(resolveChatTimeoutMs({ chatTimeoutSec: 60 }, {}), 60_000);
});

test('resolveChatTimeoutMs: env override beats the 20-minute default', () => {
  const prev = process.env.LOCALFORGE_CHAT_TIMEOUT_MS;
  try {
    delete process.env.LOCALFORGE_CHAT_TIMEOUT_MS;
    assert.equal(resolveChatTimeoutMs({}, {}), DEFAULT_CHAT_TIMEOUT_MS);
    assert.equal(DEFAULT_CHAT_TIMEOUT_MS, 20 * 60 * 1000);
    process.env.LOCALFORGE_CHAT_TIMEOUT_MS = '45000';
    assert.equal(resolveChatTimeoutMs({}, {}), 45000);
  } finally {
    if (prev === undefined) delete process.env.LOCALFORGE_CHAT_TIMEOUT_MS; else process.env.LOCALFORGE_CHAT_TIMEOUT_MS = prev;
  }
});

// ---- error classification ----
test('classifyChatError separates timeout, client-abort and disconnect', () => {
  assert.equal(classifyChatError(new Error('Request timed out')), 'timeout');
  const dom = new Error('This operation was aborted'); dom.name = 'AbortError';
  assert.equal(classifyChatError(dom), 'client-abort');
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:8080');
  assert.equal(classifyChatError(refused), 'disconnect');
  const undici = new Error('fetch failed'); undici.cause = { code: 'ECONNRESET' };
  assert.equal(classifyChatError(undici), 'disconnect');
  assert.equal(classifyChatError(new Error('something odd')), 'unknown');
});

test('ChatProxyError carries its kind', () => {
  assert.equal(new ChatProxyError('boom', 'timeout').kind, 'timeout');
  assert.equal(new ChatProxyError('boom').kind, 'unknown');
});

// ---- transport behavior ----
test('slow inference (first byte after 1.2 s) streams normally — no false outage, single upstream request', async () => {
  upstreamHits = 0;
  upstreamHandler = (req, res) => openaiSse(res, { firstByteDelayMs: 1200 });
  const { promise, frames } = callProxyChat({ params: { timeoutMs: 10000 } });
  await promise;
  const errors = frames.filter((f) => f.t === 'error');
  assert.equal(errors.length, 0, `expected no error frames, got ${JSON.stringify(errors)}`);
  assert.ok(frames.some((f) => f.t === 'text' && f.v === 'Hello'));
  assert.equal(frames.filter((f) => f.t === 'end').length, 1);
  assert.equal(upstreamHits, 1, 'exactly one upstream request — no retry, no duplicate');
});

test('inference timeout fires honestly: kind=timeout, explicit NOT-an-outage wording, no retry', async () => {
  upstreamHits = 0;
  upstreamHandler = (req, res) => { /* never responds */ };
  const { promise } = callProxyChat({ params: { timeoutMs: 400 } });
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof ChatProxyError);
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /NOT a connection failure/);
    assert.match(e.message, /timed out after/);
    return true;
  });
  assert.equal(upstreamHits, 1, 'timeout must not trigger any retry');
});

test('client disconnect mid-stream is classified client-abort (not disconnect, not retry)', async () => {
  upstreamHits = 0;
  upstreamHandler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let n = 0;
    const t = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'chunk' } }] })}\n\n`);
      if (++n > 30) { clearInterval(t); res.end(); }
    }, 150);
    req.on('close', () => clearInterval(t));
  };
  const { promise, frames, abortFromClient } = callProxyChat({ params: { timeoutMs: 60000 } });
  await new Promise((r) => setTimeout(r, 400)); // let the first chunk arrive
  const textBefore = frames.filter((f) => f.t === 'text').length;
  assert.ok(textBefore >= 1, 'should have received text before the abort');
  abortFromClient();
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof ChatProxyError);
    assert.equal(e.kind, 'client-abort');
    return true;
  });
  assert.equal(upstreamHits, 1, 'client abort must not trigger a retry');
});

// ---- route-level: keepalive frames during silent prompt processing ----
test('/api/chat emits keepalive frames while the model server is silent, then completes', async () => {
  const port = 23480 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-timeout-int-'));
  const server = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--no-browser-hint'], {
    cwd: path.resolve(new URL('.', import.meta.url).pathname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    const pairRes = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'timeout-test' }),
    });
    const { token } = await pairRes.json();
    assert.ok(token);

    upstreamHits = 0;
    upstreamHandler = (req, res) => openaiSse(res, { firstByteDelayMs: 16200 });

    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        provider: { kind: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}` },
        model: 'test-model',
        messages: [{ role: 'user', content: 'slow prompt' }],
      }),
    });
    assert.equal(chatRes.status, 200);
    const frames = [];
    const reader = chatRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) frames.push(JSON.parse(line));
      }
    }
    const firstText = frames.findIndex((f) => f.t === 'text');
    assert.ok(firstText > 0, 'text must arrive after at least one earlier frame');
    const keepalives = frames.slice(0, firstText).filter((f) => f.t === 'keepalive');
    assert.ok(keepalives.length >= 1, `expected keepalive frames during 16.2 s of silence, got ${JSON.stringify(frames.slice(0, firstText))}`);
    assert.equal(frames.filter((f) => f.t === 'end').length, 1);
    assert.equal(frames.filter((f) => f.t === 'error').length, 0);
    assert.equal(upstreamHits, 1, 'single upstream request across the whole slow inference');
  } finally {
    try { server?.kill(); } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('upstream HTTP error surfaces with an errorKind (http-error)', async () => {
  upstreamHits = 0;
  upstreamHandler = (req, res) => { res.writeHead(500); res.end('model exploded'); };
  const { promise, frames } = callProxyChat({});
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof ChatProxyError);
    assert.equal(e.kind, 'http-error');
    return true;
  });
  // server.js would surface this as { t:'error', errorKind:'http-error' };
  // at the transport boundary the throw carries the same classification.
  assert.equal(upstreamHits, 1);
});
