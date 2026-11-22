// Milestone 2 — discovery, pairing, task packets, write reservations, mesh
// proxy of the workspace surface. Boots TWO real Companion instances on the
// loopback LAN and exercises the full distributed flow.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const COMPANION_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

function boot({ home, wsRoot, port }) {
  const proc = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--workspace', wsRoot, '--lan', '--no-browser-hint'], {
    cwd: COMPANION_DIR,
    env: { ...process.env, LOCALFORGE_BONJOUR_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => { if (process.env.M2_DEBUG) process.stderr.write(d); });
  return proc;
}

function req(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => { r.destroy(new Error('request timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(port, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await req(port, 'GET', '/health', undefined, undefined);
      if (r.status === 200) return r.json;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`companion on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function pair(port, homeDir) {
  const state = JSON.parse(fs.readFileSync(path.join(homeDir, 'state.json'), 'utf8'));
  const r = await req(port, 'POST', '/pair', { code: state.pairingCode, deviceLabel: 'm2-test' });
  assert.equal(r.status, 200, `pair failed: ${JSON.stringify(r.json)}`);
  return r.json.token;
}

describe('Milestone 2 — discovery + distributed orchestration', () => {
  let procA, procB, homeA, homeB, wsA, wsB, portA, portB, tokenA, tokenB, wsIdA, wsIdB;

  before(async () => {
    portA = 23500 + Math.floor(Math.random() * 100);
    portB = portA + 1;
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m2-a-'));
    homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m2-b-'));
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m2-wsa-'));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m2-wsb-'));
    fs.writeFileSync(path.join(wsA, 'README.md'), '# workspace A\nshared project\n');
    fs.writeFileSync(path.join(wsB, 'README.md'), '# workspace B\nshared project\n');
    procA = boot({ home: homeA, wsRoot: wsA, port: portA });
    procB = boot({ home: homeB, wsRoot: wsB, port: portB });
    await waitHealth(portA);
    await waitHealth(portB);
    tokenA = await pair(portA, homeA);
    tokenB = await pair(portB, homeB);
    const stA = JSON.parse(fs.readFileSync(path.join(homeA, 'state.json'), 'utf8'));
    wsIdA = stA.workspaces[0].id;
  });

  after(() => {
    for (const p of [procA, procB]) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
  });

  test('both companions advertise over mDNS with identifying info only', async () => {
    const a = await req(portA, 'GET', '/api/mesh/discover', undefined, tokenA);
    assert.equal(a.status, 200);
    assert.equal(a.json.available, true, `discovery should be available: ${JSON.stringify(a.json)}`);
    assert.equal(a.json.self.advertising, true, 'companion A is not advertising');
    assert.ok(a.json.self.instanceId, 'self.instanceId missing');
    assert.ok(a.json.self.name, 'self.name missing');
  });

  test('companions discover each other via mDNS (no auto-pairing)', async () => {
    // bonjour browse can take a few seconds
    let seenB = null;
    for (let i = 0; i < 40 && !seenB; i++) {
      const a = await req(portA, 'GET', '/api/mesh/discover', undefined, tokenA);
      seenB = (a.json.discovered || []).find((d) => d.platform === process.platform && !d.local && d.port === portB && d.online);
      if (!seenB) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(seenB, `companion A did not discover B within 20s: ${JSON.stringify((await req(portA, 'GET', '/api/mesh/discover', undefined, tokenA)).json.discovered)}`);
    // the advertised URL must point at the service port; the host is the LAN
    // interface address (correct for remote machines; same-host instances
    // also reach it)
    assert.equal(seenB.port, portB);
    assert.ok(seenB.url.endsWith(`:${portB}`), `unexpected url ${seenB.url}`);
    assert.ok(seenB.host, 'advertised host missing');
    assert.ok(seenB.version, 'advertised version missing');
    assert.equal(seenB.paired ?? undefined, undefined, 'discovery must not carry pairing credentials');
  });

  test('manual pairing via existing code flow works from discovery info; inventories exchange', async () => {
    // A pairs with B using the user-approved code flow (discovery never grants access)
    const connect = await req(portA, 'POST', '/api/mesh/connect', { url: `http://127.0.0.1:${portB}`, name: 'machine-b' }, tokenA);
    assert.equal(connect.status, 200, `connect failed: ${JSON.stringify(connect.json)}`);
    const stB = JSON.parse(fs.readFileSync(path.join(homeB, 'state.json'), 'utf8'));
    const pairRes = await req(portA, 'POST', `/api/mesh/peers/${connect.json.peer.id}/pair`, { code: stB.pairingCode, deviceLabel: 'companion-a' }, tokenA);
    assert.equal(pairRes.status, 200, `pairing failed: ${JSON.stringify(pairRes.json)}`);

    const status = await req(portA, 'GET', `/api/mesh/peers/${connect.json.peer.id}`, undefined, tokenA);
    assert.equal(status.status, 200);
    assert.equal(status.json.reachable, true);
    assert.ok(status.json.hardware, 'hardware inventory not exchanged after pairing');
    assert.ok(status.json.hardware.cpuCores >= 1, 'cpu inventory missing');
  });

  test('mesh proxy carries the workspace tool surface (tree/read/exec/diff/revision)', async () => {
    const status = await req(portA, 'GET', '/api/mesh/status', undefined, tokenA);
    const peer = status.json.peers[0];
    assert.ok(peer?.paired, 'peer should be paired');
    // B's own workspace id (ids are sha1 of the realpath, so they differ per machine)
    const stB = JSON.parse(fs.readFileSync(path.join(homeB, 'state.json'), 'utf8'));
    const wsIdB = stB.workspaces[0].id;
    const tree2 = await req(portA, 'GET', `/api/mesh/${peer.id}/proxy/api/ws/${wsIdB}/tree?depth=2`, undefined, tokenA);
    assert.equal(tree2.status, 200, `proxy tree failed: ${tree2.raw?.slice(0, 200)}`);
    assert.ok(tree2.json.entries.some((e) => e.path === 'README.md'));
    const rev = await req(portA, 'GET', `/api/mesh/${peer.id}/proxy/api/ws/${wsIdB}/revision`, undefined, tokenA);
    assert.equal(rev.status, 200);
    assert.ok(rev.json.revision.length === 64);
    const ex = await req(portA, 'POST', `/api/mesh/${peer.id}/proxy/api/ws/${wsIdB}/exec`, { cmd: 'echo proxied-ok' }, tokenA);
    assert.equal(ex.status, 200, `proxy exec failed: ${ex.raw?.slice(0, 300)}`);
    assert.equal(ex.json.exitCode, 0);
    assert.ok(ex.json.stdout.includes('proxied-ok'));
    const diff = await req(portA, 'POST', `/api/mesh/${peer.id}/proxy/api/ws/${wsIdB}/diff/preview`, { path: 'README.md', content: '# workspace B\nchanged\n' }, tokenA);
    assert.equal(diff.status, 200, 'diff/preview not proxied');
    assert.ok(diff.json.diff.includes('+# workspace B') || diff.json.diff.includes('+changed'), `unexpected diff: ${diff.json.diff?.slice(0, 200)}`);
  });

  test('task packets: create → ack → progress → complete, with dedup and illegal transitions', async () => {
    const create = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks`, {
      title: 'write module x', contract: 'CONTRACT-BLOCK', requirements: ['module exists', 'tests pass'],
      contextFiles: ['README.md'], workspaceMapping: { local: wsA, remote: 'project-root', revision: 'aabbccdd' },
      dedupKey: 'stage-coder-x-1', priority: 3,
    }, tokenA);
    assert.equal(create.status, 200);
    const id = create.json.task.id;
    assert.equal(create.json.task.status, 'queued');
    assert.equal(create.json.task.contract, 'CONTRACT-BLOCK');

    // idempotent re-submission
    const again = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks`, { title: 'write module x', dedupKey: 'stage-coder-x-1' }, tokenA);
    assert.equal(again.status, 200);
    assert.equal(again.json.deduplicated, true);
    assert.equal(again.json.task.id, id);

    const ack = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/ack`, { agentId: 'agent-b', machineId: 'peer-b' }, tokenA);
    assert.equal(ack.status, 200);
    assert.equal(ack.json.task.status, 'acknowledged');
    assert.equal(ack.json.task.attempts, 1);

    const prog = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/progress`, { note: 'halfway done' }, tokenA);
    assert.equal(prog.status, 200);
    assert.ok(prog.json.task.progress.some((p) => p.note === 'halfway done'));

    const complete = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/complete`, {
      summary: 'module x written', artifacts: [{ path: 'x.js', bytes: 120 }], filesChanged: ['x.js'], revisionAfter: 'eeff0011',
    }, tokenA);
    assert.equal(complete.status, 200);
    assert.equal(complete.json.task.status, 'completed');
    assert.equal(complete.json.task.result.revisionAfter, 'eeff0011');

    // completed is terminal: progress refused
    const lateProg = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/progress`, { note: 'nope' }, tokenA);
    assert.equal(lateProg.status, 409);
  });

  test('cancellation is explicit and terminal; unknown task ids 404', async () => {
    const t = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks`, { title: 'to-cancel' }, tokenA);
    const id = t.json.task.id;
    const cancel = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/cancel`, { reason: 'user stopped' }, tokenA);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.task.status, 'cancelled');
    const cancelAgain = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${id}/cancel`, {}, tokenA);
    assert.equal(cancelAgain.status, 200);
    assert.equal(cancelAgain.json.deduplicated, true);
    const nope = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/ffffffff-ffff-ffff-ffff-ffffffffffff/ack`, {}, tokenA);
    assert.equal(nope.status, 404);
  });

  test('write reservations: owner refresh, other-owner 409, release enforcement, expiry', async () => {
    const lock1 = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/app.js', owner: 'agent-1', ttlMs: 1500 }, tokenA);
    assert.equal(lock1.status, 200);
    assert.equal(lock1.json.locked, true);
    // other owner blocked
    const lock2 = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/app.js', owner: 'agent-2' }, tokenA);
    assert.equal(lock2.status, 409);
    assert.equal(lock2.json.error.includes('reserved by another writer'), true, lock2.json.error);
    // same owner refreshes
    const lock1b = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/app.js', owner: 'agent-1' }, tokenA);
    assert.equal(lock1b.json.reservation.refresh, true);
    // release by non-owner refused
    const steal = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/app.js', owner: 'agent-2', release: true }, tokenA);
    assert.equal(steal.status, 403);
    // owner release works
    const rel = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/app.js', owner: 'agent-1', release: true }, tokenA);
    assert.equal(rel.json.released, true);
    // TTL expiry frees the path
    const lock3 = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/config.js', owner: 'agent-3', ttlMs: 1100 }, tokenA);
    assert.equal(lock3.status, 200);
    await new Promise((r) => setTimeout(r, 1300));
    const lock4 = await req(portA, 'POST', `/api/ws/${wsIdA}/locks`, { path: 'src/config.js', owner: 'agent-4' }, tokenA);
    assert.equal(lock4.status, 200, 'expired reservation should free the path');
  });

  test('machine disconnect fails its active tasks (graceful recovery hook)', async () => {
    // Task lives on A, assigned to B's mesh peer id. Killing B makes the peer
    // unreachable; A's peerStatus hook must fail the active task so the
    // coordinator can reassign it explicitly (never auto-retry).
    const status = await req(portA, 'GET', '/api/mesh/status', undefined, tokenA);
    const peer = status.json.peers[0];
    assert.ok(peer?.paired, 'peer should be paired');
    const t = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks`, { title: 'on-vanishing-machine' }, tokenA);
    assert.equal(t.status, 200);
    const taskId = t.json.task.id;
    const ack = await req(portA, 'POST', `/api/ws/${wsIdA}/tasks/${taskId}/ack`, { agentId: 'agent-on-b', machineId: peer.id }, tokenA);
    assert.equal(ack.status, 200);

    // kill B → its /health stops answering
    procB.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 700));
    const ps = await req(portA, 'GET', `/api/mesh/peers/${peer.id}`, undefined, tokenA);
    assert.equal(ps.status, 200);
    assert.equal(ps.json.reachable, false, `expected unreachable, got ${JSON.stringify(ps.json.health)}`);
    const list = await req(portA, 'GET', `/api/ws/${wsIdA}/tasks?status=failed`, undefined, tokenA);
    const failed = list.json.tasks.find((x) => x.id === taskId);
    assert.ok(failed, 'active task was not failed after machine disconnect');
    assert.ok(failed.error.reason.includes('machine disconnected'), `unexpected reason: ${failed.error.reason}`);
    assert.equal(failed.error.recoverable, true);
  });
});
