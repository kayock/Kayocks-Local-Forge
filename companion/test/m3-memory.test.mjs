// Milestone 3 — persistent project memory: SQLite+FTS, dedup, restart
// persistence, secrets exclusion, concurrent-agent writes, backup/restore.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const COMPANION_DIR = fileURLToPath(new URL('..', import.meta.url));
const PORT = 23700 + Math.floor(Math.random() * 100);

let proc, home, token, wsId, wsRoot;

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
        try { json = JSON.parse(buf); } catch { /* stream/empty */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function start() {
  proc = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--home', home, '--workspace', wsRoot, '--lan', '--no-browser-hint'], {
    cwd: COMPANION_DIR, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => { if (process.env.M3_DEBUG) process.stderr.write(d); });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await req('GET', '/health', undefined, false);
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('companion did not start');
}

describe('Milestone 3 — persistent project memory', () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m3-'));
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m3-ws-'));
    fs.writeFileSync(path.join(wsRoot, 'server.js'), 'const PORT = 8080;\nmodule.exports = { start };\n');
    fs.writeFileSync(path.join(wsRoot, '.env'), 'API_KEY=supersecret-do-not-index\n');
    fs.writeFileSync(path.join(wsRoot, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n');
    fs.mkdirSync(path.join(wsRoot, 'docs'));
    fs.writeFileSync(path.join(wsRoot, 'docs/architecture.md'), '# Architecture\nWe use a ring buffer for logs and SQLite for memory.\n');
    await start();
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    wsId = state.workspaces[0].id;
    const pair = await req('POST', '/pair', { code: state.pairingCode, deviceLabel: 'm3' }, false);
    token = pair.json.token;
  });
  after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

  test('capabilities report the real backend', async () => {
    const r = await req('GET', '/api/memory/capabilities');
    assert.equal(r.status, 200);
    assert.ok(['sqlite', 'json'].includes(r.json.backend), r.json.backend);
  });

  test('write → read → search (FTS/keyword) with kinds and tags', async () => {
    const w1 = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'decision', content: 'We use SQLite WAL journaling for project memory storage.', tags: ['storage', 'architecture'], agentId: 'planner-1' });
    assert.equal(w1.status, 200);
    assert.equal(w1.json.deduplicated, false);
    const w2 = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'bug', content: 'The calculator regression extracted archives into a nested root; fixed with flatten detection.', tags: ['regression'] });
    const w3 = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'convention', content: 'All new modules must be plain ESM with node: builtins only.', tags: ['style'] });

    const s = await req('GET', `/api/ws/${wsId}/memory/search?q=${encodeURIComponent('SQLite storage')}`);
    assert.equal(s.status, 200);
    assert.ok(s.json.results.length >= 1, `search found nothing: ${JSON.stringify(s.json)}`);
    assert.ok(s.json.results[0].content.includes('SQLite WAL'));
    assert.equal(typeof s.json.results[0].score, 'number');

    const sKind = await req('GET', `/api/ws/${wsId}/memory/search?q=${encodeURIComponent('nested root')}&kind=bug`);
    assert.ok(sKind.json.results.every((r) => r.kind === 'bug'));

    const list = await req('GET', `/api/ws/${wsId}/memory`);
    assert.ok(list.json.memories.length >= 3);
    const read = await req('GET', `/api/ws/${wsId}/memory/${w3.json.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.tags, ['style']);
  });

  test('dedup: identical content merges instead of duplicating', async () => {
    const w = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'decision', content: 'We use SQLite WAL journaling for project memory storage.', tags: ['storage', 'architecture', 'updated-by-second-agent'] });
    assert.equal(w.status, 200);
    assert.equal(w.json.deduplicated, true, 'second identical write must dedup');
    const list = await req('GET', `/api/ws/${wsId}/memory`);
    const same = list.json.memories.filter((m) => m.content.includes('SQLite WAL journaling'));
    assert.equal(same.length, 1, 'dedup must not create a second record');
    assert.ok(same[0].tags.includes('updated-by-second-agent'), 'tags merged into the existing record');
  });

  test('update and delete', async () => {
    const w = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'fact', content: 'Original fact version one.' });
    const u = await req('PUT', `/api/ws/${wsId}/memory/${w.json.id}`, { content: 'Corrected fact version two.', pinned: true });
    assert.equal(u.status, 200);
    const g = await req('GET', `/api/ws/${wsId}/memory/${w.json.id}`);
    assert.equal(g.json.content, 'Corrected fact version two.');
    assert.equal(g.json.pinned, true);
    const d = await req('DELETE', `/api/ws/${wsId}/memory/${w.json.id}`);
    assert.equal(d.status, 200);
    const gone = await req('GET', `/api/ws/${wsId}/memory/${w.json.id}`);
    assert.equal(gone.status, 404);
  });

  test('incremental indexing skips secrets and finds code/docs', async () => {
    const idx = await req('POST', `/api/ws/${wsId}/memory/index`, {});
    assert.equal(idx.status, 200);
    assert.ok(idx.json.indexed >= 2, `indexed=${idx.json.indexed}`);
    assert.ok(idx.json.skippedSecrets >= 2, `.env and id_rsa must be excluded (skipped=${idx.json.skippedSecrets})`);
    // incremental: second run finds nothing new
    const idx2 = await req('POST', `/api/ws/${wsId}/memory/index`, {});
    assert.equal(idx2.json.indexed, 0, 'unchanged files must not reindex');
    assert.ok(idx2.json.unchanged >= 2);
    // file search works
    const f = await req('GET', `/api/ws/${wsId}/memory/files?q=${encodeURIComponent('ring buffer')}`);
    assert.ok(f.json.results.some((r) => r.path.includes('architecture.md')), JSON.stringify(f.json));
    // secret VALUES must never appear in the index
    const leak = await req('GET', `/api/ws/${wsId}/memory/files?q=supersecret`);
    assert.equal(leak.json.results.length, 0, 'secret file content leaked into the index');
  });

  test('RESTART persistence: memory survives a full Companion restart', async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await start();
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    token = (await req('POST', '/pair', { code: state.pairingCode, deviceLabel: 'm3-restart' }, false)).json.token;
    const s = await req('GET', `/api/ws/${wsId}/memory/search?q=${encodeURIComponent('SQLite WAL')}`);
    assert.equal(s.status, 200);
    assert.ok(s.json.results.length >= 1, 'memory lost after restart!');
    assert.ok(s.json.results[0].content.includes('SQLite WAL'));
    const list = await req('GET', `/api/ws/${wsId}/memory`);
    assert.ok(list.json.memories.length >= 2, 'not all memories survived the restart');
  });

  test('backup → export → wipe-equivalent import dedups; concurrent agent writes merge', async () => {
    const ex = await req('GET', `/api/ws/${wsId}/memory/export`);
    assert.equal(ex.status, 200);
    assert.equal(ex.json.format, 'localforge-memory-v1');
    assert.ok(ex.json.memories.length >= 2);
    // re-import the same backup: all dedup (concurrent/merge semantics)
    const im = await req('POST', `/api/ws/${wsId}/memory/import`, ex.json);
    assert.equal(im.status, 200);
    assert.equal(im.json.restored, 0);
    assert.ok(im.json.deduplicated >= 2);
    // two agents writing the same fact: second merge, not destroy
    const a = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'outcome', content: 'Shared agent fact: build requires node >= 20.', agentId: 'agent-A' });
    const b = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'outcome', content: 'Shared agent fact: build requires node >= 20.', agentId: 'agent-B' });
    assert.equal(a.json.deduplicated, false);
    assert.equal(b.json.deduplicated, true);
    const list = await req('GET', `/api/ws/${wsId}/memory`);
    const hits = list.json.memories.filter((m) => m.content.includes('build requires node >= 20'));
    assert.equal(hits.length, 1, 'concurrent same-fact writes must merge');
  });

  test('project isolation: a second workspace sees none of these memories', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-m3-other-'));
    const ow = await req('POST', '/api/workspaces', { path: other, name: 'other-project' });
    assert.equal(ow.status, 200);
    const otherWsId = ow.json.workspace.id;
    const list = await req('GET', `/api/ws/${otherWsId}/memory`);
    assert.equal(list.json.memories.length, 0, 'memory leaked across projects!');
    const s = await req('GET', `/api/ws/${otherWsId}/memory/search?q=SQLite`);
    assert.equal(s.json.results.length, 0);
    const s2 = await req('GET', `/api/ws/${wsId}/memory/search?q=SQLite`);
    assert.ok(s2.json.results.length >= 1);
  });

  test('validation: empty content rejected, unknown id 404', async () => {
    const bad = await req('POST', `/api/ws/${wsId}/memory`, { kind: 'note', content: '   ' });
    assert.equal(bad.status, 400);
    const nope = await req('GET', `/api/ws/${wsId}/memory/ffffffff-ffff-ffff-ffff-ffffffffffff`);
    assert.equal(nope.status, 404);
  });
});
