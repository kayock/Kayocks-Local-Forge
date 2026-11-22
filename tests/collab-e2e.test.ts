// Phase 2.1 — END-TO-END acceptance tests (Test C, D, E, G) through the exact
// graphical launch path.
//
// What makes this different from the orchestration unit tests: the tests call
// launchCollaborativeTask() — the SAME function the Collaborate tab's "Start"
// button calls — against THREE REAL companion processes over real HTTP, with
// REAL mesh pairing between them, real stub model servers streaming SSE
// tool-call deltas (the full Phase 1.5 assembly pipeline), and a REAL
// filesystem workspace on the authoritative host.
//
// Verification level: INTEGRATION (real processes; one physical host —
// physical three-machine verification remains the owner's checklist).
// Run: bun test tests/collab-e2e.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// localStorage shim BEFORE any store import (zustand persist in bun)
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const ROOT = path.resolve(import.meta.dir, '..');
const COMPANION = path.join(ROOT, 'companion');

const PORT_A = 7501, PORT_B = 7502, PORT_C = 7503;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const BASE_C = `http://127.0.0.1:${PORT_C}`;
const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-e2e-a-'));
const HOME_B = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-e2e-b-'));
const HOME_C = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-e2e-c-'));
const WS_A = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-e2e-ws-'));

const companions: any[] = [];
const stubs: any[] = [];
let tokenA = '';
let wsIdA = '';
let peerB = ''; // real mesh peer id of the Windows Dell stand-in
let peerC = '';
let stubAUrl = '', stubBUrl = '', stubCUrl = '', stubC2Url = '';

async function startCompanion(port: number, home: string) {
  const proc = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--lan'], {
    cwd: COMPANION, env: { ...process.env, LOCALFORGE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  companions.push(proc);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return await r.json(); } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`companion ${port} did not start`);
}

async function startStub(port: number, script: any[]): Promise<string> {
  // returns url; the caller can verify freshness via /__script (requests=0)
  const proc = spawn(process.execPath, [path.join(COMPANION, 'test/fixtures/stub-model-server.mjs'), String(port), JSON.stringify(script)], { stdio: ['ignore', 'pipe', 'pipe'] });
  stubs.push(proc);
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/__script`); if (r.ok) return `http://127.0.0.1:${port}`; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stub model server ${port} did not start`);
}

