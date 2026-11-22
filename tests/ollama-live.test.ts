// Live Ollama integration test (mission §8.4) — GATED, not part of CI.
// Runs ONLY when a real Ollama server is reachable (or LF_OLLAMA_URL is set).
// With no server the tests are skipped and the skip reason is explicit, so a
// green CI run never claims live-model verification that did not happen.
//
//   bun test tests/ollama-live.test.ts                      # auto-detect 127.0.0.1:11434
//   LF_OLLAMA_URL=http://host:11434 LF_OLLAMA_MODEL=nemotron-cascade2:30b-a3b bun test tests/ollama-live.test.ts
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { agentSystemPrompt } from '../src/lib/agent/prompts';
import { CORE_TOOLS } from '../src/lib/agent/tools';
import { createContract } from '../src/lib/agent/task-contract';

const BASE = (process.env.LF_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.LF_OLLAMA_MODEL || 'nemotron-cascade2:30b-a3b';

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j.models) && j.models.length > 0;
  } catch {
    return false;
  }
}

const up = await ollamaUp();
if (!up) {
  console.log(`[ollama-live] SKIP — no Ollama server reachable at ${BASE}. Live-model verification NOT performed (mission §8 requires reporting this explicitly). Set LF_OLLAMA_URL to run.`);
}

describe('Live Ollama integration (gated)', () => {
  test.skipIf(!up)('probe: native tool calling works against the live model', async () => {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Call the get_time tool now.' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: { type: 'object', properties: {}, required: [] } } }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    expect(r.ok).toBe(true);
    const j = await r.json();
    // native OR text-dialect both acceptable — the runner handles either;
    // the assertion documents what the live model actually does
    const native = Array.isArray(j.message?.tool_calls) && j.message.tool_calls.length > 0;
    const text = typeof j.message?.content === 'string' && j.message.content.length > 0;
    expect(native || text).toBe(true);
    console.log(`[ollama-live] ${MODEL} native tool_calls: ${native ? 'YES' : 'no (text: ' + String(j.message?.content || '').slice(0, 80) + ')'}`);
  });

  test.skipIf(!up)('live loop: the runner drives a real tool round-trip and continues after the tool response', async () => {
    // minimal in-memory "workspace" so list_dir works without a companion
    const companion: any = {
      async chat(opts: any) {
        const r = await fetch(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages: opts.messages,
            tools: opts.tools,
            stream: false,
            options: { num_ctx: opts.params?.numCtx ?? 4096 },
          }),
          signal: AbortSignal.timeout(180000),
        });
        const j = await r.json();
        const toolCalls = (j.message?.tool_calls || []).map((tc: any, i: number) => ({
          id: `live_${i}`, name: tc.function?.name, args: tc.function?.arguments ?? {},
        }));
        return { text: j.message?.content || '', end: { finish: j.done_reason || 'stop', toolCalls, usage: { promptTokens: j.prompt_eval_count ?? null, completionTokens: j.eval_count ?? null } } };
      },
      async tree() { return { root: '/tmp/localforge-live', entries: [{ path: 'calculator', type: 'dir' }, { path: 'notes.txt', type: 'file', size: 3 }] }; },
      async statPath(_id: string, p: string) {
        const rel = String(p ?? '.').replace(/^\.\//, '');
        if (rel === '.' || rel === '') return { exists: true, type: 'dir', empty: false, entryCount: 2 };
        if (rel === 'calculator') return { exists: true, type: 'dir', empty: false, entryCount: 0 };
        if (rel === 'notes.txt') return { exists: true, type: 'file', size: 3 };
        return { exists: false, reason: 'not-found' };
      },
      async listDir() { return [{ path: 'calculator', type: 'dir' as const }, { path: 'notes.txt', type: 'file' as const }]; },
      async readFile(_id: string, p: string) {
        if (String(p).replace(/^\.\//, '') === 'notes.txt') return { content: 'hi\n', size: 3 };
        throw new Error('not found');
      },
      async search() { return { results: [] }; },
    };
    const contract = createContract('List what is in the workspace and call finish with a one-line summary.', { workspaceId: 'live', path: '/tmp/localforge-live', machineLabel: 'live' });
    const events: any[] = [];
    const runner = new AgentRunner({
      companion,
      workspaceId: 'live',
      provider: { kind: 'ollama', baseUrl: BASE },
      model: MODEL,
      systemPrompt: agentSystemPrompt({ platform: 'linux', workspacePath: '/tmp/localforge-live', tree: 'calculator/\nnotes.txt' }, 'task'),
      task: 'List what is in the workspace and call finish with a one-line summary.',
      tools: CORE_TOOLS,
      toolProtocol: 'auto',
      maxTurns: 8,
      workspaceMeta: { id: 'live', rootPath: '/tmp/localforge-live', machineLabel: 'live', platform: 'linux', knownTree: 'calculator/\nnotes.txt' },
      contract,
      onContractUpdate: () => {},
      onEvent: (e: any) => events.push(e),
    });
    const res = await runner.run();
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds.length).toBeGreaterThan(0); // the model really called a tool
    expect(res.turns).toBeGreaterThan(1);       // and continued after the tool result
    console.log(`[ollama-live] turns=${res.turns} tools=${toolEnds.map((e) => e.entry.tool).join(',')} status=${contract.status}`);
  });
});
