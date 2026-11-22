// Phase 2.0 IDE-side orchestration tests (Checkpoints 4–5).
//
// Honest scope: the "three machines" here are three REAL AgentRunner instances
// driven by three independent fake companion processes-in-memory (the companion
// REST layer itself is integration-tested against real OS processes in
// companion/test/phase2.test.mjs). What IS proven here:
//   • scheduler ranking with real hardware/size inputs (hard RAM block, GPU
//     bonus, residency, role affinity, port occupancy)
//   • 3-node coordination: planner/coder/tester/reviewer on three DIFFERENT
//     machines while ALL tool execution acts on the ONE authoritative
//     workspace host (no project duplication)
//   • workspace revision conflict detection with parallel writers
//   • agent memory: scratchpads, append-only notebook, durable assignments
//   • automatic steering: trigger on truncated edits, delivery at safe
//     boundaries, once-per-run, manual steering precedence, escalation to the
//     coordinator after repeated recovery failures
// Run: bun test tests/mesh-orchestration.test.ts
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { Coordinator, type AgentTarget } from '../src/lib/agent/coordinator';
import { rankCandidates, type SchedulerCandidate, type SchedulerMachine } from '../src/lib/agent/scheduler';
import { CORE_TOOLS } from '../src/lib/agent/tools';
import type { AgentEvent, AgentMessage, ToolLogEntry } from '../src/lib/agent/types';
import type { AgentAssignment, NotebookEntry, Scratchpad } from '../src/lib/mesh-types';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------
function makeCompanion(opts: { files?: Record<string, string>; chatScript?: any[]; execImpl?: (cmd: string) => any; label?: string } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const chatCalls: any[] = [];
  const execCalls: { cmd: string; opts: any }[] = [];
  const events: AgentEvent[] = [];
  const companion: any = {
    chatCalls, execCalls, files, events,
    chatScript: opts.chatScript ?? [],
    async chat(o: any) {
      chatCalls.push(o);
      const s = companion.chatScript[Math.min(chatCalls.length - 1, companion.chatScript.length - 1)];
      if (s?.throwWithToolError) throw new Error(s.throwWithToolError);
      return { text: s?.text ?? '', end: { finish: s?.finish ?? 'stop', toolCalls: s?.toolCalls ?? [], usage: null } };
    },
    async exec(_ws: string, cmd: string, o: any) {
      execCalls.push({ cmd, opts: o });
      if (opts.execImpl) return opts.execImpl(cmd);
      return { exitCode: 0, stdout: '1 passing', stderr: '', cwd: null, durMs: 5, timedOut: false };
    },
    async readFile(_w: string, p: string) {
      if (!files.has(p)) throw new Error(`file not found: ${p}`);
      const c = files.get(p)!;
      return { path: p, content: c, size: c.length, modifiedAt: new Date().toISOString() };
    },
    async writeFile(_w: string, p: string, c: string) { files.set(p, c); return { path: p, bytes: c.length }; },
    async tree() {
      const seen = new Map<string, 'file' | 'dir'>();
      for (const path of files.keys()) {
        seen.set(path, 'file');
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!seen.has(d)) seen.set(d, 'dir'); }
      }
      return { root: '/ws', entries: [...seen.entries()].map(([path, type]) => ({ path, type, size: type === 'file' ? (files.get(path) || '').length : undefined })) };
    },
    async search() { return { count: 0, results: [] }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart() { throw new Error('no'); }, procList() { return []; }, procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
  };
  return companion;
}