async function api(base: string, token: string | null, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function stubScript(url: string) {
  return fetch(`${url}/__script`).then((r) => r.json());
}

let collab: typeof import('../src/lib/agent/collab-service');
let settings: typeof import('../src/lib/store/settings');

beforeAll(async () => {
  // dynamic imports AFTER the localStorage shim (zustand persist)
  settings = await import('../src/lib/store/settings');
  collab = await import('../src/lib/agent/collab-service');

  // port hygiene: previous crashed runs must not leave zombie listeners that
  // would serve STALE scripts (this made the first runs unreproducible).
  // fuser is not installed in this environment — pkill with bracket patterns
  // (which cannot match this test process's own command line).
  for (const pattern of ['stub-model-serve[r].mjs 818', 'serve[r].js --port 750', 'serve[r].js --port 818']) {
    Bun.spawnSync(['pkill', '-f', pattern]);
  }
  await new Promise((r) => setTimeout(r, 600));

  await startCompanion(PORT_A, HOME_A);
  await startCompanion(PORT_B, HOME_B);
  await startCompanion(PORT_C, HOME_C);

  // pair all to their own consoles (trusted-device mechanism)
  for (const [base, home, set] of [[BASE_A, HOME_A, (t: string) => (tokenA = t)], [BASE_B, HOME_B, () => {}], [BASE_C, HOME_C, () => {}]] as const) {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    const r = await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'e2e' }) });
    const j = await r.json();
    expect(j.token).toBeTruthy();
    set(j.token);
    if (home === HOME_B) (globalThis as any).__tokenB = j.token;
    if (home === HOME_C) (globalThis as any).__tokenC = j.token;
  }

  // authoritative workspace on node A — a REAL directory
  const w = await api(BASE_A, tokenA, 'POST', '/api/workspaces', { path: WS_A, name: 'shared-project' });
  wsIdA = w.json.workspace.id;
  await fsp.writeFile(path.join(WS_A, 'app.py'), 'greeting = "hi"\n');
  await fsp.writeFile(path.join(WS_A, 'README.md'), 'shared project\n');

  // scripted model servers
  const verifyFresh = async (url: string) => {
    const meta: any = await fetch(`${url}/__script`).then((r) => r.json());
    if (!Array.isArray(meta.requests) || meta.requests.length !== 0) {
      throw new Error(`stub at ${url} is a STALE process (requests=${JSON.stringify(meta.requests)?.slice?.(0, 40)}) — port hygiene failed`);
    }
  };
  stubAUrl = await startStub(8181, [
    { toolCalls: [{ id: 'p1', name: 'finish', args: { summary: 'PLAN:\n1. Fix greeting in app.py\n2. Verify with a command' } }] },
    { toolCalls: [{ id: 'r1', name: 'finish', args: { summary: 'VERDICT: APPROVE — greeting fixed and verified' } }] },
  ]);
  stubBUrl = await startStub(8182, [
    { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'app.py', find: '"hi"', replace: '"hello"' } }] },
    { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'edited app.py greeting' } }] },
  ]);
  stubCUrl = await startStub(8183, [
    { toolCalls: [{ id: 't1', name: 'run_command', args: { command: `node -e "require('fs').writeFileSync('exec-proof.txt', 'tests-ok')"` } }] },
    { toolCalls: [{ id: 't2', name: 'finish', args: { summary: 'Ran the verification command on the workspace host — output tests-ok' } }] },
    { toolCalls: [{ id: 'd1', name: 'edit_file', args: { path: 'app.py', find: 'greeting', replace: 'GREETING' } }] },
    { toolCalls: [{ id: 'd2', name: 'finish', args: { summary: 'debugger fixed it while running on portable' } }] },
  ]);
  stubC2Url = await startStub(8184, [
    { toolCalls: [{ id: 't1', name: 'finish', args: { summary: 'no-op test report (fresh stub for the failure scenario)' } }] },
    { toolCalls: [{ id: 'd1', name: 'edit_file', args: { path: 'app.py', find: 'greeting', replace: 'GREETING' } }] },
    { toolCalls: [{ id: 'd2', name: 'finish', args: { summary: 'debugger fixed it while running on portable' } }] },
  ]);
  await Promise.all([verifyFresh(stubAUrl), verifyFresh(stubBUrl), verifyFresh(stubCUrl), verifyFresh(stubC2Url)]);

  // mesh: pair Dell + Portable stand-ins to the Station (real pairing codes)
  const stateB = JSON.parse(fs.readFileSync(path.join(HOME_B, 'state.json'), 'utf8'));
  const stateC = JSON.parse(fs.readFileSync(path.join(HOME_C, 'state.json'), 'utf8'));
  const cb = await api(BASE_A, tokenA, 'POST', '/api/mesh/connect', { url: BASE_B, name: 'Windows Dell', code: stateB.pairingCode });
  expect(cb.status).toBe(200);
  peerB = cb.json.peer.id;
  const cc = await api(BASE_A, tokenA, 'POST', '/api/mesh/connect', { url: BASE_C, name: 'Ubuntu Portable', code: stateC.pairingCode });
  expect(cc.status).toBe(200);
  peerC = cc.json.peer.id;

  // point the IDE settings store (the same config the UI uses) at node A
  settings.useSettings.setState((s: any) => ({
    companion: { ...s.companion, mode: 'direct', directUrl: BASE_A, token: tokenA },
  }));
});

afterAll(async () => { /* hook timeout raised: companion shutdown + rm can exceed bun's 5s default */
  for (const p of [...companions, ...stubs]) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [HOME_A, HOME_B, HOME_C, WS_A]) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
}, 20000);

function makeConfig(stubB: string, stubC: string) {
  return {
    objective: 'Fix the greeting in app.py and verify it works',
    workspaceHostPeerId: null,
    workspaceHostMachineName: 'Ubuntu Station',
    executionMode: 'sequential' as const,
    autoSteering: true,
    maxTurnsPerStage: 10,
    participants: [
      { machineId: 'local', machineName: 'Ubuntu Station', baseUrl: stubAUrl, model: 'planner-model', roles: ['planner', 'reviewer'] as any[] },
      { machineId: peerB, machineName: 'Windows Dell', baseUrl: stubB, model: 'qwen3-coder-30b', roles: ['coder'] as any[] },
      { machineId: peerC, machineName: 'Ubuntu Portable', baseUrl: stubC, model: 'tester-model', roles: ['tester'] as any[] },
    ],
  };
}

