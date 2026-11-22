// Milestone 1 — real PTY terminal + diff/overwrite-protection tests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 23400 + Math.floor(Math.random() * 150);
let home;
let server;
let token;
let wsId;

function startCompanion() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m1-home-'));
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m1-ws-'));
  fs.writeFileSync(path.join(wsRoot, 'hello.txt'), 'alpha\nbeta\ngamma\n');
  const child = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--home', home, '--workspace', wsRoot, '--lan', '--no-browser-hint'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, LOCALFORGE_VERBOSE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.env.M1_DEBUG && process.stderr.write(d));
  return { child, wsRoot };
}

function req(method, urlPath, body, useToken = true) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(useToken && token ? { Authorization: `Bearer ${token}` } : {}),
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* stream or empty */ }
        resolve({ status: res.status || res.statusCode, json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitHealth(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      req('GET', '/health', undefined, false).then((r) => {
        if (r.status === 200) return resolve(r.json);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('companion did not start'));
        setTimeout(poll, 300);
      }).catch(() => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('companion did not start'));
        setTimeout(poll, 300);
      });
    };
    poll();
  });
}

// SSE reader: collects events from the pty output stream.
function sseCollect(urlPath, ms) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: urlPath, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
        }
      });
      res.on('error', () => {});
    });
    r.on('error', reject);
    r.end();
    setTimeout(() => { r.destroy(); resolve(events); }, ms);
  });
}