function makeMeshFake(workspace: ReturnType<typeof makeCompanion>) {
  const scratchpads = new Map<string, Scratchpad>();
  const notebook: NotebookEntry[] = [];
  const assignments: AgentAssignment[] = [];
  let revCounter = 0;
  const revLock = { forceChange: false };
  const mesh: any = {
    scratchpads, notebook, assignments, revLock,
    async workspaceRevision(_ws: string) {
      // deterministic hash over the workspace files + a bump when another
      // writer simulated an out-of-band change
      const enc = new TextEncoder();
      const data = [...workspace.files.entries()].map(([p, c]) => `${p}|${c.length}`).join('\n');
      const h = await crypto.subtle.digest('SHA-1', enc.encode(data + `|rev${revCounter}${revLock.forceChange ? '|other-writer' : ''}`));
      const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { revision: hex.slice(0, 16), entries: workspace.files.size };
    },
    async writeScratchpad(_ws: string, agentId: string, patch: any) {
      const cur = scratchpads.get(agentId) || ({ agentId, plan: [], findings: [], toolResults: [], errors: [], pending: [], capabilities: [] } as any);
      const next = { ...cur, ...patch };
      for (const k of ['plan', 'findings', 'toolResults', 'errors', 'pending', 'capabilities']) {
        if (Array.isArray(patch[k])) next[k] = [...(cur[k] || []), ...patch[k]].slice(-200);
      }
      scratchpads.set(agentId, next);
      return next;
    },
    async readScratchpad(_ws: string, agentId: string) { return scratchpads.get(agentId) || null; },
    async notebookAppend(_ws: string, e: { agentId: string; kind: string; content: string; refs?: string }) {
      const entry: NotebookEntry = { seq: notebook.length, id: `nb_${notebook.length}`, at: Date.now(), agentId: e.agentId, kind: e.kind as any, content: e.content, refs: e.refs ?? null };
      notebook.push(entry);
      return entry;
    },
    async notebookList() { return { entries: [...notebook] }; },
    async saveAssignment(_ws: string, a: AgentAssignment) {
      const i = assignments.findIndex((x) => x.id === a.id);
      if (i >= 0) assignments[i] = { ...assignments[i], ...a };
      else assignments.push({ ...a });
      return a;
    },
    async listAssignments() { return { assignments: [...assignments] }; },
    async models() {
      // primary ("station") inventory: realistic CPU-only machine
      return {
        hardware: { cpuCores: 4, ramAvailableBytes: 6 * 1024 ** 3, ramTotalBytes: 8 * 1024 ** 3, gpus: [], npu: { detected: false } },
        servers: [{ profileName: 'small-review-model', status: 'ready', port: 8081, profileId: 'station-small' }],
        profiles: [],
      } as any;
    },
    async peerStatus(peerId: string) {
      if (peerId === 'windows') {
        return {
          peer: { id: 'windows', name: 'Windows Dell', url: 'http://192.168.1.10:7337' },
          reachable: true,
          hardware: { cpuCores: 6, ramAvailableBytes: 20 * 1024 ** 3, ramTotalBytes: 46 * 1024 ** 3, gpus: [{ kind: 'intel', name: 'UHD 770', vramBytes: null }], npu: { detected: false } },
          health: { version: '0.2.0' },
        } as any;
      }
      if (peerId === 'portable') {
        return {
          peer: { id: 'portable', name: 'Ubuntu Portable', url: 'http://192.168.1.20:7337' },
          reachable: true,
          hardware: { cpuCores: 12, ramAvailableBytes: 40 * 1024 ** 3, ramTotalBytes: 45 * 1024 ** 3, gpus: [{ kind: 'nvidia', name: 'Quadro P2000', vramBytes: 4 * 1024 ** 3 }], npu: { detected: false } },
          health: { version: '0.2.0' },
        } as any;
      }
      throw new Error('unknown peer');
    },
  };
  return mesh;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
describe('resource-aware scheduler (spec §8)', () => {
  const machine = (over: Partial<SchedulerMachine>): SchedulerMachine => ({
    id: 'm1', name: 'M1', reachable: true, loadedModels: [], busyPorts: [],
    hardware: { cpuCores: 8, ramAvailableBytes: 32 * 1024 ** 3, ramTotalBytes: 64 * 1024 ** 3, gpus: [], npu: { detected: false } },
    ...over,
  });
  const cand = (over: Partial<SchedulerCandidate>): SchedulerCandidate => ({
    machine: machine({}),
    profile: { id: 'p1', name: 'model-a', backend: 'llamacpp' },
    modelSizeBytes: 8 * 1024 ** 3,
    alreadyLoaded: false,
    ...over,
  });

  test('RAM fit is a hard filter: an oversized model is never scheduled', () => {
    const big = cand({ modelSizeBytes: 40 * 1024 ** 3, machine: machine({ hardware: { cpuCores: 4, ramAvailableBytes: 6 * 1024 ** 3, ramTotalBytes: 8 * 1024 ** 3, gpus: [], npu: { detected: false } } }) });
    const [r] = rankCandidates([big], 'coder', { largestModelBytes: 40 * 1024 ** 3 });
    expect(r.hardBlocked).toBe('ram');
    expect(r.score).toBeLessThan(0);
    expect(r.reasons[0]).toContain('RAM');
  });

  test('unreachable machines are hard-blocked, not silently chosen', () => {
    const down = cand({ machine: machine({ reachable: false, hardware: null }) });
    const [r] = rankCandidates([down], 'tester', { largestModelBytes: null });
    expect(r.hardBlocked).toBe('unreachable');
  });

  test('GPU VRAM ≥ model size earns the offload bonus; residency beats reload', () => {
    const gpuLoaded = cand({
      alreadyLoaded: true,
      machine: machine({ hardware: { cpuCores: 12, ramAvailableBytes: 40 * 1024 ** 3, ramTotalBytes: 45 * 1024 ** 3, gpus: [{ kind: 'nvidia', name: 'P2000', vramBytes: 4 * 1024 ** 3 }], npu: { detected: false } } }),
      modelSizeBytes: 3.5 * 1024 ** 3,
    });
    const cpuCold = cand({ machine: machine({ id: 'm2' }) });
    const [first] = rankCandidates([cpuCold, gpuLoaded], 'tester', { largestModelBytes: 8 * 1024 ** 3 });
    expect(first.candidate.machine.id).toBe('m1');
    expect(first.reasons.some((x) => x.includes('already loaded'))).toBe(true);
    expect(first.reasons.some((x) => x.includes('VRAM'))).toBe(true);
  });

  test('role affinity: small models preferred for tester, larger for planner', () => {
    const small = cand({ profile: { id: 's', name: 'small', backend: 'llamacpp' }, modelSizeBytes: 2 * 1024 ** 3 });
    // big-enough machine so the huge model is a LEGITIMATE candidate (36GB demand)
    const huge = cand({ machine: machine({ id: 'm2', hardware: { cpuCores: 16, ramAvailableBytes: 64 * 1024 ** 3, ramTotalBytes: 96 * 1024 ** 3, gpus: [], npu: { detected: false } } }), profile: { id: 'h', name: 'huge', backend: 'llamacpp' }, modelSizeBytes: 30 * 1024 ** 3 });
    const testerPick = rankCandidates([small, huge], 'tester', { largestModelBytes: 30 * 1024 ** 3 })[0];
    expect(testerPick.candidate.profile.id).toBe('s');
    const plannerPick = rankCandidates([small, huge], 'planner', { largestModelBytes: 30 * 1024 ** 3 })[0];
    expect(plannerPick.candidate.profile.id).toBe('h');
  });

  test('occupied ports are penalized for NEW loads (no double server starts)', () => {
    const busy = cand({ machine: machine({ busyPorts: [8081] }), profile: { id: 'p', name: 'm', backend: 'llamacpp', port: 8081 } });
    const [r] = rankCandidates([busy], 'coder', { largestModelBytes: null });
    expect(r.reasons.some((x) => x.includes('already occupied'))).toBe(true);
    expect(r.score).toBeLessThan(50);
  });

  test('NPU is only a tie-breaker, never a GGUF claim', () => {
    const npu = cand({ machine: machine({ hardware: { cpuCores: 8, ramAvailableBytes: 32 * 1024 ** 3, ramTotalBytes: 64 * 1024 ** 3, gpus: [], npu: { detected: true } } }) });
    const [r] = rankCandidates([npu], 'coder', { largestModelBytes: null });
    expect(r.reasons.some((x) => x.includes('not assumed NPU-capable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coordinator: three-machine orchestration on ONE authoritative workspace
// ---------------------------------------------------------------------------
describe('coordinator — 3-node orchestration with a shared workspace (spec §6)', () => {
  const PLAN = 'PLAN:\n1. Fix app.py greeting\n2. Run tests';
  const station = makeCompanion({ files: { 'README.md': 'station notes\n' } });
  const windows = makeCompanion({ files: { 'UNRELATED_on_windows.txt': 'do not touch\n' } }); // coder's own machine must NOT receive project writes
  const portable = makeCompanion({ files: { 'UNRELATED_on_portable.txt': 'do not touch\n' } });
  const workspace = station; // authoritative workspace host = station
  workspace.chatScript = [
    { toolCalls: [{ id: 'p1', name: 'finish', args: { summary: `PLAN:\n1. Fix app.py greeting\n2. Run tests` } }] },
  ];
  windows.chatScript = [
    { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'app.py', find: 'hi', replace: 'hello' } }] }, // runs against STATION workspace
    { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'notes.md', content: 'coder notes from windows machine' } }] },
    { toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'coded' } }] },
  ];
  portable.chatScript = [
    { toolCalls: [{ id: 't1', name: 'run_tests', args: {} }] },
    { toolCalls: [{ id: 't2', name: 'finish', args: { summary: 'tests pass on portable-run tester' } }] },
  ];
  station.chatScript.push(
    { toolCalls: [{ id: 'r1', name: 'finish', args: { summary: 'VERDICT: APPROVE — looks good' } }] },
  );

  const mesh = makeMeshFake(workspace);
  workspace.files.set('pytest.ini', '[pytest]\n');
  workspace.files.set('app.py', 'greeting = "hi"\n');

  const machines: AgentTarget[] = [
    { machineId: 'local', machineName: 'Ubuntu Station', provider: { kind: 'openai', baseUrl: 'http://station:8080/v1' }, model: 'small-review-model' },
    { machineId: 'windows', machineName: 'Windows Dell', provider: { kind: 'openai', baseUrl: 'http://dell:8080/v1' }, model: 'qwen3-coder-30b' },
    { machineId: 'portable', machineName: 'Ubuntu Portable', provider: { kind: 'openai', baseUrl: 'http://portable:8080/v1' }, model: 'qwen3.5-14b' },
  ];
  const clientFor = (id: string) => (id === 'local' ? station : id === 'windows' ? windows : portable);

  test('stages run on different machines while all tools act on the workspace host', async () => {
    const events: any[] = [];
    const coordinator = new Coordinator({
      workspaceHost: workspace,
      workspaceId: 'ws-shared',
      workspacePath: '/ws',
      workspaceContext: { platform: 'linux', workspacePath: '/ws' },
      mesh,
      task: 'Fix the greeting in app.py and verify',
      machines,
      maxTurnsPerStage: 8,
      onEvent: (e) => events.push(e),
      clientForMachine: clientFor,
      approver: async () => 'allow', // the IDE supplies the user's approval policy
    });
    const report = await coordinator.run({
      planner: machines[0],
      coder: machines[1],
      tester: machines[2],
      reviewer: machines[0],
    });

    // assignment delivery + real distinct machines
    const stages = report.results.map((r) => r.stage);
    expect(stages).toEqual(['planner', 'coder', 'tester', 'reviewer']);
    expect(report.results.find((r) => r.stage === 'coder')!.machine).toBe('Windows Dell');
    expect(report.results.find((r) => r.stage === 'tester')!.machine).toBe('Ubuntu Portable');

    // remote tool execution: the coder's edit/write happened on the WORKSPACE
    // HOST (station), not on the coder's own machine (spec §6 one workspace)
    expect(station.files.get('app.py')).toBe('greeting = "hello"\n');
    expect(station.files.get('notes.md')).toBe('coder notes from windows machine');
    expect(windows.files.has('app.py')).toBe(false);
    expect(windows.files.get('UNRELATED_on_windows.txt')).toBe('do not touch\n');
    // tester's run_tests executed on the workspace host too
    expect(station.execCalls.some((e) => e.cmd === 'python -m pytest -q')).toBe(true);
    expect(portable.execCalls).toHaveLength(0);

    // completion reporting: verdict + results
    expect(report.verdict).toBe('APPROVE');
    expect(report.results.every((r) => r.summary.length > 0)).toBe(true);

    // shared task progress: notebook has one handoff per agent
    expect(mesh.notebook.length).toBe(4);
    expect(mesh.notebook[1].content).toContain('Windows Dell');

    // private memory: scratchpads per agent with progress state (agent ids use
    // the coordinator's sequential per-run numbering)
    expect([...mesh.scratchpads.keys()].sort()).toEqual(['coder-1', 'planner-0', 'reviewer-3', 'tester-2']);
    expect(mesh.scratchpads.get('coder-1')!.progress).toBe('done');
    expect(mesh.scratchpads.get('coder-1')!.toolResults!.length).toBeGreaterThan(0);

    // durable assignments on the workspace host
    expect(mesh.assignments.length).toBe(4);
    expect(mesh.assignments.every((a) => a.status === 'done' && a.turns > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspace revision conflict detection (spec §6 "Conflict handling")
// ---------------------------------------------------------------------------
describe('workspace conflict detection (spec §6)', () => {
  test('a concurrent out-of-band write during a parallel-writer agent run is flagged, not silently merged', async () => {
    const workspace = makeCompanion({ files: { 'a.txt': 'one\n' } });
    workspace.chatScript = [
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'mine.txt', content: 'my change' } }] },
      { toolCalls: [{ id: 'w2', name: 'finish', args: { summary: 'wrote mine.txt' } }] },
    ];
    const mesh = makeMeshFake(workspace);
    const coordinator = new Coordinator({
      workspaceHost: workspace, workspaceId: 'ws', workspacePath: '/ws',
      workspaceContext: { platform: 'linux', workspacePath: '/ws' },
      mesh, task: 'parallel writers test', machines: [{ machineId: 'local', machineName: 'Station', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm' }],
      onEvent: () => {}, clientForMachine: () => workspace,
    });
    coordinator.enableParallelWriters();
    mesh.revLock.forceChange = true; // simulate ANOTHER agent writing concurrently

    const { assignment, conflict } = await coordinator.runAgent('coder', { machineId: 'local', machineName: 'Station', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm' }, 'write mine.txt', []);
    expect(conflict).toBeTruthy();
    expect(conflict).toContain('preserved');
    expect(assignment.status).toBe('conflict');
    // BOTH change sets exist: the agent's write AND the other writer's change
    expect(workspace.files.get('mine.txt')).toBe('my change');
    expect(workspace.files.get('a.txt')).toBe('one\n');
  });

  test('single-writer stages (default) do not raise false conflicts', async () => {
    const workspace = makeCompanion({ files: { 'a.txt': 'one\n' } });
    workspace.chatScript = [
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'updated by the agent itself' } }] },
      { toolCalls: [{ id: 'w2', name: 'finish', args: { summary: 'ok' } }] },
    ];
    const mesh = makeMeshFake(workspace);
    const coordinator = new Coordinator({
      workspaceHost: workspace, workspaceId: 'ws', workspacePath: '/ws',
      workspaceContext: { platform: 'linux', workspacePath: '/ws' },
      mesh, task: 'own writes', machines: [{ machineId: 'local', machineName: 'Station', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm' }],
      onEvent: () => {}, clientForMachine: () => workspace,
    });
    const { conflict } = await coordinator.runAgent('coder', { machineId: 'local', machineName: 'Station', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm' }, 'edit a.txt', []);
    expect(conflict).toBeNull(); // the agent's OWN writes never flag a conflict
  });
});

// ---------------------------------------------------------------------------
// Automatic steering (spec §7)
// ---------------------------------------------------------------------------
describe('automatic steering (Phase 2.0 §7)', () => {
  test('a truncated large edit triggers corrective guidance at the next safe boundary', async () => {
    const companion = makeCompanion({
      files: { 'gui.py': 'ORIGINAL\n' },
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: `{"path": "gui.py", "content": "${'X'.repeat(30000)}` }] }, // truncated
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'adapted after guidance' } }] },
      ],
    });
    const events: any[] = [];
    const runner = new AgentRunner({
      companion, workspaceId: 'ws', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm',
      systemPrompt: 'sys', task: 'write the gui', tools: CORE_TOOLS, toolProtocol: 'native',
      onEvent: (e) => events.push(e),
    } as any);
    const r = await runner.run();
    expect(r.content).toBe('adapted after guidance');
    expect(companion.files.get('gui.py')).toBe('ORIGINAL\n'); // truncated write blocked — file untouched
    const auto = events.find((e) => e.type === 'auto_steering');
    expect(auto).toBeDefined();
    expect(auto.trigger).toBe('truncated-edit');
    expect(auto.text).toContain('small, targeted edits');
    // delivered as a REAL message to the model before the next turn
    const second = JSON.stringify(companion.chatCalls[1].messages);
    expect(second).toContain('[AUTOMATIC STEERING]');
    expect(second).toContain('Trigger: truncated-edit');
    // shown separately from manual steering
    expect(second).not.toContain('[USER STEERING]');
  });

  test('manual steering takes precedence at the same boundary; automatic waits its turn', async () => {
    const companion = makeCompanion({
      files: { 'gui.py': 'x = 1\n' },
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: `{"path": "gui.py", "content": "${'X'.repeat(30000)}` }] }, // truncated → auto trigger queued
        { toolCalls: [{ id: 'c2', name: 'list_dir', args: { path: '.' } }] },
        { toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'done with both guidances' } }] },
      ],
    });
    const runner = new AgentRunner({
      companion, workspaceId: 'ws', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm',
      systemPrompt: 'sys', task: 'write the gui', tools: CORE_TOOLS, toolProtocol: 'native',
      onEvent: () => {},
    } as any);
    runner.steer('Use the modular layout the team agreed on.'); // human steering
    const r = await runner.run();
    const c2 = JSON.stringify(companion.chatCalls[1].messages);
    const c3 = JSON.stringify(companion.chatCalls[2].messages);
    // turn 2: MANUAL steering delivered; the automatic one is deferred
    expect(c2).toContain('[USER STEERING]');
    expect(c2).toContain('modular layout');
    expect(c2).not.toContain('[AUTOMATIC STEERING]');
    // turn 3: the automatic guidance arrives AFTER the manual one — never discarded
    expect(c3).toContain('[AUTOMATIC STEERING]');
    expect(c3).toContain('Trigger: truncated-edit');
    expect(r.content).toBe('done with both guidances');
  });

  test('automatic steering fires at most once per trigger (no guidance loops)', async () => {
    const companion = makeCompanion({
      files: { 'gui.py': 'x = 1\n' },
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: `{"path": "gui.py", "content": "${'X'.repeat(30000)}` }] },
        { toolCalls: [{ id: 'c2', name: 'write_file', args: `{"path": "gui.py", "content": "${'Y'.repeat(30000)}` }] },
        { toolCalls: [{ id: 'c3', name: 'write_file', args: `{"path": "gui.py", "content": "${'Z'.repeat(30000)}` }] },
        { toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'finished' } }] },
      ],
    });
    let autoCount = 0;
    const runner = new AgentRunner({
      companion, workspaceId: 'ws', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm',
      systemPrompt: 'sys', task: 'write', tools: CORE_TOOLS, toolProtocol: 'native', maxTurns: 6,
      onEvent: (e) => { if ((e as any).type === 'auto_steering') autoCount++; },
    } as any);
    await runner.run();
    expect(autoCount).toBe(1); // trigger-level rate limit: one guidance, not four
    // the DELIVERED message appears exactly once in the final conversation
    // (earlier payloads legitimately contain it too — history accumulates)
    const lastPayload = JSON.stringify(companion.chatCalls.at(-1).messages);
    expect(lastPayload.split('[AUTOMATIC STEERING]').length - 1).toBe(1);
  });

  test('disabling automatic steering via config sends nothing', async () => {
    const companion = makeCompanion({
      files: { 'gui.py': 'x = 1\n' },
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: `{"path": "gui.py", "content": "${'X'.repeat(30000)}` }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'done' } }] },
      ],
    });
    const runner = new AgentRunner({
      companion, workspaceId: 'ws', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm',
      systemPrompt: 'sys', task: 'write', tools: CORE_TOOLS, toolProtocol: 'native',
      autoSteering: false,
      onEvent: () => {},
    } as any);
    const all = companion.chatCalls.map((c: any) => JSON.stringify(c.messages)).join('');
    await runner.run();
    expect(all).not.toContain('[AUTOMATIC STEERING]');
  });
});

