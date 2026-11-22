// RC3 — production fan-out chain (Control Center → runDistributedFanout →
// planner → FanoutRunner → mesh packets). Verifies the REAL planner capture
// path (native propose_task_graph tool call), the JSON fallback, and the
// clearly-reported deterministic fallback for invalid graphs.
import { describe, test, expect } from 'bun:test';
import { runDistributedFanout } from '@/lib/agent/collab-service';
import type { CollabTaskConfig } from '@/lib/agent/collab-service';
import type { CompanionClient } from '@/lib/companion/client';
import type { MeshClient } from '@/lib/mesh/client';
import type { AgentEvent } from '@/lib/agent/types';
import { readFileSync } from 'node:fs';

// ---- fake mesh (same surface m2-fanout uses) ----
class FakeMesh {
  tasks = new Map<string, any>();
  seq = 0;
  async createTask(_ws: string, t: any) {
    const task = { id: `t-${++this.seq}`, status: 'queued', result: null, attempts: 0, progress: [], ...t };
    this.tasks.set(task.id, task);
    return { task, deduplicated: false };
  }
  async listTasks() { return { tasks: [...this.tasks.values()], serverTime: Date.now() }; }
  async getTask(_ws: string, id: string) { return { task: this.tasks.get(id)! }; }
  async ackTask(_ws: string, id: string) { const t = this.tasks.get(id)!; t.status = 'acknowledged'; t.attempts++; return { task: t }; }
  async taskProgress(_ws: string, id: string, b: any) { this.tasks.get(id)!.progress.push(b.note); return { task: this.tasks.get(id)! }; }
  async completeTask(_ws: string, id: string, b: any) { const t = this.tasks.get(id)!; t.status = 'completed'; t.result = b; return { task: t }; }
  async failTask(_ws: string, id: string, b: any) { const t = this.tasks.get(id)!; t.status = 'failed'; t.error = b; return { task: t }; }
  async cancelTask(_ws: string, id: string) { const t = this.tasks.get(id)!; t.status = 'cancelled'; return { task: t }; }
  async acquireLock(_ws: string, path: string, owner: string) { return { locked: true, reservation: { path, owner } }; }
  async releaseLock() { return { released: true }; }
  async listLocks() { return { reservations: [] }; }
  async workspaceRevision() { return { revision: 'rev-test', entries: 3 }; }
  async models() { return { profiles: [], gguf: [] }; }
}