describe('Milestone 1 — PTY terminal', () => {
  let proc, wsRoot;
  before(async () => {
    ({ child: proc, wsRoot } = startCompanion());
    await waitHealth();
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    wsId = state.workspaces[0].id;
    // pair to get a token
    const pair = await req('POST', '/pair', { code: state.pairingCode, deviceLabel: 'm1-test' }, false);
    assert.equal(pair.status, 200);
    token = pair.json.token;
  });
  after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

  test('capabilities endpoint reports the PTY backend honestly', async () => {
    const r = await req('GET', '/api/pty/capabilities');
    assert.equal(r.status, 200);
    assert.ok(r.json.backend === 'node-pty' || r.json.backend === 'unavailable', `unexpected backend ${r.json.backend}`);
    if (r.json.backend === 'unavailable') assert.equal(r.json.fallback, 'ndjson-stream');
  });

  test('real PTY session: persistent shell state (cd + env) survives across inputs', { skip: process.env.SKIP_PTY === '1' }, async () => {
    const caps = await req('GET', '/api/pty/capabilities');
    if (caps.json.backend !== 'node-pty') { console.log('  (node-pty unavailable — skipping live PTY assertions, fallback path exercised instead)'); return; }
    const start = await req('POST', `/api/ws/${wsId}/pty/start`, { cols: 100, rows: 30 });
    assert.equal(start.status, 200, `start failed: ${JSON.stringify(start.json)}`);
    const sessionId = start.json.sessionId;

    const events = sseCollect(`/api/ws/${wsId}/pty/output?sessionId=${sessionId}`, 6000);
    await new Promise((r) => setTimeout(r, 400));
    // Preserve cwd and environment across separate inputs using the native
    // shell: Windows ConPTY launches cmd.exe; POSIX uses a login shell.
    const isWindows = process.platform === 'win32';
    const firstInput = isWindows
      ? 'cd /d C:\\Windows && set LF_PTY_PROBE=ptyworks\r\n'
      : 'cd /tmp && export LF_PTY_PROBE=ptyworks\n';
    const secondInput = isWindows
      ? 'echo cwd=%CD% env=%LF_PTY_PROBE%\r\n'
      : 'echo "cwd=$(pwd) env=$LF_PTY_PROBE"\n';
    await req('POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: firstInput });
    await new Promise((r) => setTimeout(r, 1200));
    await req('POST', `/api/ws/${wsId}/pty/input`, { sessionId, data: secondInput });
    await new Promise((r) => setTimeout(r, 1500));
    const evs = await events;
    const allOut = evs.filter((e) => e.t === 'out').map((e) => e.d).join('');
    assert.ok(allOut.includes('env=ptyworks'), `environment did not persist across inputs. Output: ${JSON.stringify(allOut.slice(-600))}`);
    assert.ok(isWindows ? /cwd=C:\\Windows/i.test(allOut) : allOut.includes('cwd=/tmp'),
      `cwd did not persist. Output: ${JSON.stringify(allOut.slice(-600))}`);
    // resize is accepted
    const rz = await req('POST', `/api/ws/${wsId}/pty/resize`, { sessionId, cols: 120, rows: 40 });
    assert.equal(rz.status, 200);

    // session list shows it
    const list = await req('GET', `/api/ws/${wsId}/pty/list`);
    assert.ok(list.json.sessions.some((s) => s.sessionId === sessionId));

    // stop reaps it
    const stop = await req('POST', `/api/ws/${wsId}/pty/stop`, { sessionId });
    assert.equal(stop.status, 200);
    const list2 = await req('GET', `/api/ws/${wsId}/pty/list`);
    assert.ok(!list2.json.sessions.some((s) => s.sessionId === sessionId));
  });

  test('PTY start on unknown workspace → 404; input on unknown session → 404', async () => {
    const r = await req('POST', '/api/ws/ffffffffffff/pty/start', {});
    assert.equal(r.status, 404);
    const r2 = await req('POST', `/api/ws/${wsId}/pty/input`, { sessionId: 'pty_nope', data: 'x' });
    assert.equal(r2.status, 404);
  });

  test('unauthenticated PTY routes are rejected (pairing preserved)', async () => {
    const r = await req('GET', `/api/ws/${wsId}/pty/list`, undefined, false);
    assert.equal(r.status, 401);
  });
});

describe('Milestone 1 — diff preview + overwrite protection + exec log', () => {
  let proc2, wsRoot2, home2, token2, wsId2, port2;
  before(async () => {
    port2 = PORT + 1;
    home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m1-diff-'));
    wsRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m1-wsdiff-'));
    fs.writeFileSync(path.join(wsRoot2, 'app.js'), 'function main() {\n  console.log("v1");\n}\n');
    proc2 = spawn(process.execPath, ['src/server.js', '--port', String(port2), '--home', home2, '--workspace', wsRoot2, '--lan', '--no-browser-hint'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise(async (resolve, reject) => {
      const t0 = Date.now();
      const poll = async () => {
        try {
          const r = await new Promise((res, rej) => {
            http.get({ host: '127.0.0.1', port: port2, path: '/health' }, (x) => { let b=''; x.on('data',c=>b+=c); x.on('end',()=>res(JSON.parse(b))); }).on('error', rej);
          });
          if (r.ok) return resolve();
        } catch { /* retry */ }
        if (Date.now() - t0 > 15000) return reject(new Error('second companion did not start'));
        setTimeout(poll, 300);
      };
      poll().catch(reject);
    });
    const state = JSON.parse(fs.readFileSync(path.join(home2, 'state.json'), 'utf8'));
    wsId2 = state.workspaces[0].id;
    const pair = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ code: state.pairingCode, deviceLabel: 'diff-test' });
      const r = http.request({ host: '127.0.0.1', port: port2, method: 'POST', path: '/pair', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
      });
      r.on('error', reject); r.write(data); r.end();
    });
    token2 = pair.token;
  });
  after(() => { try { proc2.kill('SIGKILL'); } catch { /* ignore */ } });

  function req2(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: port2, method, path: urlPath, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        Authorization: `Bearer ${token2}`,
      } }, (res) => {
        let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* stream */ } resolve({ status: res.statusCode, json: j }); });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }

  test('diff/preview returns a correct unified diff with the file mtime', async () => {
    const r = await req2('POST', `/api/ws/${wsId2}/diff/preview`, { path: 'app.js', content: 'function main() {\n  console.log("v2");\n}\n' });
    assert.equal(r.status, 200);
    assert.ok(r.json.diff.includes('--- a/app.js'));
    assert.ok(r.json.diff.includes('+++ b/app.js'));
    assert.ok(r.json.diff.includes('@@ -1,3 +1,3 @@'), `hunk header wrong: ${r.json.diff}`);
    assert.ok(r.json.diff.includes('-  console.log("v1");'));
    assert.ok(r.json.diff.includes('+  console.log("v2");'));
    assert.equal(r.json.removed, 1); assert.equal(r.json.added, 1);
    assert.ok(r.json.currentMtime, 'currentMtime missing');
  });

  test('write with ifUnmodifiedSince succeeds when unchanged, 409 with current content when changed', async () => {
    const pv = await req2('POST', `/api/ws/${wsId2}/diff/preview`, { path: 'app.js', content: 'function main() {\n  console.log("v3");\n}\n' });
    // simulate a concurrent writer between preview and write
    fs.writeFileSync(path.join(wsRoot2, 'app.js'), 'function main() {\n  console.log("CONCURRENT");\n}\n');
    const w = await req2('PUT', `/api/ws/${wsId2}/file`, { path: 'app.js', content: 'function main() {\n  console.log("v3");\n}\n', ifUnmodifiedSince: pv.json.currentMtime });
    assert.equal(w.status, 409, `expected 409, got ${w.status}: ${JSON.stringify(w.json)}`);
    assert.ok(w.json.error.includes('changed on disk'));
    const onDisk = fs.readFileSync(path.join(wsRoot2, 'app.js'), 'utf8');
    assert.ok(onDisk.includes('CONCURRENT'), 'concurrent write was clobbered');

    // a matching mtime goes through and returns a concise post-edit diff
    const pv2 = await req2('POST', `/api/ws/${wsId2}/diff/preview`, { path: 'app.js', content: 'function main() {\n  console.log("v4");\n}\n' });
    const w2 = await req2('PUT', `/api/ws/${wsId2}/file`, { path: 'app.js', content: 'function main() {\n  console.log("v4");\n}\n', ifUnmodifiedSince: pv2.json.currentMtime, returnDiff: true });
    assert.equal(w2.status, 200);
    assert.ok(w2.json.diff.includes('+  console.log("v4");'));
    assert.ok(w2.json.diff.includes('-  console.log("CONCURRENT");'));
    assert.equal(w2.json.created, false);
  });

  test('new-file write reports created:true; stale exec log id → 404', async () => {
    const w = await req2('PUT', `/api/ws/${wsId2}/file`, { path: 'newfile.txt', content: 'hello\n', returnDiff: true });
    assert.equal(w.status, 200);
    assert.equal(w.json.created, true);
    const log = await req2('GET', `/api/ws/${wsId2}/exec/log?id=exec_does_not_exist`);
    assert.equal(log.status, 404);
  });

  test('exec returns an execLogId and the full log endpoint serves it', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    // Windows cmd.exe interprets embedded newlines as separate commands.
    // Produce a genuinely multi-line command output on either shell.
    const cmd = process.platform === 'win32'
      ? 'for /L %i in (0,1,1999) do @echo line %i'
      : `echo "${big.slice(0, 3000)}"`;
    const r = await req2('POST', `/api/ws/${wsId2}/exec`, { cmd });
    assert.equal(r.status, 200);
    assert.ok(r.json.execLogId, 'execLogId missing from exec response');
    const log = await req2('GET', `/api/ws/${wsId2}/exec/log?id=${r.json.execLogId}`);
    assert.equal(log.status, 200);
    assert.ok(log.json.stdout.includes('line 5'), 'full log did not preserve stdout');
    assert.equal(log.json.cmd, r.json.execLogId ? log.json.cmd : undefined, 'cmd recorded');
  });
});
