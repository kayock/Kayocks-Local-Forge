import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshProxyBudget, readProxyBody, streamProxyBody } from '../src/mesh.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function* frames(gaps, payloads) {
  for (let i = 0; i < payloads.length; i++) {
    await delay(gaps[i] || 0);
    yield Buffer.from(payloads[i]);
  }
}

test('chat uses an idle budget; other routes keep a fixed deadline', () => {
  const chat = meshProxyBudget('/api/chat');
  assert.equal(chat.mode, 'idle');
  assert.equal(chat.idleMs, 60_000);
  assert.ok(chat.deadlineMs > chat.idleMs);
  assert.deepEqual(meshProxyBudget('/chat'), chat);
  const plain = meshProxyBudget('/api/health');
  assert.equal(plain.mode, 'deadline');
  assert.equal(plain.ms, 60_000);
  assert.equal(meshProxyBudget('/api/models/load').ms, 30 * 60_000);
});

test('keepalive bytes during a cold start are not an idle stall', async () => {
  const body = frames([15, 15, 15], [
    '{"t":"keepalive"}\n',
    '{"t":"keepalive"}\n',
    '{"t":"text","v":"ok"}\n',
  ]);
  const text = await readProxyBody(body, { mode: 'idle', idleMs: 40, deadlineMs: 500 });
  assert.match(text, /"t":"text"/);
});

test('a silent body still dies at the idle limit', async () => {
  const body = frames([120], ['{"t":"text","v":"late"}\n']);
  await assert.rejects(
    () => readProxyBody(body, { mode: 'idle', idleMs: 40, deadlineMs: 500 }),
    (e) => e.code === 'idle',
  );
});

test('chat bytes are forwarded before the body ends', async () => {
  let finished = false;
  const body = (async function* () {
    yield Buffer.from('{"t":"keepalive"}\n');
    await delay(30);
    yield Buffer.from('{"t":"text","v":"ok"}\n');
    finished = true;
  })();
  const writes = [];
  const out = { write(chunk) { writes.push({ text: Buffer.from(chunk).toString(), finished }); } };
  await streamProxyBody(body, { mode: 'idle', idleMs: 200, deadlineMs: 1000 }, out);
  assert.equal(writes[0].finished, false);
  assert.match(writes[0].text, /keepalive/);
  assert.match(writes.map((w) => w.text).join(''), /"v":"ok"/);
});

test('a silent streamed body still dies at the idle limit', async () => {
  const body = frames([120], ['{"t":"text","v":"late"}\n']);
  const out = { write() { throw new Error('late chunk was forwarded'); } };
  await assert.rejects(
    () => streamProxyBody(body, { mode: 'idle', idleMs: 40, deadlineMs: 500 }, out),
    (e) => e.code === 'idle',
  );
});

test('a non-chat deadline still ends a chatty body', async () => {
  const body = frames([20, 20, 20], ['a', 'b', 'c']);
  await assert.rejects(
    () => readProxyBody(body, { mode: 'deadline', ms: 45 }),
    (e) => e.code === 'deadline',
  );
});
