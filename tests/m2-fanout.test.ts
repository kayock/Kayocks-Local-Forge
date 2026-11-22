// Milestone 2 — FanoutRunner: dependency waves, parallel execution across
// machines, durable packets, failure reassignment, cancellation, conflicts.
import { describe, test, expect } from 'bun:test';
import { FanoutRunner, type FanoutMachine, type FanoutTaskSpec } from '@/lib/agent/fanout';
import type { MeshClient, FleetTask } from '@/lib/mesh/client';
import type { CompanionClient } from '@/lib/companion/client';
import type { AgentEvent, ToolProtocolMode } from '@/lib/agent/types';

// ---- fake mesh: task packets + locks + revisions in memory ----
class FakeMesh {
  tasks = new Map<string, FleetTask>();
  locks = new Map<string, string>();
  seq = 0;
  revisionValue = 'rev-0001';
  constructor(public revisionFn?: () => string) {}
  async createTask(wsId: string, t: any) {
    const dedup = [...this.tasks.values()].find((x) => x.dedupKey === t.dedupKey);
    if (dedup) return { task: dedup, deduplicated: true };
    const task: FleetTask = {
      id: `t-${++this.seq}`, wsId, title: t.title, contract: t.contract ?? null,
      requirements: t.requirements ?? [], contextFiles: t.contextFiles ?? [],
      workspaceMapping: t.workspaceMapping ?? null, assignedMachine: t.assignedMachine ?? null,
      machineId: t.machineId ?? null, agentId: t.agentId ?? null, dedupKey: t.dedupKey ?? null,
      dependsOn: t.dependsOn ?? [], priority: t.priority ?? 5, status: 'queued',
      progress: [], result: null, error: null, evidence: [], attempts: 0,
      createdAt: Date.now(), updatedAt: Date.now(), acknowledgedAt: null, endedAt: null,
    };
    this.tasks.set(task.id, task);
    return { task, deduplicated: false };
  }
  async listTasks(wsId: string, opts: any = {}) { return { tasks: [...this.tasks.values()], serverTime: Date.now() }; }
  async getTask(wsId: string, id: string) { return { task: this.tasks.get(id)! }; }
  async ackTask(wsId: string, id: string, body: any) {
    const t = this.tasks.get(id)!; t.status = 'acknowledged'; t.attempts += 1; t.agentId = body?.agentId ?? null; t.machineId = body?.machineId ?? null;
    return { task: t };
  }
  async taskProgress(wsId: string, id: string, body: any) {
    const t = this.tasks.get(id)!; t.progress.push({ note: body.note, at: Date.now() }); t.updatedAt = Date.now();
    return { task: t };
  }
  async completeTask(wsId: string, id: string, body: any) {
    const t = this.tasks.get(id)!; t.status = 'completed'; t.result = { summary: body.summary, artifacts: body.artifacts ?? [], filesChanged: body.filesChanged ?? [], revisionAfter: body.revisionAfter ?? null };
    t.endedAt = Date.now(); return { task: t };
  }
  async failTask(wsId: string, id: string, body: any) {
    const t = this.tasks.get(id)!; t.status = 'failed'; t.error = { reason: body.reason, recoverable: body.recoverable !== false }; t.endedAt = Date.now();
    return { task: t };
  }
  async cancelTask(wsId: string, id: string, body: any) {
    const t = this.tasks.get(id)!; t.status = 'cancelled'; t.endedAt = Date.now(); return { task: t };
  }
  async acquireLock(wsId: string, path: string, owner: string, opts?: any) {
    const holder = this.locks.get(path);
    if (holder && holder !== owner) throw new Error(`"${path}" is reserved by another writer (${holder})`);
    this.locks.set(path, owner);
    return { locked: true, reservation: { path, owner, expiresAt: Date.now() + 60000 } };
  }
  async releaseLock(wsId: string, path: string, owner: string) { this.locks.delete(path); return { released: true }; }
  async listLocks(wsId: string) { return { reservations: [...this.locks.entries()].map(([path, owner]) => ({ path, owner, expiresAt: 0, createdAt: 0 })) }; }
  async workspaceRevision(wsId: string, peerId?: string | null) { return { revision: this.revisionFn ? this.revisionFn() : this.revisionValue, entries: 3 }; }
}

