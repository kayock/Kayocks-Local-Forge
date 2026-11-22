import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyOllamaThinking, proxyChat } from '../src/providers.js';

let upstream;
let port;
let lastBody;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url.startsWith('/api/chat')) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', thinking: 'planning the tool' } })}\n`);
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'visible' } })}\n`);
        res.write(`${JSON.stringify({ message: { role: 'assistant', tool_calls: [{ function: { name: 'finish', arguments: { summary: 'ok' } } }] } })}\n`);
        res.write(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 5 })}\n`);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'visible' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = upstream.address().port;
});

after(() => upstream?.close());

function chat(provider, params) {
  const frames = [];
  const promise = proxyChat(
    {
      provider,
      model: 'deepseek-q8:latest',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ type: 'function', function: { name: 'finish', parameters: { type: 'object', properties: {} } } }],
      params,
    },
    { write: (frame) => frames.push(frame), onClose: () => {} },
  );
  return promise.then(() => frames);
}

test('applyOllamaThinking only sets the native boolean', () => {
  const disabled = applyOllamaThinking({ model: 'm' }, { think: 'disabled' });
  assert.equal(disabled.think, false);
  const enabled = applyOllamaThinking({ model: 'm' }, { think: 'enabled' });
  assert.equal(enabled.think, true);
  const automatic = applyOllamaThinking({ model: 'm' }, {});
  assert.equal('think' in automatic, false);
});

test('disabled Ollama requests send think false and keep thinking out of the visible text', async () => {
  const frames = await chat({ kind: 'ollama', baseUrl: `http://127.0.0.1:${port}` }, { think: 'disabled', temperature: 0.2 });
  assert.equal(lastBody.think, false);
  assert.equal(lastBody.options.num_ctx, undefined);
  assert.deepEqual(frames.filter((f) => f.t === 'thinking').map((f) => f.v), ['planning the tool']);
  assert.deepEqual(frames.filter((f) => f.t === 'text').map((f) => f.v), ['visible']);
  assert.equal(frames.some((f) => f.t === 'tool_call' || (f.toolCalls || []).some((call) => call.name === 'finish')), true);
  const end = frames.find((f) => f.t === 'end');
  assert.equal(end.usage.promptTokens, 3);
  assert.equal(end.usage.completionTokens, 5);
});

test('enabled Ollama requests send think true', async () => {
  await chat({ kind: 'ollama', baseUrl: `http://127.0.0.1:${port}` }, { think: 'enabled' });
  assert.equal(lastBody.think, true);
});

test('automatic Ollama requests omit think', async () => {
  await chat({ kind: 'ollama', baseUrl: `http://127.0.0.1:${port}` }, { temperature: 0.2 });
  assert.equal('think' in lastBody, false);
});

test('an OpenAI-compatible endpoint does not receive the Ollama think field', async () => {
  const frames = await chat({ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` }, { think: 'disabled' });
  assert.equal('think' in lastBody, false);
  assert.equal(frames.some((f) => f.t === 'text' && f.v === 'visible'), true);
  assert.equal(frames.some((f) => f.t === 'thinking'), false);
});
