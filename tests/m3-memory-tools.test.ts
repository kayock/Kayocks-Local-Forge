// Milestone 3 — agent memory tools through the AgentRunner: search at task
// start, record decisions, notebook/scratchpad coordination, honest
// degradation when memory is unavailable.
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { toolsByNames } from '@/lib/agent/tools';
import type { CompanionClient } from '@/lib/companion/client';
import type { AgentEvent } from '@/lib/agent/types';
import type { UnifiedStreamChunk, ProviderConfig, WireMessage } from '@/lib/types';

class MemoryMockCompanion {
  public calls: { method: string; path: string; body?: any }[] = [];
  public memories: any[] = [];
  public notebook: any[] = [];
  public scratchpads = new Map<string, any>();
  public script: string[] = []; // sequence of tool names the model should call
  public seq = 0;

  constructor(script: string[]) { this.script = [...script]; }

  memorySearch(wsId: string, q: string, opts?: any) {
    this.calls.push({ method: 'GET', path: `/api/ws/${wsId}/memory/search`, body: { q } });
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const results = this.memories
      .filter((m) => terms.some((t) => m.content.toLowerCase().includes(t)))
      .map((m) => ({ ...m, score: 0.9 }));
    return Promise.resolve({ query: q, results, hybrid: false });
  }
  memoryRead(wsId: string, id: string) {
    const m = this.memories.find((x) => x.id === id);
    if (!m) return Promise.reject(new Error('Unknown memory id'));
    return Promise.resolve(m);
  }
  memoryWrite(wsId: string, body: any) {
    this.calls.push({ method: 'POST', path: `/api/ws/${wsId}/memory`, body });
    const dup = this.memories.find((m) => m.kind === body.kind && m.content === body.content);
    if (dup) return Promise.resolve({ id: dup.id, deduplicated: true, createdAt: 0, updatedAt: 1 });
    const rec = { id: `mem-${++this.seq}`, kind: body.kind, content: body.content, tags: body.tags ?? [], refs: body.refs ?? null, agentId: body.agentId ?? null, updatedAt: Date.now() };
    this.memories.push(rec);
    return Promise.resolve({ id: rec.id, deduplicated: false, createdAt: 1, updatedAt: 1 });
  }
  notebookAppend(wsId: string, entry: any) {
    this.calls.push({ method: 'POST', path: `/api/ws/${wsId}/notebook`, body: entry });
    this.notebook.push({ seq: ++this.seq, ...entry, at: Date.now() });
    return Promise.resolve({ seq: this.seq, id: `nb-${this.seq}` });
  }
  notebookList(wsId: string, opts?: any) {
    const entries = this.notebook.filter((e) => !opts?.kind || e.kind === opts.kind);
    return Promise.resolve({ entries });
  }
  readScratchpad(wsId: string, agentId: string) {
    return Promise.resolve(this.scratchpads.get(agentId) ?? { plan: [], findings: [] });
  }
  writeScratchpad(wsId: string, agentId: string, patch: any) {
    const cur = this.scratchpads.get(agentId) ?? {};
    this.scratchpads.set(agentId, { ...cur, ...patch, updatedAt: new Date().toISOString() });
    return Promise.resolve(this.scratchpads.get(agentId));
  }

  // Model stub: walks the scripted tool sequence, then finish.
  async chat(opts: { messages: WireMessage[]; onChunk?: (c: UnifiedStreamChunk) => void }) {
    const toolResults = opts.messages.filter((m: any) => m.role === 'tool').length;
    const tool = toolResults >= this.script.length ? 'finish' : this.script[toolResults];
    const argsByTool: Record<string, any> = {
      memory_search: { query: 'ring buffer storage' },
      memory_write: { kind: 'decision', content: 'Logs use a ring buffer; project memory uses SQLite WAL.', tags: 'storage' },
      notebook_append: { kind: 'finding', content: 'Memory backend is SQLite with FTS5.', refs: 'docs/architecture.md' },
      notebook_search: { query: 'SQLite' },
      read_scratchpad: { agentId: 'agent@testbox' },
      write_scratchpad: { agentId: 'agent@testbox', objective: 'record project decision', findings: JSON.stringify(['sqlite chosen']) },
      finish: { summary: 'decision recorded and verified' },
    };
    const end: UnifiedStreamChunk = { t: 'end', toolCalls: [{ id: `c-${tool}`, name: tool, args: argsByTool[tool] ?? {} }] } as any;
    opts.onChunk?.(end);
    return { text: '', end };
  }
  completed = 0;
}

function asCompanion(m: MemoryMockCompanion): CompanionClient { return m as unknown as CompanionClient; }

