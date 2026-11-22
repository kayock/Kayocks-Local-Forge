// Slow-inference end-to-end (0.4.4): slow local inference is NOT an outage.
//
// Recreates the release verification: a model server that produces its first
// byte after 375 s — deliberately PAST the ~300 s idle point where the old
// runtime fetch killed valid requests and the IDE reported a false outage.
// Expected: no error frames, keepalives during the silence, exactly ONE
// upstream request (no duplicate retry), and a clean end frame.
//
// Env overrides: SLOW_MS (first-byte delay), COMPANION_PORT, UPSTREAM_PORT.
// Default SLOW_MS = 375000 to mirror the release e2e.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SLOW_MS = Number(process.env.SLOW_MS || 375000);
const COMPANION_PORT = Number(process.env.COMPANION_PORT || 23520);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 23521);
const companionBase = `http://127.0.0.1:${COMPANION_PORT}`;
const results: string[] = [];
const note = (s: string) => { results.push(s); console.log(s); };

let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits++;
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'slow but alive' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, SLOW_MS);
});
await new Promise<void>((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', () => r()));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-slow-e2e-'));
const companion = spawn(process.execPath, ['src/server.js', '--port', String(COMPANION_PORT), '--home', home, '--no-browser-hint'], {
  cwd: path.resolve(new URL('.', import.meta.url).pathname, '..', 'companion'),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ok = false;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${companionBase}/health`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  const pairRes = await fetch(`${companionBase}/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'slow-e2e' }),
  });
  const { token } = await pairRes.json();
  if (!token) throw new Error('pairing failed');

  note(`upstream: first byte after ${SLOW_MS} ms (past the old ~300 s kill point)`);
  const started = Date.now();
  const chatRes = await fetch(`${companionBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      provider: { kind: 'openai', baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}` },
      model: 'slow-model',
      messages: [{ role: 'user', content: 'Think for a long time, then answer.' }],
    }),
  });
  if (chatRes.status !== 200) throw new Error(`chat HTTP ${chatRes.status}`);

  const frames: any[] = [];
  const reader = chatRes.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) frames.push(JSON.parse(line));
    }
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  const errors = frames.filter((f) => f.t === 'error');
  const keepalives = frames.filter((f) => f.t === 'keepalive').length;
  const ends = frames.filter((f) => f.t === 'end').length;
  const text = frames.filter((f) => f.t === 'text').map((f) => f.v).join('');

  note(`elapsed: ${elapsed}s; frames: ${frames.length}; keepalives: ${keepalives}; errors: ${errors.length}; ends: ${ends}`);
  if (errors.length) note(`ERROR FRAMES: ${JSON.stringify(errors)}`);

  const checks = [
    ['no error frames (no false outage)', errors.length === 0],
    ['keepalive frames during silence', keepalives >= Math.floor(SLOW_MS / 15000) - 1],
    ['text content streamed fully', text.includes('slow but alive')],
    ['exactly one end frame', ends === 1],
    ['exactly one upstream request (no duplicate retry)', upstreamHits === 1],
  ];
  for (const [name, pass] of checks) note(`${pass ? 'PASS' : 'FAIL'} — ${name}`);
  ok = checks.every(([, pass]) => pass);
} catch (e: any) {
  note(`FAIL — exception: ${e?.message || e}`);
  ok = false;
} finally {
  try { companion?.kill(); } catch { /* ignore */ }
  try { upstream?.close(); } catch { /* ignore */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.writeFileSync(new URL('./slow-e2e-result.txt', import.meta.url), results.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}
