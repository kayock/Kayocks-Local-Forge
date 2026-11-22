// Stub OpenAI-compatible model server for integration tests (collab-platform,
// collab-e2e). Serves a SCRIPT of scripted model turns and records every chat
// request so tests can assert on the actual prompts sent (system prompt
// content, tools presence).
//
// Usage: node stub-model-server.mjs <port> <scriptJSON>
//   script entries:
//     { toolCalls: [{ id, name, args }] }   → native tool_calls response
//     { text: '...' }                        → plain content response
// Endpoints:
//   GET  /__script            → { script: [...], requests: [{ system, hasTools }] }
//   POST /chat/completions    → next script entry (OpenAI-compatible)
//   POST /v1/chat/completions → same
//   POST /api/v1/chat/completions → same
// When the script is exhausted the LAST entry repeats (bounded tests always
// finish before relying on it).
import http from 'node:http';

const port = Number(process.argv[2] || 0);
if (!port) { console.error('usage: stub-model-server.mjs <port> <scriptJSON>'); process.exit(2); }
let script;
try { script = JSON.parse(process.argv[3] || '[]'); } catch (e) { console.error('bad script JSON:', e.message); process.exit(2); }
if (!Array.isArray(script) || !script.length) { console.error('script must be a non-empty array'); process.exit(2); }

const requests = [];
let cursor = 0;

function nextEntry() {
  const entry = script[Math.min(cursor, script.length - 1)];
  cursor++;
  return entry;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function completion(entry) {
  if (entry && Array.isArray(entry.toolCalls) && entry.toolCalls.length) {
    return {
      id: `stubcmpl_${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'stub', choices: [{
        index: 0, finish_reason: 'stop',
        message: {
          role: 'assistant', content: entry.text || null,
          tool_calls: entry.toolCalls.map((tc) => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          })),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
  }
  return {
    id: `stubcmpl_${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: 'stub', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: entry?.text ?? '' } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

function sse(res, payload) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  // one full chunk then the done frame — the companion assembles tool calls
  // from deltas, so shape the chunk as a delta carrying the whole message.
  const choice = payload.choices?.[0];
  const delta = { role: 'assistant' };
  if (choice?.message?.content) delta.content = choice.message.content;
  if (choice?.message?.tool_calls) delta.tool_calls = choice.message.tool_calls;
  res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: payload.usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && (url === '/__script' || url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url === '/health' ? { ok: true, stub: true } : { script, requests }));
    return;
  }
  if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* keep {} */ }
    const system = Array.isArray(parsed.messages)
      ? (parsed.messages.find((m) => m.role === 'system')?.content ?? '')
      : '';
    requests.push({ system: String(system ?? ''), hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0, at: Date.now() });
    const payload = completion(nextEntry());
    if (parsed.stream) return sse(res, payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`stub-model-server listening on ${port} with ${script.length} scripted turn(s)`);
});