describe('E2E: collaborative task launched through the graphical path (Tests C, D, E)', () => {
  test('start button → real Coordinator → three real companions → real tools on the authoritative workspace', async () => {
    // manual steering queued BEFORE the run through the coordinator control API
    // (the UI delivers exactly this call) — it must reach the planner's model
    const launch = await collab.launchCollaborativeTask(makeConfig(stubBUrl, stubCUrl) as any, {
      mesh: new (await import('../src/lib/mesh/client')).MeshClient(() => settings.useSettings.getState().companion),
      workspaceHost: new (await import('../src/lib/companion/client')).CompanionClient(() => settings.useSettings.getState().companion),
      workspaceId: wsIdA,
      workspacePath: WS_A,
      workspaceContext: { platform: 'linux', workspacePath: WS_A },
      approver: async () => 'allow',
      onEvent: () => {},
    });

    // Test E (steering): queued steering reaches the planner's model conversation
    launch.coordinator.steerAgent('planner-0', 'Focus on minimal changes only.');
    const report = await launch.done;

    // Test C: all four stages ran on the assigned machines
    const stages = Object.fromEntries(report.results.map((r) => [r.stage, r]));
    expect(stages.planner.machine).toBe('Ubuntu Station');
    expect(stages.coder.machine).toBe('Windows Dell');
    expect(stages.tester.machine).toBe('Ubuntu Portable');
    expect(stages.reviewer.machine).toBe('Ubuntu Station');
    expect(report.verdict).toBe('APPROVE');

    // Test D: the coder's edit landed in the AUTHORITATIVE workspace (node A's
    // real filesystem) — not on the coder's machine
    expect(fs.readFileSync(path.join(WS_A, 'app.py'), 'utf8')).toBe('greeting = "hello"\n');

    // remote tool execution proof: the tester's run_command executed on node A
    expect(fs.existsSync(path.join(WS_A, 'exec-proof.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(WS_A, 'exec-proof.txt'), 'utf8')).toBe('tests-ok');

    // Test E: the steering instruction was delivered to the PLANNER's model
    // conversation (request #1 of stub A), not just to any later stage
    const a = await stubScript(stubAUrl);
    const plannerReq = a.requests[0];
    expect(plannerReq.system).toContain('PLANNER');
    const first = JSON.stringify(plannerReq.messages);
    expect(first).toContain('[USER STEERING]');
    expect(first).toContain('Focus on minimal changes only.');

    // agent memory: notebook handoffs + durable assignments on the workspace host
    const nb = await api(BASE_A, tokenA, 'GET', `/api/agents/${wsIdA}/notebook`);
    expect(nb.json.entries.length).toBeGreaterThanOrEqual(4);
    expect(nb.json.entries.some((e: any) => e.content.includes('Windows Dell'))).toBe(true);
    const asg = await api(BASE_A, tokenA, 'GET', `/api/agents/${wsIdA}/assignments`);
    expect(asg.json.assignments.length).toBeGreaterThanOrEqual(4);
    expect(asg.json.assignments.some((x: any) => x.machine === 'Windows Dell' && x.status === 'done')).toBe(true);

    // every agent scratchpad persisted
    const pad = await api(BASE_A, tokenA, 'GET', `/api/agents/${wsIdA}/scratchpad/coder-1`);
    expect(pad.json.progress).toBe('done');
  }, 120000);
});

describe('E2E: worker failure handling + reassignment through the launch object (Test G)', () => {
  test('a failing worker is identified, work is preserved, and reassignment completes the task', async () => {
    // Dell's model server now FAILS every request
    const launch = await collab.launchCollaborativeTask(makeConfig(stubBUrl.replace('8182', '9999'), stubC2Url) as any, {
      mesh: new (await import('../src/lib/mesh/client')).MeshClient(() => settings.useSettings.getState().companion),
      workspaceHost: new (await import('../src/lib/companion/client')).CompanionClient(() => settings.useSettings.getState().companion),
      workspaceId: wsIdA,
      workspacePath: WS_A,
      workspaceContext: { platform: 'linux', workspacePath: WS_A },
      approver: async () => 'allow',
      onEvent: () => {},
    });
    // NOTE: stubBUrl points to port 9999 (nothing listening) — the coder's
    // model is unreachable, simulating a worker going down mid-task.
    const report = await launch.done;
    const coder = report.results.find((r) => r.stage === 'coder')!;
    // the coordinator surfaces the REAL failure explanation, not a bare placeholder
    expect(coder.summary).toContain('Model error:');
    expect(coder.summary).toContain('9999');
    // the workspace was NOT corrupted by the failed coder
    expect(fs.readFileSync(path.join(WS_A, 'app.py'), 'utf8')).toBe('greeting = "hello"\n');

    // reassignment through the SAME launch object (the UI's Reassign control)
    const res = await launch.coordinator.reassign('coder', {
      machineId: peerC, machineName: 'Ubuntu Portable',
      provider: { kind: 'openai', baseUrl: stubC2Url }, model: 'tester-model',
    }, 'The model server on Windows Dell became unreachable (connection refused).');
    expect(res.summary).toContain('portable');
    // the debugger ran on portable and edited the AUTHORITATIVE workspace
    expect(fs.readFileSync(path.join(WS_A, 'app.py'), 'utf8')).toBe('GREETING = "hello"\n');
    const asg = await api(BASE_A, tokenA, 'GET', `/api/agents/${wsIdA}/assignments`);
    expect(asg.json.assignments.some((x: any) => x.role === 'debugger' && x.machine === 'Ubuntu Portable')).toBe(true);
  }, 120000);
});
