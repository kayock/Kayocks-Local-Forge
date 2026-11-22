// Companion INTEGRATION tests — boots the REAL companion HTTP server on a
// random port with an isolated state home, pairs, and exercises the REST
// contract end to end (Forge upgrade: includes the new /stat, /extract,
// health resources and shared-browser endpoints).
//
// Note: this is a REAL hardware test on the machine running it (labeled as
// such). The browser-verify assertions expect an honest "unavailable" reply
// when no local browser exists, and pass with evidence when one does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

let server = null;
let base = '';
let token = '';
let wsId = '';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-int-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-int-ws-'));

function req(method, p, { body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${base}${p}`, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function makeStoreZip(members) {
  const locals = []; const centrals = []; let off = 0;
  for (const [name, data] of members) {
    const nameBuf = Buffer.from(name);
    const dataBuf = Buffer.from(data, 'utf8');
    const crc = crc32(dataBuf);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(dataBuf.length, 18); l.writeUInt32LE(dataBuf.length, 22); l.writeUInt16LE(nameBuf.length, 26);
    locals.push(l, nameBuf, dataBuf);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(dataBuf.length, 20); c.writeUInt32LE(dataBuf.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(off, 42);
    centrals.push(c, nameBuf);
    off += 30 + nameBuf.length + dataBuf.length;
  }
  const cdStart = off; const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

before(async () => {
  const port = 23380 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--no-browser-hint'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for the health endpoint to answer
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  // read the pairing code from the isolated state file
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.ok(state.pairingCode, 'pairing code must exist in the isolated state');
  const pairRes = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'integration-test' }),
  });
  const pairJson = await pairRes.json();
  assert.equal(pairRes.status, 200, `pairing failed: ${JSON.stringify(pairJson)}`);
  token = pairJson.token;
  assert.ok(token);
});

after(() => {
  try { server?.kill(); } catch { /* ignore */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('unauthenticated API calls are rejected with 401', async () => {
  const r = await req('GET', '/api/workspaces', { auth: false });
  assert.equal(r.status, 401);
});

test('health exposes machine resources for the Fleet Map', async () => {
  const r = await req('GET', '/health', { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.resources, 'resources block missing');
  assert.ok(r.json.resources.cpus > 0);
  assert.ok(typeof r.json.resources.memTotal === 'number');
  assert.ok(r.json.resources.hostname);
});

test('workspace open → file write/read → tree', async () => {
  const open = await req('POST', '/api/workspaces', { body: { path: workspace, name: 'integration-ws' } });
  assert.equal(open.status, 200);
  wsId = open.json.workspace.id;
  assert.ok(wsId);

  const write = await req('PUT', `/api/ws/${wsId}/file`, { body: { path: 'src/main.py', content: 'print("integration")\n' } });
  assert.equal(write.status, 200);
  const readRes = await fetch(`${base}/api/ws/${wsId}/file?path=src/main.py`, { headers: { Authorization: `Bearer ${token}` } });
  const readJson = await readRes.json();
  assert.equal(readJson.content, 'print("integration")\n');

  const tree = await req('GET', `/api/ws/${wsId}/tree`);
  assert.ok(tree.json.entries.some((e) => e.path === 'src/main.py'));
  assert.equal(tree.json.root, path.resolve(workspace));
});

test('REAL /stat endpoint: missing vs empty vs file', async () => {
  const missing = await req('GET', `/api/ws/${wsId}/stat?path=${encodeURIComponent('does-not-exist')}`);
  assert.equal(missing.status, 200);
  assert.equal(missing.json.exists, false);
  assert.equal(missing.json.parentExists, true);

  fs.mkdirSync(path.join(workspace, 'empty-dir'));
  const empty = await req('GET', `/api/ws/${wsId}/stat?path=empty-dir`);
  assert.equal(empty.json.exists, true);
  assert.equal(empty.json.empty, true);

  const file = await req('GET', `/api/ws/${wsId}/stat?path=src/main.py`);
  assert.equal(file.json.exists, true);
  assert.equal(file.json.type, 'file');
});

test('REAL /extract endpoint: nested project root detected and reported', async () => {
  fs.writeFileSync(path.join(workspace, 'calculator repo.zip'), makeStoreZip([
    ['calculator repo/', ''],
    ['calculator repo/main.py', 'print(1)'],
    ['calculator repo/README.md', '# calc'],
  ]));
  const r1 = await req('POST', `/api/ws/${wsId}/extract`, { body: { path: 'calculator repo.zip', dest: '.' } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.nestedRoot, 'calculator repo');
  assert.equal(r1.json.flattened, false);
  assert.ok(fs.existsSync(path.join(workspace, 'calculator repo/main.py')));
  assert.match(r1.json.note, /nested project root/);

  const r2 = await req('POST', `/api/ws/${wsId}/extract`, { body: { path: 'calculator repo.zip', dest: 'flat', flatten: true } });
  assert.equal(r2.json.flattened, true);
  assert.ok(fs.existsSync(path.join(workspace, 'flat/main.py')));
});

test('REAL exec: echo runs and reports exit code 0 with captured stdout', async () => {
  const r = await req('POST', `/api/ws/${wsId}/exec`, { body: { cmd: 'echo integration-ok', confirm: false } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.exitCode, 0);
  assert.match(r.json.stdout, /integration-ok/);
});

test('REAL exec: non-zero exits are reported truthfully', async () => {
  const r = await req('POST', `/api/ws/${wsId}/exec`, { body: { cmd: process.platform === 'win32' ? 'exit /b 3' : 'sh -c "exit 3"', confirm: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.exitCode, 3);
});

test('REAL browser endpoints: honest status, and verify reports unavailability when no browser exists', async () => {
  const status = await req('GET', `/api/ws/${wsId}/browser/status`);
  assert.equal(status.status, 200);
  assert.equal(status.json.running, false);

  const verify = await req('POST', `/api/ws/${wsId}/browser/verify`, { body: { url: 'http://127.0.0.1:9/health', checks: [] } });
  assert.equal(verify.status, 200);
  if (verify.json.unavailable) {
    // no browser on this machine — the honest answer (never a fake pass)
    assert.match(verify.json.unavailable, /browser/i);
  } else {
    // a browser IS available here — evidence must be structured
    assert.ok(verify.json.verdict);
    assert.ok(Array.isArray(verify.json.checks));
    assert.ok(Array.isArray(verify.json.consoleErrors));
  }
  const close = await req('POST', `/api/ws/${wsId}/browser/close`);
  assert.equal(close.status, 200);
});
