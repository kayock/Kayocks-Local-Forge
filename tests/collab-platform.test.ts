// Phase 2.2 — Tests B, C, D, E, F: workspace-host routing, per-agent protocol
// and turn limits, reassignment configuration — through launchCollaborativeTask
// (the exact function the Collaborate tab's Start button calls).
//
// HONEST EMULATION LABEL: the "Windows" machine is a REAL Linux companion
// process reporting platform 'win32' via the documented LF_REPORT_PLATFORM
// diagnostic seam — real processes, real HTTP, real mesh pairing, real
// filesystem effects; the OS identity is emulated.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ROOT = path.resolve(import.meta.dir, '..');
const COMPANION = path.join(ROOT, 'companion');

const PORT_A = 7551, PORT_B = 7552, PORT_C = 7553;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const BASE_C = `http://127.0.0.1:${PORT_C}`;
const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cp-a-'));
const HOME_B = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cp-b-'));
const HOME_C = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cp-c-'));
const WS_B = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cp-wsb-')); // the "Windows" project

const companions: any[] = [];
const stubs: any[] = [];
let tokenA = '', tokenB = '', tokenC = '';
let peerB = '', peerC = '';
let stubAUrl = '', stubBUrl = '', stubCUrl = '', stubB2Url = '';

async function startCompanion(port: number, home: string, extraEnv: Record<string, string> = {}) {
  const proc = spawn(process.execPath, ['src/server.js', '--port', String(port), '--home', home, '--lan'], {
    cwd: COMPANION, env: { ...process.env, LOCALFORGE_HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  companions.push(proc);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return await r.json(); } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`companion ${port} did not start`);
}

async function startStub(port: number, script: any[]): Promise<string> {
  const proc = spawn(process.execPath, [path.join(COMPANION, 'test/fixtures/stub-model-server.mjs'), String(port), JSON.stringify(script)], { stdio: ['ignore', 'pipe', 'pipe'] });
  stubs.push(proc);
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/__script`); if (r.ok) return `http://127.0.0.1:${port}`; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stub ${port} did not start`);
}

async function api(base: string, token: string | null, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const stubMeta = (url: string) => fetch(`${url}/__script`).then((r) => r.json());

// 25 no-op turns to exercise a 20-turn limit
const noopTurn = { toolCalls: [{ id: 'n', name: 'run_command', args: { command: 'true' } }] };
const LIMIT_SCRIPT = Array.from({ length: 25 }, () => noopTurn);

let collab: typeof import('../src/lib/agent/collab-service');
let settings: typeof import('../src/lib/store/settings');

beforeAll(async () => {
  settings = await import('../src/lib/store/settings');
  collab = await import('../src/lib/agent/collab-service');
  const { MeshClient } = await import('../src/lib/mesh/client');
  const { CompanionClient } = await import('../src/lib/companion/client');
  (globalThis as any).__clients = { MeshClient };

  for (const port of [PORT_A, PORT_B, PORT_C, 8281, 8282, 8283, 8284]) {
    Bun.spawnSync(['pkill', '-f', `stub-model-serve[r].mjs ${port}`]).exitCode;
    Bun.spawnSync(['pkill', '-f', `serve[r].js --port ${port}`]).exitCode;
  }
  await new Promise((r) => setTimeout(r, 600));

  // node B REPORTS win32 via the documented diagnostic seam (honest emulation)
  await startCompanion(PORT_A, HOME_A);
  await startCompanion(PORT_B, HOME_B, { LF_REPORT_PLATFORM: 'win32' });
  await startCompanion(PORT_C, HOME_C);

  for (const [base, home, set] of [
    [BASE_A, HOME_A, (t: string) => (tokenA = t)],
    [BASE_B, HOME_B, (t: string) => (tokenB = t)],
    [BASE_C, HOME_C, (t: string) => (tokenC = t)],
  ] as const) {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    const j = await (await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'cp' }) })).json();
    expect(j.token).toBeTruthy();
    set(j.token);
  }

  // the "Windows" project — a real directory authorized on node B
  const w = await api(BASE_B, tokenB, 'POST', '/api/workspaces', { path: WS_B, name: 'windows-project' });
  (globalThis as any).__wsB = w.json.workspace;
  await fsp.writeFile(path.join(WS_B, 'app.py'), 'value = "hi"\n');

  stubAUrl = await startStub(8281, [
    { toolCalls: [{ id: 'p1', name: 'finish', args: { summary: 'PLAN for the windows project' } }] },
    { toolCalls: [{ id: 'r1', name: 'finish', args: { summary: 'VERDICT: APPROVE — windows workspace verified' } }] },
  ]);
  stubBUrl = await startStub(8282, [
    { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'app.py', find: '"hi"', replace: '"hello"' } }] },
    { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'edited the windows project file' } }] },
  ]);
  // tester runs in TEXT protocol: bare-JSON actions in the reply, NO tools sent
  stubCUrl = await startStub(8283, [
    { text: '{"tool": "run_command", "args": {"command": "node -e \\"require(\'fs\').writeFileSync(\'text-proof.txt\', \'text-protocol-ran\')\\""}}' },
    { text: '{"tool": "finish", "args": {"summary": "text-protocol tester verified the windows workspace"}}' },
  ]);
  stubB2Url = await startStub(8284, [...LIMIT_SCRIPT,
    { toolCalls: [{ id: 'k1', name: 'edit_file', args: { path: 'app.py', find: 'value', replace: 'VALUE' } }] },
    { toolCalls: [{ id: 'k2', name: 'finish', args: { summary: 'continuation completed the coder work' } }] },
    { text: '{"tool": "finish", "args": {"summary": "debugger (text protocol) completed the reassigned work"}}' },
  ]);

  const cb = await api(BASE_A, tokenA, 'POST', '/api/mesh/connect', { url: BASE_B, name: 'Windows Dell', code: JSON.parse(fs.readFileSync(path.join(HOME_B, 'state.json'), 'utf8')).pairingCode });
  expect(cb.status).toBe(200);
  peerB = cb.json.peer.id;
  const cc = await api(BASE_A, tokenA, 'POST', '/api/mesh/connect', { url: BASE_C, name: 'Ubuntu Portable', code: JSON.parse(fs.readFileSync(path.join(HOME_C, 'state.json'), 'utf8')).pairingCode });
  expect(cc.status).toBe(200);
  peerC = cc.json.peer.id;

  settings.useSettings.setState((s: any) => ({ companion: { ...s.companion, mode: 'direct', directUrl: BASE_A, token: tokenA } }));
}, 60000);