// ---- fake companion for machine clients: minimal chat+workspace surface ----
function fakeCompanion(behavior: { failTask?: boolean; onTask?: (taskText: string) => void }) {
  return {
    async chat(opts: any) {
      behavior.onTask?.(opts.messages[opts.messages.length - 1]?.content || '');
      if (behavior.failTask) throw new Error('model endpoint misconfigured: unsupported tool schema');
      const end = { t: 'end', toolCalls: [{ id: 'c1', name: 'finish', args: { summary: `did: ${opts.messages[opts.messages.length - 1]?.content?.slice(0, 40) || 'work'}` } }] };
      opts.onChunk?.(end);
      return { text: '', end };
    },
  } as unknown as CompanionClient;
}

const machines: FanoutMachine[] = [
  { machineId: 'local', name: 'This computer', model: 'local-model', provider: { kind: 'openai', baseUrl: 'http://local' } as any },
  { machineId: 'peer-b', name: 'GPU Box', model: 'b-model', provider: { kind: 'openai', baseUrl: 'http://b' } as any },
];

function makeRunner(opts: {
  tasks: FanoutTaskSpec[];
  mesh: FakeMesh;
  clients: Record<string, CompanionClient>;
  runnerFactory?: any;
  reassignOnFailure?: boolean;
  machines?: FanoutMachine[];
  onEvent?: (e: AgentEvent & { fanoutKey?: string }) => void;
}) {
  return new FanoutRunner({
    workspaceHost: opts.clients['local'],
    workspaceId: 'wsX',
    workspacePath: '/proj',
    mesh: opts.mesh as unknown as MeshClient,
    machines: opts.machines ?? machines,
    tasks: opts.tasks,
    maxTurnsPerTask: 5,
    reassignOnFailure: opts.reassignOnFailure,
    onEvent: opts.onEvent ?? (() => {}),
    clientForMachine: (id) => opts.clients[id] ?? opts.clients['local'],
    runnerFactory: opts.runnerFactory,
    fetchRevision: async () => opts.mesh.revisionFn ? opts.mesh.revisionFn() : opts.mesh.revisionValue,
  });
}

