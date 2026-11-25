import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyOllamaThinking, applyOpenAiThinking, clearThinkingSupportCache, proxyChat, shouldForwardNumCtx } from '../src/providers.js';

let upstream;
let port;
let lastBody;

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/props' || req.url === '/v1/props')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        chat_template_caps: { supports_tools: true, supports_reasoning_effort: false },
        default_generation_settings: { n_ctx: 16384 },
      }));
      return;
    }
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
  clearThinkingSupportCache();
  const frames = await chat({ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` }, { think: 'disabled' });
  assert.equal('think' in lastBody, false);
  assert.equal(lastBody.chat_template_kwargs.enable_thinking, false);
  assert.equal('reasoning_effort' in lastBody, false);
  assert.equal(frames.some((f) => f.t === 'text' && f.v === 'visible'), true);
  assert.equal(frames.some((f) => f.t === 'thinking'), false);
});

test('llama.cpp enabled thinking requests enable_thinking and forwards reasoning_content', async () => {
  clearThinkingSupportCache();
  const frames = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chat_template_caps: { supports_reasoning_effort: false } }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden-would-be-wrong' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const enabledPort = server.address().port;
  try {
    await proxyChat(
      {
        provider: { kind: 'openai', baseUrl: `http://127.0.0.1:${enabledPort}/v1` },
        model: 'bryce',
        messages: [{ role: 'user', content: 'ping' }],
        params: { think: 'enabled' },
      },
      { write: (frame) => frames.push(frame), onClose: () => {} },
    );
  } finally {
    server.close();
  }
  assert.equal('think' in lastBody, false);
  assert.equal(lastBody.chat_template_kwargs.enable_thinking, true);
  assert.deepEqual(frames.filter((frame) => frame.t === 'thinking').map((frame) => frame.v), ['hidden-would-be-wrong']);
  assert.deepEqual(frames.filter((frame) => frame.t === 'text').map((frame) => frame.v), ['answer']);
});

test('an OpenAI endpoint without llama.cpp caps does not receive thinking extensions', async () => {
  clearThinkingSupportCache();
  const plain = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'visible' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  const plainPort = plain.address().port;
  const frames = [];
  try {
    await proxyChat(
      {
        provider: { kind: 'openai', baseUrl: `http://127.0.0.1:${plainPort}/v1` },
        model: 'other',
        messages: [{ role: 'user', content: 'ping' }],
        params: { think: 'disabled' },
      },
      { write: (frame) => frames.push(frame), onClose: () => {} },
    );
  } finally {
    plain.close();
  }
  assert.equal('think' in lastBody, false);
  assert.equal('chat_template_kwargs' in lastBody, false);
  const end = frames.find((frame) => frame.t === 'end');
  assert.equal(end.thinkingControl.applied, 'unsupported');
  assert.match(end.thinkingControl.limitation, /not advertise llama.cpp/);
});

test('automatic OpenAI requests omit thinking controls', async () => {
  clearThinkingSupportCache();
  await chat({ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` }, { temperature: 0.2 });
  assert.equal('think' in lastBody, false);
  assert.equal('chat_template_kwargs' in lastBody, false);
});

test('applyOpenAiThinking never copies the Ollama boolean', () => {
  const disabled = {};
  const result = applyOpenAiThinking(disabled, { think: 'disabled' }, { kind: 'llama-cpp', reasoningEffort: false });
  assert.equal(result.applied, 'disabled');
  assert.equal(disabled.chat_template_kwargs.enable_thinking, false);
  assert.equal('think' in disabled, false);
  const untouched = {};
  applyOpenAiThinking(untouched, { think: 'auto' }, { kind: 'llama-cpp' });
  assert.equal('chat_template_kwargs' in untouched, false);
});

test('num_ctx is not forwarded to llama.cpp or as a lower value to a loaded Ollama context', () => {
  assert.equal(shouldForwardNumCtx({ numCtxExplicit: true, numCtx: 4096 }, { kind: 'openai', baseUrl: 'http://127.0.0.1:12450/v1' }), false);
  assert.equal(shouldForwardNumCtx({ numCtxExplicit: true, numCtx: 4096, liveNumCtx: 16384 }, { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), false);
  assert.equal(shouldForwardNumCtx({ numCtxExplicit: true, numCtx: 16384, liveNumCtx: 4096 }, { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), true);
  assert.equal(shouldForwardNumCtx({ numCtx: 8192 }, { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), false);
});
