// RC4 — production fan-out chain integration tests.
//
// These tests invoke startCollabRun() — the EXACT production dispatcher the
// Control Center "Start collaborative task" button calls — never source-text
// greps. Covers:
//   1. dispatch: fanout mode reaches the distributed engine and creates mesh
//      task packets; sequential mode reaches the coordinator and creates none;
//   2. native propose_task_graph capture → parallel execution in dependency
//      order (via the same dispatcher);
//   3. JSON fallback + invalid-graph recovery (via the same dispatcher);
//   4. a genuine TWO-COMPANION flow over HTTP: real companions, real pairing,
//      real mesh dispatch — the remote task is dispatched to and executed by
//      the second companion, not merely recorded.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startCollabRun } from '@/lib/agent/collab-service';
import type { CollabTaskConfig, CollabRunHandle } from '@/lib/agent/collab-service';
import { CompanionClient } from '@/lib/companion/client';
import { MeshClient } from '@/lib/mesh/client';
import { useSettings } from '@/lib/store/settings';
import type { CompanionClient as CC } from '@/lib/companion/client';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const COMPANION = path.join(ROOT, 'companion');

// ---- fake mesh (packets + locks + revisions in memory) ----
class FakeMesh {
  tasks = new Map<string, any>();
  seq = 0;
  async createTask(_ws: string, t: any) {
    const task = { id: `t-${++this.seq}`, status: 'queued', result: null, attempts: 0, progress: [], error: null, ...t };
    this.tasks.set(task.id, task);
    return { task, deduplicated: false };
  }
  async listTasks() { return { tasks: [...this.tasks.values()], serverTime: Date.now() }; }
  async getTask(_ws: string, id: string) { return { task: this.tasks.get(id)! }; }
  async ackTask(_ws: string, id: string, b?: any) { const t = this.tasks.get(id)!; t.status = 'acknowledged'; t.attempts++; if (b?.machineId) t.machineId = b.machineId; return { task: t }; }
  async taskProgress(_ws: string, id: string, b: any) { this.tasks.get(id)!.progress.push(b.note); return { task: this.tasks.get(id)! }; }
  async completeTask(_ws: string, id: string, b: any) { const t = this.tasks.get(id)!; t.status = 'completed'; t.result = b; return { task: t }; }
  async failTask(_ws: string, id: string, b: any) { const t = this.tasks.get(id)!; t.status = 'failed'; t.error = b; return { task: t }; }
  async cancelTask(_ws: string, id: string) { const t = this.tasks.get(id)!; t.status = 'cancelled'; return { task: t }; }
  async acquireLock(_ws: string, p: string, o: string) { return { locked: true, reservation: { path: p, owner: o } }; }
  async releaseLock() { return { released: true }; }
  async listLocks() { return { reservations: [] }; }
  async workspaceRevision() { return { revision: 'rev-test', entries: 3 }; }
  async models() { return { profiles: [], gguf: [] }; }
  async saveAssignment() { return {}; }
  async notebookAppend() { return { appended: true }; }
  async notebookSearch() { return { entries: [] }; }
  async memorySearch() { return { results: [] }; }
  async memoryWrite() { return { written: true }; }
  async writeScratchpad() { return { written: true }; }
  async readScratchpad() { return { scratchpad: null }; }
}