describe('M2 — FanoutRunner distributed orchestration', () => {
  test('waves(): dependency-aware topological scheduling', () => {
    const mesh = new FakeMesh();
    const runner = makeRunner({
      tasks: [
        { key: 'a', title: 'A', stage: 'coder', prompt: 'do a' },
        { key: 'b', title: 'B', stage: 'coder', prompt: 'do b' },
        { key: 'c', title: 'C after A+B', stage: 'tester', prompt: 'verify', dependsOn: ['a', 'b'] },
        { key: 'd', title: 'D after C', stage: 'reviewer', prompt: 'review', dependsOn: ['c'] },
      ],
      mesh,
      clients: { local: fakeCompanion({}), 'peer-b': fakeCompanion({}) },
    });
    const w = runner.waves();
    expect(w.length).toBe(3);
    expect(w[0].sort()).toEqual(['a', 'b']);
    expect(w[1]).toEqual(['c']);
    expect(w[2]).toEqual(['d']);
  });

  test('waves(): cycle degrades instead of deadlocking', () => {
    const mesh = new FakeMesh();
    const runner = makeRunner({
      tasks: [
        { key: 'x', title: 'X', stage: 'coder', prompt: 'x', dependsOn: ['y'] },
        { key: 'y', title: 'Y', stage: 'coder', prompt: 'y', dependsOn: ['x'] },
      ],
      mesh, clients: { local: fakeCompanion({}) },
    });
    const w = runner.waves();
    expect(w.flat().sort()).toEqual(['x', 'y']); // all remaining land in one wave
  });

  test('parallel fan-out executes on assigned machines with packets, acks and completion records', async () => {
    const mesh = new FakeMesh();
    const ranOn = new Map<string, string>();
    const clients = {
      local: fakeCompanion({ onTask: (t) => ranOn.set(t, 'local') }),
      'peer-b': fakeCompanion({ onTask: (t) => ranOn.set(t, 'peer-b') }),
    };
    const events: any[] = [];
    const runner = makeRunner({
      tasks: [
        { key: 'task-a', title: 'A', stage: 'coder', prompt: 'TASK-A-WORK', machineId: 'local', requirements: ['a done'] },
        { key: 'task-b', title: 'B', stage: 'coder', prompt: 'TASK-B-WORK', machineId: 'peer-b' },
      ],
      mesh, clients,
      onEvent: (e) => events.push(e),
    });
    const report = await runner.run();
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(0);
    const packetA = [...mesh.tasks.values()].find((t) => t.dedupKey === 'task-a')!;
    const packetB = [...mesh.tasks.values()].find((t) => t.dedupKey === 'task-b')!;
    expect(packetA.status).toBe('completed');
    expect(packetA.machineId).toBe('local');
    expect(packetB.machineId).toBe('peer-b');
    expect(packetB.attempts).toBe(1);
    expect(packetA.result?.filesChanged).toEqual([]);
    // model routing: each task's prompt reached its own machine's client
    expect([...ranOn.values()].includes('peer-b')).toBe(true);
    // events carry the fanout key + machine attribution
    const endEvents = events.filter((e) => e.type === 'final');
    expect(endEvents.some((e) => e.fanoutKey === 'task-a' && e.machine === 'This computer')).toBe(true);
    expect(endEvents.some((e) => e.fanoutKey === 'task-b' && e.machine === 'GPU Box')).toBe(true);
  });

  test('machine failure → packet failed → reassignment to the other machine with steering note', async () => {
    const mesh = new FakeMesh();
    const seenPrompts: string[] = [];
    const clients = {
      local: fakeCompanion({ failTask: true }), // local always fails
      'peer-b': fakeCompanion({ onTask: (t) => seenPrompts.push(t) }),
    };
    const runner = makeRunner({
      tasks: [{ key: 'f-task', title: 'F', stage: 'coder', prompt: 'F-WORK', machineId: 'local' }],
      mesh, clients, reassignOnFailure: true,
    });
    const report = await runner.run();
    expect(report.completed).toBe(1);
    const result = report.results[0];
    expect(result.reassignedFrom).toBe('This computer');
    expect(result.machineId).toBe('peer-b');
    // the reassigned agent was told about the failure explicitly
    expect(seenPrompts.some((p) => p.includes('previous attempt of this task on machine') && p.includes('failed'))).toBe(true);
    // both attempts recorded durably
    const statuses = [...mesh.tasks.values()].map((t) => t.status);
    expect(statuses).toContain('failed');
    expect(statuses).toContain('completed');
  });

  test('cancellation stops queued tasks; running agent pauses at boundary', async () => {
    const mesh = new FakeMesh();
    let releaseRunner: (() => void) | null = null;
    const gate = new Promise<void>((r) => { releaseRunner = r; });
    const runner = makeRunner({
      tasks: [
        { key: 'slow', title: 'S', stage: 'coder', prompt: 'S-WORK' },
        { key: 'after', title: 'D', stage: 'tester', prompt: 'D-WORK', dependsOn: ['slow'] },
      ],
      mesh, clients: { local: fakeCompanion({}), 'peer-b': fakeCompanion({}) },
      runnerFactory: (cfg: any) => ({
        run: async () => {
          await gate; // hold the first task until cancel() is issued
          return { content: 'held task finished after cancel', turns: 1, messages: [], hitTurnLimit: false, filesChanged: [] };
        },
        steer: () => {},
        requestPause: () => {},
      }),
    });
    const runPromise = runner.run();
    await new Promise((r) => setTimeout(r, 50));
    runner.cancel();
    releaseRunner!();
    const report = await runPromise;
    expect(report.results.find((r) => r.key === 'after')?.status).toBe('cancelled');
    expect(report.cancelled).toBe(1);
    expect(report.completed).toBe(1); // the in-flight task finished at its boundary
  });

  test('dependency order respected: dependent task starts only after upstream completes', async () => {
    const mesh = new FakeMesh();
    const order: string[] = [];
    const clients = {
      local: fakeCompanion({ onTask: (t) => order.push(t.split('\n')[0].slice(0, 12)) }),
      'peer-b': fakeCompanion({ onTask: (t) => order.push(t.split('\n')[0].slice(0, 12)) }),
    };
    const runner = makeRunner({
      tasks: [
        { key: 'first', title: 'F', stage: 'coder', prompt: 'FIRST-WORK' },
        { key: 'second', title: 'S', stage: 'coder', prompt: 'SECOND-WORK', dependsOn: ['first'] },
      ],
      mesh, clients,
    });
    await runner.run();
    const f = order.findIndex((o) => o.includes('FIRST-WORK'));
    const s = order.findIndex((o) => o.includes('SECOND-WORK'));
    expect(f).toBeGreaterThanOrEqual(0);
    expect(s).toBeGreaterThan(f);
    const secondPacket = [...mesh.tasks.values()].find((t) => t.dedupKey === 'second')!;
    expect(secondPacket.status).toBe('completed');
  });

  test('idempotent re-run of the same graph reports the recorded outcome (dedup)', async () => {
    const mesh = new FakeMesh();
    const clients = { local: fakeCompanion({}), 'peer-b': fakeCompanion({}) };
    const specs: FanoutTaskSpec[] = [{ key: 'idem', title: 'I', stage: 'coder', prompt: 'IDEM-WORK', dedupHack: undefined } as any];
    const r1 = await makeRunner({ tasks: specs, mesh, clients }).run();
    expect(r1.completed).toBe(1);
    // second run: same dedupKeys → recorded outcomes returned, no re-execution
    const r2 = await makeRunner({ tasks: specs, mesh, clients }).run();
    expect(r2.completed).toBe(1);
    expect(r2.results[0].taskId).toBe(r1.results[0].taskId);
    expect(r2.results[0].turns).toBe(0); // no agent ran again
  });

  test('a manual machine is not used when the preferred worker fails', async () => {
    const mesh = new FakeMesh();
    const windowsPrompts: string[] = [];
    const clients = {
      local: fakeCompanion({ failTask: true }),
      'peer-win': fakeCompanion({ onTask: (t) => windowsPrompts.push(t) }),
    };
    const gated: FanoutMachine[] = [
      { machineId: 'local', name: 'Portable', model: 'small', provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:11434' } as any, allowAutomatic: true },
      { machineId: 'peer-win', name: 'Windows', model: 'excluded', provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' } as any, allowAutomatic: false },
    ];
    const runner = makeRunner({
      tasks: [{ key: 'no-win', title: 'N', stage: 'coder', prompt: 'N-WORK', machineId: 'local' }],
      mesh, clients, reassignOnFailure: true, machines: gated,
    });
    const report = await runner.run();
    expect(report.completed).toBe(0);
    expect(report.failed).toBe(1);
    expect(windowsPrompts).toHaveLength(0);
    expect(report.results[0].machineId).not.toBe('peer-win');
  });

  test('write reservations are acquired and released around each task', async () => {
    const mesh = new FakeMesh();
    const clients = { local: fakeCompanion({}), 'peer-b': fakeCompanion({}) };
    const runner = makeRunner({
      tasks: [{ key: 'lk', title: 'L', stage: 'coder', prompt: 'L-WORK', contextFiles: ['src/a.js'] }],
      mesh, clients,
    });
    await runner.run();
    expect(mesh.locks.size).toBe(0); // released after the task
  });
});