afterAll(async () => { /* hook timeout raised: companion shutdown + rm can exceed bun's 5s default */
  for (const p of [...companions, ...stubs]) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [HOME_A, HOME_B, HOME_C, WS_B]) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
}, 20000);

function makeConfig(overrides: Partial<Record<'planner' | 'coder' | 'tester', Partial<import('../src/lib/agent/collab-service').CollabParticipant>>> = {}) {
  const participants = [
    { machineId: 'local', machineName: 'Ubuntu Station', baseUrl: stubAUrl, model: 'planner-model', roles: ['planner', 'reviewer'] as any[], toolProtocol: 'native' as const },
    { machineId: peerB, machineName: 'Windows Dell', baseUrl: stubBUrl, model: 'qwen3-coder', roles: ['coder'] as any[], toolProtocol: 'native' as const },
    { machineId: peerC, machineName: 'Ubuntu Portable', baseUrl: stubCUrl, model: 'tester-model', roles: ['tester'] as any[], toolProtocol: 'text' as const },
  ];
  for (const [role, patch] of Object.entries(overrides)) {
    const p = participants.find((x) => x.roles.includes(role as any));
    if (p) Object.assign(p, patch);
  }
  return { objective: 'Fix the value in app.py of the authoritative project and verify it', participants, executionMode: 'sequential' as const, autoSteering: true };
}

async function launch(cfg: any, wsPlatform: string) {
  const { MeshClient, CompanionClient } = (globalThis as any).__clients;
  return collab.launchCollaborativeTask(cfg, {
    mesh: new MeshClient(() => settings.useSettings.getState().companion),
    workspaceHost: collab.clientForMachine(peerB),
    workspaceId: (globalThis as any).__wsB.id,
    workspacePath: WS_B,
    workspaceContext: { platform: wsPlatform, workspacePath: WS_B },
    approver: async () => 'allow',
    onEvent: () => {},
  });
}