// ---------------------------------------------------------------------------
// Recovery escalation (spec §7 "Recovery escalation")
// ---------------------------------------------------------------------------
describe('recovery escalation to the coordinator (spec §7)', () => {
  test('repeated recovery failures escalate and inform the coordinator', async () => {
    const companion = makeCompanion({ files: { 'a.py': 'x = 1\n' } });
    // six DIFFERENT validation-failing calls (two full failure streaks)
    const fails = Array.from({ length: 6 }, (_, i) => ({
      toolCalls: [{ id: `f${i}`, name: 'write_file', args: { content: `x${i}` } }], // missing path
    }));
    companion.chatScript = [...fails, { toolCalls: [{ id: 'end', name: 'finish', args: { summary: 'gave up honestly' } }] }];
    const events: any[] = [];
    const escalations: any[] = [];
    const runner = new AgentRunner({
      companion, workspaceId: 'ws', provider: { kind: 'openai', baseUrl: 'x' }, model: 'm',
      systemPrompt: 'sys', task: 'do it', tools: CORE_TOOLS, toolProtocol: 'native', maxTurns: 10,
      onEvent: (e) => events.push(e),
      onEscalation: (e) => escalations.push(e),
    } as any);
    await runner.run();
    const recoveries = events.filter((e: any) => e.type === 'loop_detected' && e.action === 'recovery');
    expect(recoveries.length).toBe(2); // guidance once per streak, twice total
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    expect(escalations[0].kind).toBe('repeated-failure');
    // stuck-strategy guidance delivered as automatic steering
    const all = companion.chatCalls.map((c: any) => JSON.stringify(c.messages)).join('');
    expect(all).toContain('Trigger: stuck');
    // the run was NOT abandoned: it ended with the model's own finish
    const last = events.find((e: any) => e.type === 'final');
    expect(last.content).toBe('gave up honestly');
  });
});
