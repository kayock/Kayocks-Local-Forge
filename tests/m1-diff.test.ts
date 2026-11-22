// Milestone 1 — IDE-side tests: diff previews flow through the agent tools,
// overwrite protection reaches the model, and structured results carry
// changed files + diffs without leaking the diff into the model context.
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { toolsByNames } from '@/lib/agent/tools';
import type { CompanionClient } from '@/lib/companion/client';
import type { AgentEvent } from '@/lib/agent/types';
import type { UnifiedStreamChunk, ProviderConfig, WireMessage } from '@/lib/types';

function makeProvider(): ProviderConfig {
  return { id: 'p1', name: 'Mock', kind: 'openai', baseUrl: 'http://mock', models: [] } as any;
}

// Companion mock implementing the M1 REST additions.
class M1MockCompanion {
  public calls: { method: string; path: string; body?: any }[] = [];
  public files = new Map<string, { content: string; mtime: string }>();
  public events: AgentEvent[] = [];

  constructor() {
    this.files.set('app.js', { content: 'a\nb\nc\n', mtime: '2026-01-01T00:00:00.000Z' });
  }

  diffPreview(wsId: string, p: string, content: string) {
    this.calls.push({ method: 'POST', path: `/api/ws/${wsId}/diff/preview`, body: { path: p } });
    const cur = this.files.get(p);
    const curLines = cur ? cur.content.split('\n') : [];
    const newLines = content.split('\n');
    const diff = [`--- a/${p}`, `+++ b/${p}`];
    for (const l of curLines) if (!newLines.includes(l)) diff.push('-' + l);
    for (const l of newLines) if (!curLines.includes(l)) diff.push('+' + l);
    return { path: p, exists: !!cur, diff: diff.join('\n'), added: 1, removed: 1, truncated: false, currentMtime: cur?.mtime ?? null, previewedBytes: content.length };
  }

  async writeFile(wsId: string, p: string, content: string, opts?: { ifUnmodifiedSince?: string | null; returnDiff?: boolean }) {
    this.calls.push({ method: 'PUT', path: `/api/ws/${wsId}/file`, body: { path: p, ifUnmodifiedSince: opts?.ifUnmodifiedSince } });
    const cur = this.files.get(p);
    if (cur && opts?.ifUnmodifiedSince && cur.mtime > opts.ifUnmodifiedSince) {
      const err: any = new Error(`"${p}" changed on disk after the diff was previewed (concurrent modification).`);
      err.status = 409;
      err.payload = { conflict: { path: p, currentContent: 'CONCURRENT-CONTENT\n', contentTruncated: false } };
      throw err;
    }
    this.files.set(p, { content, mtime: '2026-01-02T00:00:00.000Z' });
    return { path: p, bytes: content.length, created: !cur, modifiedAt: '2026-01-02T00:00:00.000Z', diff: `--- a/${p}\n+++ b/${p}\n@@\n-x\n+y`, diffAdded: 1, diffRemoved: 1, changedFile: { path: p, size: content.length, mtimeMs: 1 } };
  }

  async readFile(wsId: string, p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`File not found: ${p}`);
    return { path: p, content: f.content, size: f.content.length, modifiedAt: f.mtime };
  }

  // Minimal chat mock: turn 1 → write_file, turn 2 → edit_file (conflict → retry), turn 3 → finish
  async chat(opts: { messages: WireMessage[]; onChunk?: (c: UnifiedStreamChunk) => void }): Promise<{ text: string; end?: UnifiedStreamChunk }> {
    const nonSystem = opts.messages.filter((m) => m.role !== 'system') as any[];
    const lastMsg = nonSystem[nonSystem.length - 1]?.content || '';
    let tool: any = null;
    if (lastMsg.includes('WRITE-PHASE')) {
      tool = { name: 'write_file', args: { path: 'app.js', content: 'a\nB\nc\n' } };
    } else if (lastMsg.includes('CONFLICT') || lastMsg.includes('REFUSED')) {
      tool = { name: 'edit_file', args: { path: 'app.js', find: 'CONCURRENT-CONTENT', replace: 'CONCURRENT-CONTENT\nmore' } };
    } else if (lastMsg.includes('EDIT-PHASE')) {
      tool = { name: 'edit_file', args: { path: 'app.js', find: 'a', replace: 'X' } };
    } else {
      tool = { name: 'finish', args: { summary: 'done with diffs' } };
    }
    const end: UnifiedStreamChunk = { t: 'end', toolCalls: [{ id: 'c1', name: tool.name, args: tool.args }] } as any;
    opts.onChunk?.(end);
    return { text: '', end };
  }
}