describe('Phase 2.2: workspace-host routing + per-agent configuration (Tests B–F)', () => {
  test('OS detection reports the host platform through the same path the UI uses', async () => {
    const client = collab.clientForMachine(peerB);
    const h = await client.health();
    expect(h.platform).toBe('win32');
    const mesh = new (globalThis as any).__clients.MeshClient(() => settings.useSettings.getState().companion);
    const hw = await mesh.hardware(peerB);
    expect(hw.platform).toBe('win32');
  });

  test('Windows-hosted project: win32 context, tools execute on the Windows host, worker local files untouched (Test B + D)', async () => {
    // fetch the platform exactly like CollaborateTab does
    const hostClient = collab.clientForMachine(peerB);
    const h = await hostClient.health();
    const launch1 = await launch(makeConfig(), h.platform);

    const report = await launch1.done;
    const stages = Object.fromEntries(report.results.map((r) => [r.stage, r]));
    expect(stages.coder.machine).toBe('Windows Dell');
    expect(stages.tester.machine).toBe('Ubuntu Portable');

    // the PLANNER (running on Linux!) was told the workspace is win32 — the
    // workspace context describes the WORKSPACE host, not the agent's machine
    const a = await stubMeta(stubAUrl);
    expect(a.requests[0].system).toContain('Platform: win32');
    expect(a.requests[0].system).toContain(WS_B.slice(0, 20));

    // per-agent protocol evidence: coder NATIVE (tools sent), tester TEXT (no tools)
    const coderMeta = await stubMeta(stubBUrl);
    expect(coderMeta.requests[0].hasTools).toBe(true);
    const testerMeta = await stubMeta(stubCUrl);
    expect(testerMeta.requests[0].hasTools).toBe(false);

    // both protocols executed tools against the authoritative workspace:
    // native edit_file by the coder...
    expect(fs.readFileSync(path.join(WS_B, 'app.py'), 'utf8')).toBe('value = "hello"\n');
    // ...and the text-protocol run_command by the tester
    expect(fs.readFileSync(path.join(WS_B, 'text-proof.txt'), 'utf8')).toBe('text-protocol-ran');

    // no unintended writes on the tester's machine
    const cEntries = fs.existsSync(HOME_C) ? fs.readdirSync(HOME_C) : [];
    expect(cEntries.filter((f) => f.includes('proof'))).toEqual([]);
  }, 120000);

  test('turn limits are independent (20 vs default) and continuation works (Test E)', async () => {
    const launch2 = await launch(makeConfig({ coder: { baseUrl: stubB2Url, maxTurns: 20, toolProtocol: 'native' }, tester: { maxTurns: 100 } }), 'win32');
    const report = await launch2.done;
    const coder = report.results.find((r) => r.stage === 'coder')!;
    expect(coder.turns).toBe(20);            // stopped EXACTLY at its own limit
    expect(coder.hitTurnLimit).toBe(true);
    const tester = report.results.find((r) => r.stage === 'tester')!;
    expect(tester.hitTurnLimit).toBe(false); // 100-turn allowance, 2-turn job

    // Continue Task: same machine/model, fresh allowance, prior progress seeded
    const cont = await launch2.coordinator.continueStage('coder');
    expect(cont).not.toBeNull();
    expect(cont!.summary).toContain('continuation completed the coder work');
    expect(fs.readFileSync(path.join(WS_B, 'app.py'), 'utf8')).toBe('VALUE = "hello"\n');
    const b2 = await stubMeta(stubB2Url);
    // continuation ran on the coder's machine with ITS native protocol
    expect(b2.requests[25].hasTools).toBe(true);
  }, 180000);

  test('reassignment gives the replacement agent its OWN provider/model/protocol/turns (Test F)', async () => {
    // coder model unreachable → stage fails → reassign to a text-protocol agent
    const launch3 = await launch(makeConfig({ coder: { baseUrl: 'http://127.0.0.1:9999', maxTurns: 20 } }), 'win32');
    const report = await launch3.done;
    const coder = report.results.find((r) => r.stage === 'coder')!;
    expect(coder.summary).toContain('Model error:');

    const res = await launch3.coordinator.reassign('coder', {
      machineId: peerC, machineName: 'Ubuntu Portable',
      provider: { kind: 'openai', baseUrl: stubB2Url }, model: 'reviewer-model',
      toolProtocol: 'text', maxTurns: 7,
    }, coder.summary);
    expect(res.summary).toContain('text protocol');
    // the replacement used ITS OWN text protocol (no tools in the request)
    const b2 = await stubMeta(stubB2Url);
    expect(b2.requests[b2.requests.length - 1].hasTools).toBe(false);
    expect(b2.requests[b2.requests.length - 1].system).toContain('Platform: win32');
  }, 180000);
});
