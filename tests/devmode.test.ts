// RC3 — Cline-style Plan/Act modes: plan strips mutating tools (prompt +
// hard block), act unchanged. Mode is a persisted UI toggle (AgentPanel).
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { CORE_TOOLS } from '@/lib/agent/tools';
import { agentSystemPrompt, PLAN_MODE_ADDON } from '@/lib/agent/prompts';

function makeCompanion(script: { toolCalls?: { id: string; name: string; args: any }[]; text?: string }[]) {
  let i = 0;
  return {
    async chat(opts: any) {
      const e = script[Math.min(i++, script.length - 1)];
      return { text: e.text ?? '', end: { finish: 'stop' as const, toolCalls: e.toolCalls ?? [], usage: null } };
    },
    async readFile(_w: string, p: string) { throw new Error(`not found: ${p}`); },
    async writeFile(_w: string, p: string, c: string) { return { bytes: c.length }; },
    async tree() { return { root: '/w', entries: [{ path: 'a.txt', type: 'file', size: 4 }] }; },
    async statPath() { return { exists: true, type: 'dir', empty: false, entryCount: 1 }; },
    async search() { return { results: [] }; },
    async exec() { return { exitCode: 0, stdout: 'x\n', stderr: '', cwd: null, durMs: 1, timedOut: false }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart() { throw new Error('no'); }, procList() { return []; },
    procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
  } as any;
}

function run(companion: any, devMode: 'plan' | 'act' | undefined) {
  const events: any[] = [];
  const runner = new AgentRunner({
    companion, workspaceId: 'ws1',
    provider: { kind: 'openai', baseUrl: 'http://x/v1' } as any, model: 'm',
    systemPrompt: 'sys', task: 'Investigate and plan the refactor.',
    tools: CORE_TOOLS, toolProtocol: 'native',
    devMode, maxTurns: 6,
    onEvent: (e) => events.push(e),
  } as any);
  return { promise: runner.run(), events };
}

describe('Plan/Act modes (Cline-style)', () => {
  test('plan mode: mutating tool calls are hard-blocked with read-only guidance; reads still work', async () => {
    const companion = makeCompanion([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'nope' } }] },
      { toolCalls: [{ id: 'c2', name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'plan proposed' } }] },
    ]);
    const { promise, events } = run(companion, 'plan');
    const r = await promise;
    const blocked = events.find((e) => e.type === 'tool_end' && e.entry.tool === 'write_file');
    expect(blocked.entry.status).toBe('error');
    expect(blocked.entry.output).toContain('Plan mode');
    expect(blocked.entry.output).toContain('read-only');
    expect(companion.filesWritten ?? []).toEqual([]); // no write reached the companion (filesWritten stays empty)
    // reads still executed
    const listed = events.find((e) => e.type === 'tool_end' && e.entry.tool === 'list_dir');
    expect(listed.entry.status).toBe('ok');
    // and the run finished normally
    expect(r.content).toBe('plan proposed');
  });

  test('plan mode: mutating tools are absent from the native tool declarations', () => {
    const companion = makeCompanion([]);
    const runner = new AgentRunner({
      companion, workspaceId: 'ws1', provider: { kind: 'openai', baseUrl: 'http://x/v1' } as any, model: 'm',
      systemPrompt: 'sys', task: 'plan', tools: CORE_TOOLS, toolProtocol: 'native', devMode: 'plan',
    } as any);
    const decls = (runner as any).wireTools().map((d: any) => d.function.name);
    expect(decls).not.toContain('write_file');
    expect(decls).not.toContain('edit_file');
    expect(decls).not.toContain('delete_path');
    expect(decls).toContain('read_file');
    expect(decls).toContain('finish');
  });

  test('act mode: tools unchanged and no plan block in the prompt', () => {
    const companion = makeCompanion([]);
    const runner = new AgentRunner({
      companion, workspaceId: 'ws1', provider: { kind: 'openai', baseUrl: 'http://x/v1' } as any, model: 'm',
      systemPrompt: 'sys', task: 'do it', tools: CORE_TOOLS, toolProtocol: 'native', devMode: 'act',
    } as any);
    const decls = (runner as any).wireTools().map((d: any) => d.function.name);
    expect(decls).toContain('write_file');
    expect(decls).toContain('edit_file');
    expect(agentSystemPrompt({ workspacePath: '/w', platform: 'linux' }, 'task', 'act')).not.toContain('PLAN MODE');
    expect(agentSystemPrompt({ workspacePath: '/w', platform: 'linux' }, 'task', 'plan')).toContain(PLAN_MODE_ADDON.slice(0, 40));
  });
});