function asCompanion(mock: M1MockCompanion): CompanionClient {
  return mock as unknown as CompanionClient;
}

function runTask(task: string) {
  const mock = new M1MockCompanion();
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({
    companion: asCompanion(mock),
    workspaceId: 'wsX',
    provider: makeProvider(),
    model: 'mock-model',
    systemPrompt: 'test',
    task,
    tools: toolsByNames(['write_file', 'edit_file', 'finish']),
    toolProtocol: 'native',
    maxTurns: 8,
    onEvent: (e) => events.push(e),
    fetchWorkspaceRevision: async () => 'abcdef1234567890',
  });
  return { promise: runner.run(), mock, events };
}

describe('M1 — diff previews and overwrite protection in the agent loop', () => {
  test('write_file previews a diff before writing and emits diff_preview', async () => {
    const { promise, mock, events } = runTask('WRITE-PHASE then finish');
    const r = await promise;
    expect(r.filesChanged).toContain('app.js');
    const preview = mock.calls.find((c) => c.path.includes('/diff/preview'));
    expect(preview).toBeTruthy();
    const write = mock.calls.find((c) => c.method === 'PUT');
    expect(write?.body.ifUnmodifiedSince).toBe('2026-01-01T00:00:00.000Z'); // mtime from preview echoes on write
    const diffEv = events.find((e) => e.type === 'diff_preview') as any;
    expect(diffEv).toBeTruthy();
    expect(diffEv.path).toBe('app.js');
    expect(diffEv.diff).toContain('+B');
    const endEv = events.find((e) => e.type === 'tool_end') as any;
    expect(endEv.entry.diff).toContain('+B');
    expect(endEv.entry.workspaceRevision).toBe('abcdef123456');
    // concise confirmation for the MODEL (no full diff flooding the context)
    expect(endEv.entry.output).toMatch(/Wrote app\.js/);
  });

  test('edit_file conflict refuses the write and hands the model the current content', async () => {
    // simulate a concurrent writer between preview and write
    const { promise, mock, events } = runTask('EDIT-PHASE then finish');
    // wrap writeFile to bump the mtime after preview
    const origWrite = mock.writeFile.bind(mock);
    let bumped = false;
    mock.writeFile = async (wsId: string, p: string, content: string, opts?: any) => {
      if (!bumped) {
        bumped = true;
        mock.files.set('app.js', { content: 'CONCURRENT-CONTENT\n', mtime: '2026-01-03T00:00:00.000Z' });
      }
      return origWrite(wsId, p, content, opts);
    };
    const r = await promise;
    const conflictTool = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.output?.includes('CONFLICT'));
    expect(conflictTool).toBeTruthy();
    expect(conflictTool.output).toContain('CONCURRENT-CONTENT');
    expect(conflictTool.status).toBe('error');
    expect(mock.files.get('app.js')!.content).toBe('CONCURRENT-CONTENT\nmore\n'); // resolved, not clobbered
    expect(r.filesChanged).toContain('app.js');
  });

  test('edit_file includes a diff and does not regress plain mocks (no diffPreview support)', async () => {
    // A companion WITHOUT diffPreview (older/mock): tools must still work.
    const mock = new M1MockCompanion();
    (mock as any).diffPreview = undefined;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      companion: asCompanion(mock),
      workspaceId: 'wsX',
      provider: makeProvider(),
      model: 'mock-model',
      systemPrompt: 'test',
      task: 'EDIT-PHASE then finish',
      tools: toolsByNames(['edit_file', 'finish']),
      toolProtocol: 'native',
      maxTurns: 6,
      onEvent: (e) => events.push(e),
    });
    await runner.run();
    const endEv = events.filter((e) => e.type === 'tool_end').map((e) => (e as any).entry).find((en) => en.tool === 'edit_file');
    expect(endEv.status).toBe('ok');
    expect(endEv.output).toMatch(/Edited app\.js/);
  });
});