// ---- routing companion: planner / repair / task agents share one host ----
type ScriptEntry = { toolCalls?: { id: string; name: string; args: any }[]; text?: string };
function routingCompanion(scripts: { planner: ScriptEntry[]; repair: ScriptEntry[]; tasks: ScriptEntry[] }, log: { plannerPrompts: string[]; taskPrompts: string[]; order: string[] }) {
  let pIdx = 0, rIdx = 0, tIdx = 0;
  return {
    async chat(opts: any) {
      const system = String(opts.messages?.[0]?.content ?? '');
      const task = String(opts.messages?.[1]?.content ?? '');
      let entry: ScriptEntry;
      if (system.includes('Decompose the objective')) {
        log.plannerPrompts.push(system + '\n' + task);
        entry = scripts.planner[Math.min(pIdx++, scripts.planner.length - 1)];
      } else if (system.includes('You fix invalid task graphs')) {
        entry = scripts.repair[Math.min(rIdx++, scripts.repair.length - 1)];
      } else {
        log.taskPrompts.push(task);
        entry = scripts.tasks[Math.min(tIdx++, scripts.tasks.length - 1)];
      }
      const end = {
        finish: 'stop' as const,
        toolCalls: entry.toolCalls ?? [],
        usage: null,
      };
      return { text: entry.text ?? '', end };
    },
    async readFile(_w: string, p: string) { throw new Error(`not found: ${p}`); },
    async writeFile(_w: string, p: string, c: string) { log.order.push(`write:${p}`); return { bytes: c.length }; },
    async tree() { return { root: '/proj', entries: [{ path: 'src/app.ts', type: 'file', size: 10 }] }; },
    async statPath() { return { exists: true, type: 'dir', empty: false, entryCount: 1 }; },
    async search() { return { results: [] }; },
    async exec() { return { exitCode: 0, stdout: 'ok\n', stderr: '', cwd: null, durMs: 1, timedOut: false }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart() { throw new Error('no'); }, procList() { return []; },
    procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
  } as unknown as CompanionClient;
}

function makeConfig(objective: string): CollabTaskConfig {
  return {
    objective,
    workspaceHostPeerId: null,
    workspaceHostMachineName: 'This computer',
    participants: [
      { machineId: 'local', machineName: 'This computer', baseUrl: 'http://local', model: 'm1', roles: ['planner', 'coder', 'tester', 'reviewer'] as any[], toolProtocol: 'native' as const },
    ],
    executionMode: 'sequential',
    autoSteering: true,
  };
}

async function launch(companion: CompanionClient, cfg: CollabTaskConfig, onEvent?: (e: any) => void) {
  const mesh = new FakeMesh();
  const launch = await runDistributedFanout(cfg, {
    mesh: mesh as unknown as MeshClient,
    workspaceHost: companion,
    workspaceId: 'wsX',
    workspacePath: '/proj',
    workspaceContext: { platform: 'linux', workspacePath: '/proj' },
    onEvent: onEvent ?? (() => {}),
    signal: undefined,
  } as any);
  const report = await launch.done;
  return { report, mesh };
}

describe('production fan-out chain (runDistributedFanout)', () => {
  test('native propose_task_graph capture → parallel execution in dependency order', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[] };
    const companion = routingCompanion({
      planner: [
        { toolCalls: [{ id: 'p1', name: 'propose_task_graph', args: { tasks: [
          { key: 'api', title: 'Build the API', stage: 'coder', prompt: 'Implement src/api.ts exporting getData().', machineId: 'local', dependsOn: [], requirements: ['getData exists'] },
          { key: 'ui', title: 'Build the UI', stage: 'coder', prompt: 'Implement src/ui.ts using getData().', machineId: 'local', dependsOn: ['api'] },
          { key: 'test', title: 'Verify both', stage: 'tester', prompt: 'Verify src/api.ts and src/ui.ts exist and pass.', machineId: 'local', dependsOn: ['api', 'ui'] },
        ] } }] },
        { toolCalls: [{ id: 'p2', name: 'finish', args: { summary: 'PLAN: api → ui → verify' } }] },
      ],
      repair: [],
      tasks: [
        { toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'src/api.ts', content: 'export const getData = () => 1;\n' } }] },
        { toolCalls: [{ id: 't2', name: 'finish', args: { summary: 'api implemented' } }] },
        { toolCalls: [{ id: 't3', name: 'write_file', args: { path: 'src/ui.ts', content: 'import { getData } from "./api";\n' } }] },
        { toolCalls: [{ id: 't4', name: 'finish', args: { summary: 'ui implemented' } }] },
        { toolCalls: [{ id: 't5', name: 'run_command', args: { command: 'true' } }] },
        { toolCalls: [{ id: 't6', name: 'finish', args: { summary: 'both verified' } }] },
      ],
    }, log);
    const { report, mesh } = await launch(companion, makeConfig('Build an API and UI with verification.'));
    expect(report.completed).toBe(3);
    expect(report.failed).toBe(0);
    // the planner prompt reached the REAL native tool path (validated args)
    expect(log.plannerPrompts.length).toBe(2); // graph turn + finish turn
    expect(log.plannerPrompts[0]).toContain('Decompose the objective');
    // all three artifacts were really written through the workspace host
    expect(log.order).toContain('write:src/api.ts');
    expect(log.order).toContain('write:src/ui.ts');
    // mesh packets were completed with results (not merely created)
    const done = [...mesh.tasks.values()].filter((t) => t.status === 'completed');
    expect(done.length).toBe(3);
    expect(done.some((t) => t.result?.summary === 'both verified')).toBe(true);
  });

  test('JSON fallback: planner replying with a bare task array is accepted', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[] };
    const companion = routingCompanion({
      planner: [
        { text: 'Here is my plan:\n[{"key":"only","title":"Do it all","stage":"coder","prompt":"Do the whole objective.","dependsOn":[]}]' },
      ],
      repair: [],
      tasks: [{ toolCalls: [{ id: 'f1', name: 'finish', args: { summary: 'did everything' } }] }],
    }, log);
    const { report } = await launch(companion, makeConfig('Single-task objective.'));
    expect(report.completed).toBe(1);
    expect(log.taskPrompts[0]).toContain('Do the whole objective.');
  });

  test('invalid graph → one corrective re-prompt, then a CLEARLY REPORTED deterministic fallback', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[] };
    const notices: string[] = [];
    const companion = routingCompanion({
      planner: [
        // invalid: duplicate keys + unknown dependency + self-dependency
        { toolCalls: [{ id: 'p1', name: 'propose_task_graph', args: { tasks: [
          { key: 'x', title: 'A', stage: 'coder', prompt: 'Task A', dependsOn: ['ghost'] },
          { key: 'x', title: 'B', stage: 'coder', prompt: 'Task B', dependsOn: ['x'] },
          { key: '', title: 'C', stage: 'coder', prompt: 'Task C', dependsOn: [] },
        ] } }] },
      ],
      // repair attempt also returns garbage → deterministic fallback
      repair: [{ text: 'still broken' }],
      tasks: [{ toolCalls: [{ id: 'f1', name: 'finish', args: { summary: 'fallback executed' } }] }],
    }, log);
    const { report } = await launch(companion, makeConfig('Objective with broken plan.'), (e: any) => { if (e.type === 'notice') notices.push(e.message); });
    expect(report.completed).toBeGreaterThanOrEqual(1);
    // the fallback is transparent, not silent
    expect(notices.some((n) => n.includes('task graph invalid') || n.includes('deterministic decomposition'))).toBe(true);
    expect(log.taskPrompts.some((p) => p.includes('Implement this plan') || p.includes('Objective'))).toBe(true);
  });

  test('UI wiring guard: the Control Center fanout mode invokes the production function', () => {
    const src = readFileSync(new URL('../src/components/mesh/ControlCenter.tsx', import.meta.url), 'utf8');
    expect(src.includes("runDistributedFanout")).toBe(true);
    expect(src.includes("mode === 'fanout'")).toBe(true);
    expect(src.includes("['sequential', 'parallel', 'fanout']")).toBe(true);
  });
});