function makeProvider(): ProviderConfig { return { id: 'p', name: 'Mock', kind: 'openai', baseUrl: 'http://mock' } as any; }

function run(script: string[], task: string, events: AgentEvent[]) {
  const mock = new MemoryMockCompanion(script);
  const runner = new AgentRunner({
    companion: asCompanion(mock),
    workspaceId: 'wsM',
    provider: makeProvider(),
    model: 'mock-model',
    systemPrompt: 'test memory tools',
    task,
    tools: toolsByNames(['memory_search', 'memory_read', 'memory_write', 'notebook_append', 'notebook_search', 'read_scratchpad', 'write_scratchpad', 'finish']),
    toolProtocol: 'native',
    maxTurns: 12,
    onEvent: (e) => events.push(e),
    workspaceMeta: { id: 'wsM', rootPath: '/proj', machineLabel: 'testbox', platform: 'linux' },
  });
  return { promise: runner.run(), mock };
}

describe('M3 — first-class agent memory tools', () => {
  test('search → write → notebook append flow records durable knowledge', async () => {
    const events: AgentEvent[] = [];
    const { promise, mock } = run(['memory_search', 'memory_write', 'notebook_append', 'finish'], 'record the storage decision', events);
    mock.memories.push({ id: 'mem-existing', kind: 'fact', content: 'The project uses a ring buffer for log storage.', tags: [], updatedAt: Date.now() });
    const r = await promise;
    expect(r.filesChanged).toEqual([]);
    const search = mock.calls.find((c) => c.path.includes('/memory/search'));
    expect(search).toBeTruthy();
    expect(search!.body.q).toContain('ring buffer');
    const write = mock.calls.find((c) => c.path.endsWith('/memory') && c.method === 'POST');
    expect(write).toBeTruthy();
    expect(write!.body.kind).toBe('decision');
    expect(mock.memories.some((m) => m.kind === 'decision' && m.content.includes('SQLite WAL'))).toBe(true);
    expect(mock.notebook.some((e) => e.kind === 'finding')).toBe(true);
    const endTool = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.tool === 'memory_write');
    expect(endTool.status).toBe('ok');
    expect(endTool.output).toContain('Memory recorded');
  });

  test('memory_search returns results to the model with ids and scores', async () => {
    const events: AgentEvent[] = [];
    const { promise, mock } = run(['memory_search', 'finish'], 'find prior knowledge', events);
    mock.memories.push({ id: 'mem-aaa', kind: 'bug', content: 'ring buffer overflow bug was fixed in v0.3', tags: ['bug'], updatedAt: Date.now() });
    await promise;
    const searchTool = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.tool === 'memory_search');
    expect(searchTool.status).toBe('ok');
    expect(searchTool.output).toContain('mem-aaa'.slice(0, 8)); // 8-char prefix
    expect(searchTool.output).toContain('ring buffer overflow');
  });

  test('scratchpad tools persist agent state (coordinate concurrent agents)', async () => {
    const events: AgentEvent[] = [];
    const { promise, mock } = run(['write_scratchpad', 'read_scratchpad', 'notebook_search', 'finish'], 'coordinate via scratchpad', events);
    await promise;
    const sp = mock.scratchpads.get('agent@testbox');
    expect(sp).toBeTruthy();
    expect(sp.objective).toBe('record project decision');
    expect(Array.isArray(sp.findings)).toBe(true);
    const writeTool = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.tool === 'write_scratchpad');
    expect(writeTool.status).toBe('ok');
  });

  test('memory tools degrade honestly when the host lacks the memory API', async () => {
    // mock WITHOUT memory* methods (explicit undefined — prototype methods of
    // the mock class are not own properties)
    const mock: any = new MemoryMockCompanion(['memory_search', 'finish']);
    mock.memorySearch = undefined; mock.memoryRead = undefined; mock.memoryWrite = undefined;
    mock.notebookAppend = undefined; mock.notebookList = undefined;
    mock.readScratchpad = undefined; mock.writeScratchpad = undefined;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      companion: mock as CompanionClient,
      workspaceId: 'wsM',
      provider: makeProvider(),
      model: 'mock-model',
      systemPrompt: 'test',
      task: 'try memory',
      tools: toolsByNames(['memory_search', 'finish']),
      toolProtocol: 'native',
      maxTurns: 6,
      onEvent: (e) => events.push(e),
    });
    await runner.run();
    const searchTool = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.tool === 'memory_search');
    expect(searchTool.status).toBe('error');
    expect(searchTool.output).toContain('not available');
  });
});