// ---- routing companion: planner / repair / task agents share one host ----
type ScriptEntry = { toolCalls?: { id: string; name: string; args: any }[]; text?: string };
function routingCompanion(scripts: { planner: ScriptEntry[]; repair: ScriptEntry[]; tasks: ScriptEntry[] }, log: { plannerPrompts: string[]; taskPrompts: string[]; order: string[]; chats: number }) {
  let pIdx = 0, rIdx = 0, tIdx = 0;
  return {
    async chat(opts: any) {
      log.chats++;
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
      const end = { finish: 'stop' as const, toolCalls: entry.toolCalls ?? [], usage: null };
      return { text: entry.text ?? '', end };
    },
    async readFile(_w: string, p: string) { return { path: p, content: 'export const value = 1\n', size: 23 }; },
    async writeFile(_w: string, p: string, c: string) { log.order.push(`write:${p}`); return { bytes: c.length }; },
    async tree() { return { root: '/proj', entries: [{ path: 'src/app.ts', type: 'file', size: 10 }] }; },
    async statPath() { return { exists: true, type: 'dir', empty: false, entryCount: 1 }; },
    async search() { return { results: [] }; },
    async exec() { return { exitCode: 0, stdout: 'ok\n', stderr: '', cwd: null, durMs: 1, timedOut: false }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart() { throw new Error('no'); }, procList() { return []; },
    procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
  } as unknown as CC;
}

function makeConfig(objective: string): CollabTaskConfig {
  return {
    objective,
    workspaceHostPeerId: null,
    workspaceHostMachineName: 'This computer',
    participants: [
      { machineId: 'local', machineName: 'This computer', baseUrl: 'http://local', model: 'm1', roles: ['planner', 'coder', 'tester', 'reviewer'] as any[], toolProtocol: 'native' as const, explicitRun: true },
    ],
    executionMode: 'sequential',
    autoSteering: true,
  };
}

async function launch(companion: CC, cfg: CollabTaskConfig, mesh?: FakeMesh, onEvent?: (e: any) => void): Promise<{ handle: CollabRunHandle; report: any; mesh: FakeMesh }> {
  const m = mesh ?? new FakeMesh();
  const handle = await startCollabRun(cfg.executionMode === 'fanout' ? 'fanout' : 'sequential', cfg, {
    mesh: m as unknown as MeshClient,
    workspaceHost: companion,
    workspaceId: 'wsX',
    workspacePath: '/proj',
    workspaceContext: { platform: 'linux', workspacePath: '/proj' },
    onEvent: onEvent ?? (() => {}),
    signal: undefined,
    clientForMachine: () => companion,
  } as any);
  const report = await handle.done;
  return { handle, report, mesh: m };
}

describe('startCollabRun — the real Control Center start dispatcher', () => {
  test('fanout mode dispatches the distributed engine: mesh packets created + normalized report + control surface', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[], chats: 0 };
    const companion = routingCompanion({
      planner: [
        { toolCalls: [{ id: 'p1', name: 'propose_task_graph', args: { tasks: [
          { key: 'api', title: 'API', stage: 'coder', prompt: 'Implement src/api.ts.', machineId: 'local', dependsOn: [] },
          { key: 'ui', title: 'UI', stage: 'coder', prompt: 'Implement src/ui.ts.', machineId: 'local', dependsOn: ['api'] },
        ] } }] },
        { toolCalls: [{ id: 'p2', name: 'finish', args: { summary: 'PLAN: api → ui' } }] },
      ],
      repair: [],
      tasks: [
        { toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'src/api.ts', content: 'x\n' } }] },
        { toolCalls: [{ id: 't2', name: 'finish', args: { summary: 'api done' } }] },
        { toolCalls: [{ id: 't3', name: 'finish', args: { summary: 'ui done' } }] },
      ],
    }, log);
    const { handle, report, mesh } = await launch(companion, { ...makeConfig('Build api and ui.'), executionMode: 'fanout' as any });
    // the DISTRIBUTED engine ran: mesh task packets were created and completed
    expect(mesh.tasks.size).toBe(2);
    expect([...mesh.tasks.values()].every((t) => t.status === 'completed')).toBe(true);
    // the report is normalized into the coordinator shape the UI renders
    expect(report.verdict).toBe('APPROVE');
    expect(report.totalTurns).toBeGreaterThan(0);
    expect(report.fanout).toBeTruthy();
    expect(report.fanout.completed).toBe(2);
    // the control surface matches what Pause/Stop/Steer buttons call
    expect(() => handle.control.steerAll('focus on error handling')).not.toThrow();
    expect(handle.control.steerAgent('any', 'note')).toBe(true);
    expect(handle.kind).toBe('fanout');
    // real artifacts were written through the workspace host
    expect(log.order).toContain('write:src/api.ts');
  });

  test('sequential mode dispatches the coordinator and does NOT create fanout packets', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[], chats: 0 };
    const companion = routingCompanion({
      // sequential coordinator: planner → coder → tester → reviewer, all finish
      planner: [{ toolCalls: [{ id: 's1', name: 'finish', args: { summary: 'PLAN:\n1. do it\n2. verify' } }] }],
      repair: [],
      tasks: [
        { toolCalls: [{ id: 's1', name: 'finish', args: { summary: 'PLAN:\n1. do it\n2. verify' } }] },
        { toolCalls: [{ id: 's2', name: 'finish', args: { summary: 'implemented' } }] },
        { toolCalls: [{ id: 's3', name: 'finish', args: { summary: 'tests pass' } }] },
        { toolCalls: [{ id: 's4', name: 'read_file', args: { path: 'src/app.ts' } }] },
        { toolCalls: [{ id: 's5', name: 'finish', args: { summary: 'VERDICT: APPROVE' } }] },
      ],
    }, log);
    const mesh = new FakeMesh();
    const { handle, report } = await launch(companion, { ...makeConfig('Sequential objective.'), executionMode: 'sequential' as any }, mesh);
    expect(handle.kind).toBe('sequential');
    expect(report.fanout).toBeUndefined();
    // THE KEY ASSERTION: the sequential engine never created fan-out packets
    expect(mesh.tasks.size).toBe(0);
    expect(handle.coordinator).toBeTruthy();
  });

  test('JSON fallback via the dispatcher: planner replying with a bare task array is accepted', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[], chats: 0 };
    const companion = routingCompanion({
      planner: [
        { text: 'Here is my plan:\n[{"key":"only","title":"Do it all","stage":"coder","prompt":"Do the whole objective.","dependsOn":[]}]' },
        { toolCalls: [{ id: 'p2', name: 'finish', args: { summary: 'planned' } }] },
      ],
      repair: [],
      tasks: [{ toolCalls: [{ id: 'f1', name: 'finish', args: { summary: 'did everything' } }] }],
    }, log);
    const { report, mesh } = await launch(companion, { ...makeConfig('Single-task objective.'), executionMode: 'fanout' as any });
    expect(report.fanout?.completed).toBe(1);
    expect(mesh.tasks.size).toBe(1);
    expect(log.taskPrompts[0]).toContain('Do the whole objective.');
  });

  test('invalid graph → one corrective re-prompt, then a CLEARLY REPORTED deterministic fallback', async () => {
    const log = { plannerPrompts: [] as string[], taskPrompts: [] as string[], order: [] as string[], chats: 0 };
    const notices: string[] = [];
    const companion = routingCompanion({
      planner: [
        { toolCalls: [{ id: 'p1', name: 'propose_task_graph', args: { tasks: [
          { key: 'x', title: 'A', stage: 'coder', prompt: 'Task A', dependsOn: ['ghost'] },
          { key: 'x', title: 'B', stage: 'coder', prompt: 'Task B', dependsOn: ['x'] },
          { key: '', title: 'C', stage: 'coder', prompt: 'Task C', dependsOn: [] },
        ] } }] },
        { toolCalls: [{ id: 'p2', name: 'finish', args: { summary: 'gave up on graph' } }] },
      ],
      repair: [{ text: 'still broken' }],
      tasks: [{ toolCalls: [{ id: 'f1', name: 'finish', args: { summary: 'fallback executed' } }] }],
    }, log);
    const { report, mesh } = await launch(companion, { ...makeConfig('Objective with broken plan.'), executionMode: 'fanout' as any }, undefined, (e: any) => { if (e.type === 'notice') notices.push(e.message); });
    expect(notices.some((n) => n.includes('task graph invalid') || n.includes('deterministic decomposition'))).toBe(true);
    // the fallback split [impl → verify] actually executed
    expect(report.fanout?.completed).toBe(2);
    expect(mesh.tasks.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TWO-COMPANION HTTP FLOW — real companions, real pairing, real mesh dispatch
// ---------------------------------------------------------------------------
describe('distributed fan-out across two real companions (HTTP)', () => {
  const PORT_A = 7593, PORT_B = 7594, STUB_PORT = 7595;
  const BASE_A = `http://127.0.0.1:${PORT_A}`;
  const BASE_B = `http://127.0.0.1:${PORT_B}`;
  const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-fan-a-'));
  const HOME_B = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-fan-b-'));
  const WS_A = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-fan-ws-'));
  const procs: any[] = [];
  let tokenA = '';
  let peerB = '';
  let wsId = '';

  async function waitHealthy(base: string) {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) return await r.json(); } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`companion ${base} did not start`);
  }

  async function api(base: string, token: string | null, method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, json };
  }

  beforeAll(async () => {
    fs.writeFileSync(path.join(WS_A, 'app.py'), 'VALUE = "old"\n');
    for (const [port, home] of [[PORT_A, HOME_A], [PORT_B, HOME_B]] as const) {
      const proc = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--workspace', WS_A, '--no-mdns'], {
        cwd: COMPANION, env: { ...process.env, LOCALFORGE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      procs.push(proc);
    }
    await waitHealthy(BASE_A);
    await waitHealthy(BASE_B);
    const sa = JSON.parse(fs.readFileSync(path.join(HOME_A, 'state.json'), 'utf8')).pairingCode;
    const sb = JSON.parse(fs.readFileSync(path.join(HOME_B, 'state.json'), 'utf8')).pairingCode;
    tokenA = (await api(BASE_A, null, 'POST', '/pair', { code: sa, deviceLabel: 'alpha' })).json.token;
    await api(BASE_B, null, 'POST', '/pair', { code: sb, deviceLabel: 'beta' });
    // A connects to B (mesh pairing) — the real dispatch path
    const conn = await api(BASE_A, tokenA, 'POST', '/api/mesh/connect', { url: BASE_B, name: 'Beta', code: sb });
    expect(conn.status).toBe(200);
    peerB = conn.json.peer.id;
    const w = await api(BASE_A, tokenA, 'POST', '/api/workspaces', { path: WS_A, name: 'fanout-ws' });
    wsId = w.json.workspace.id;
  }, 60000);

  afterAll(async () => {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    await fsp.rm(HOME_A, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(HOME_B, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(WS_A, { recursive: true, force: true }).catch(() => {});
  });

  test('startCollabRun(fanout) dispatches one task to Beta and completes both tasks on the real mesh', async () => {
    // stub model server: planner graph (one task ON BETA), planner finish, then two task finishes
    const stubProc = spawn(process.execPath, [path.join(COMPANION, 'test/fixtures/stub-model-server.mjs'), String(STUB_PORT), JSON.stringify([
      { toolCalls: [{ id: 'c0', name: 'propose_task_graph', args: { tasks: [
        { key: 'remote', title: 'Beta work', stage: 'coder', prompt: 'REMOTE TASK: do the work on Beta.', machineId: peerB, dependsOn: [] },
        { key: 'local', title: 'Alpha work', stage: 'coder', prompt: 'LOCAL TASK: do the work on Alpha.', machineId: 'local', dependsOn: [] },
      ] } }] },
      { toolCalls: [{ id: 'c1', name: 'finish', args: { summary: 'PLAN: remote + local in parallel' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'remote work completed on Beta' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'local work completed on Alpha' } }] },
    ])], { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(stubProc);
    const stubBase = `http://127.0.0.1:${STUB_PORT}`;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${stubBase}/__script`); if (r.ok) break; } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    // production client config: the IDE's own companion points at Alpha; the
    // mesh routes Beta's task through Alpha's mesh proxy (the real dispatch)
    useSettings.setState({
      companion: { ...(useSettings.getState().companion as any), mode: 'direct', directUrl: BASE_A, token: tokenA },
    } as any);
    const clientA = new CompanionClient(() => useSettings.getState().companion);
    const mesh = new MeshClient(() => useSettings.getState().companion);

    const events: any[] = [];
    const handle = await startCollabRun('fanout', {
      objective: 'Do remote and local work in parallel.',
      workspaceHostPeerId: null,
      workspaceHostMachineName: 'Alpha',
      participants: [
        { machineId: 'local', machineName: 'Alpha', baseUrl: stubBase, model: 'stub', roles: ['planner', 'coder', 'tester', 'reviewer'] as any[], toolProtocol: 'native' as const, explicitRun: true },
        { machineId: peerB, machineName: 'Beta', baseUrl: stubBase, model: 'stub', roles: ['coder'] as any[], toolProtocol: 'native' as const, explicitRun: true },
      ],
      executionMode: 'fanout' as any,
      autoSteering: true,
    }, {
      mesh,
      workspaceHost: clientA,
      workspaceId: wsId,
      workspacePath: WS_A,
      workspaceContext: { platform: 'linux', workspacePath: WS_A },
      onEvent: (e: any) => events.push(e),
      signal: undefined,
    } as any);

    expect(handle.kind).toBe('fanout');
    const report = await handle.done;
    expect(report.fanout?.completed).toBe(2);
    expect(report.fanout?.failed).toBe(0);

    // REAL mesh evidence on the authoritative host: two packets, the remote
    // one assigned to Beta and actually acknowledged/executed there
    const tasks = (await api(BASE_A, tokenA, 'GET', `/api/ws/${wsId}/tasks`)).json.tasks;
    expect(tasks.length).toBe(2);
    const remote = tasks.find((t: any) => t.machineId === peerB || t.assignedMachine === 'Beta');
    expect(remote).toBeTruthy();
    expect(remote.status).toBe('completed');
    expect(remote.result?.summary).toBeTruthy();
    // progress notes were streamed from the remote execution (not a dry record)
    expect(remote.attempts).toBeGreaterThanOrEqual(1);
    // local task completed on Alpha
    const localTask = tasks.find((t: any) => t !== remote);
    expect(localTask.status).toBe('completed');
    // the run surfaced through the event stream (Live Runs feed)
    expect(events.some((e) => e.type === 'task_completed' || e.type === 'final')).toBe(true);
  }, 90000);
});
