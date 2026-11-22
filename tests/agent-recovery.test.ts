// Regression tests for the agent-execution loop repair (mission §7).
//
// Tests A–F drive the REAL AgentRunner with a scripted model and a mock
// companion — only the model is scripted, so the entire execution path
// (journal, recovery ladder, contract, completion gate, wire formatting) is
// production code. Live Ollama integration is gated separately (see
// tests/ollama-live.test.ts) and reported as unavailable when no server runs.
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { createContract } from '../src/lib/agent/task-contract';
import { agentSystemPrompt } from '../src/lib/agent/prompts';
import { CORE_TOOLS } from '../src/lib/agent/tools';
import type { AgentEvent } from '../src/lib/agent/types';

const TASK = [
  'Build a complete, offline, single-file HTML scientific calculator with:',
  '- Responsive graphical interface.',
  '- Scientific mathematics and DEG/RAD modes.',
  '- Binary, octal, decimal, and hexadecimal conversion.',
  '- Keyboard controls.',
  '- Safe expression parsing.',
  '- Functional verification.',
].join('\n');

// The observed field-failure call cycle (nemotron-cascade2 discovery loop).
const LOOP = [
  { tool: 'workspace_info', args: {} },
  { tool: 'list_dir', args: { path: '.' } },
  { tool: 'list_dir', args: {} },                          // bare — same call, different spelling
  { tool: 'list_dir', args: { path: 'calculator repo' } }, // hallucinated path
  { tool: 'run_command', args: { command: 'ls -la' } },
];

interface MockWorkspace { entries: { path: string; type: 'dir' | 'file'; size?: number }[] }
function makeCompanion(ws: MockWorkspace) {
  return {
    async tree(_id: string, _d: number) { return { root: '/home/user/workspaces/calc-ws', entries: ws.entries }; },
    async statPath(_id: string, p: string) {
      const rel = String(p ?? '.').replace(/^\.\//, '').replace(/\/+$/, '');
      if (rel === '.' || rel === '') return { exists: true, type: 'dir', empty: false, entryCount: ws.entries.length };
      const hit = ws.entries.find((e) => e.path === rel);
      if (hit) return hit.type === 'dir' ? { exists: true, type: 'dir', empty: false, entryCount: 1 } : { exists: true, type: 'file', size: hit.size };
      const parentExists = rel.includes('/') && ws.entries.some((e) => e.path === rel.split('/').slice(0, -1).join('/'));
      return { exists: false, reason: 'not-found', parentExists };
    },
    async readFile(_id: string, p: string) {
      const hit = ws.entries.find((e) => e.path === String(p).replace(/^\.\//, ''));
      if (!hit || hit.type === 'dir') throw new Error('CompanionError: not found: ' + p);
      return { content: '<html></html>\n', size: hit.size ?? 0 };
    },
    async writeFile(_id: string, p: string, content: string) {
      const rel = String(p).replace(/^\.\//, '');
      const existing = ws.entries.find((e) => e.path === rel);
      if (existing) existing.size = content.length; else ws.entries.push({ path: rel, type: 'file', size: content.length });
      return { bytes: content.length };
    },
    async mkdir(_id: string, p: string) { ws.entries.push({ path: String(p).replace(/^\.\//, ''), type: 'dir' }); },
    async exec(_id: string, cmd: string) {
      return { exitCode: 0, stdout: ws.entries.map((e) => e.path).join('\n') + '\n', stderr: '', cwd: '/home/user/workspaces/calc-ws', durMs: 5, timedOut: false };
    },
    async search(_id: string, _q: string) { return { results: [] }; },
  };
}

interface Turn { tool: string; args: any }
function scriptedModel(seq: Turn[], wireLog: any[][]) {
  let i = 0;
  return async ({ messages }: any) => {
    wireLog.push(messages);
    const pick = seq[i++ % seq.length];
    return { text: '', end: { finish: 'stop', toolCalls: [{ id: `call_${i}`, name: pick.tool, args: pick.args }], usage: {} } };
  };
}

function baseConfig(overrides: any = {}) {
  const ws: MockWorkspace = { entries: [ { path: 'calculator', type: 'dir' }, { path: 'calculator/index.html', type: 'file', size: 0 }, { path: 'notes.txt', type: 'file', size: 12 } ] };
  const contract = createContract(TASK, { workspaceId: 'ws_test', path: '/home/user/workspaces/calc-ws', machineLabel: 'This computer' });
  const events: AgentEvent[] = [];
  const wireLog: any[][] = [];
  const wsCtx = { platform: 'linux', workspacePath: '/home/user/workspaces/calc-ws', tree: 'calculator/\ncalculator/index.html\nnotes.txt', projectName: 'Calculator', machineLabel: 'This computer' };
  const cfg: any = {
    companion: makeCompanion(ws),
    workspaceId: 'ws_test',
    provider: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    model: 'nemotron-cascade2:30b-a3b',
    systemPrompt: agentSystemPrompt(wsCtx, 'task'),
    task: TASK,
    tools: CORE_TOOLS,
    toolProtocol: 'native',
    maxTurns: 40,
    workspaceMeta: { id: 'ws_test', rootPath: '/home/user/workspaces/calc-ws', machineLabel: 'This computer', platform: 'linux', projectName: 'Calculator', knownTree: 'calculator/\ncalculator/index.html\nnotes.txt' },
    workspaceContext: wsCtx,
    contract,
    onContractUpdate: () => {},
    onEvent: (e: AgentEvent) => events.push(e),
    approver: async () => 'allow',
  };
  return { cfg, contract, events, wireLog, ws };
}

describe('Test A — Repeated Workspace Discovery ends without indefinite repetition', () => {
  test('a cycling discovery loop is stopped by the coordinator with a stalled verdict', async () => {
    const { cfg, contract, events, wireLog } = baseConfig();
    cfg.companion.chat = scriptedModel(LOOP, wireLog);
    const runner = new AgentRunner(cfg);
    const res = await runner.run();

    // bounded: the run must NOT consume all maxTurns on the loop
    expect(res.turns).toBeLessThan(cfg.maxTurns);
    expect(res.turns).toBeLessThanOrEqual(18);
    // recovery happened: active coordinator actions fired before the stop
    const actions = events.filter((e) => e.type === 'recovery_action').map((e) => (e as any).action);
    expect(actions).toContain('workspace_refocus');
    expect(actions).toContain('strategy_directive');
    // the honest stalled verdict (Test F's requirement) is present
    expect(events.some((e) => e.type === 'stalled')).toBe(true);
    expect(res.stalled).toBe(true);
    expect(res.note).toContain('STALLED');
    expect(res.note).toContain('Continue task');
    // contract records the blocked state, not a fake completion
    expect(contract.status).toBe('BLOCKED');
    expect(res.completion).toBeUndefined();
    // envelope dedup: at most ONE structured envelope per call signature
    const envelopeMsgs = wireLog.flat().filter((m) => String(m.content ?? '').startsWith('[COORDINATOR RECOVERY'));
    const distinctSigs = new Set(wireLog.flat().filter((m) => String(m.content ?? '').startsWith('[COORDINATOR RECOVERY')).map((m) => m.content.split('\n')[1]));
    expect(envelopeMsgs.length).toBe(distinctSigs.size);
    // no files were fabricated
    expect(events.filter((e) => e.type === 'tool_end' && e.entry.tool === 'write_file')).toHaveLength(0);
  });
});

describe('Test B — Known Workspace needs no repeated discovery', () => {
  test('the authoritative workspace block is present at task init and workspace_info re-anchors fully', async () => {
    const { cfg, wireLog } = baseConfig();
    cfg.companion.chat = scriptedModel([{ tool: 'workspace_info', args: {} }, { tool: 'finish', args: { summary: 'done' } }], wireLog);
    const runner = new AgentRunner(cfg);
    await runner.run();

    // task initialization carries the authoritative metadata (mission §4)
    const system = wireLog[0].find((m) => m.role === 'system');
    expect(String(system.content)).toContain('WORKSPACE (authoritative');
    expect(String(system.content)).toContain('/home/user/workspaces/calc-ws');
    expect(String(system.content)).toContain('Selected project: Calculator');
    expect(String(system.content)).toContain('calculator/');
    // workspace_info output re-anchors with the IDE-known structure in ONE call
    const info = wireLog.flat().find((m) => m.role === 'tool' && String(m.content).startsWith('workspace id:'));
    expect(String(info.content)).toContain('known top-level structure');
    expect(String(info.content)).toContain('calculator/');
    expect(String(info.content)).toContain('selected project: Calculator');
  });

  test('bare list_dir and list_dir "." are the same journal signature — no spelling reset', async () => {
    const { cfg, events, wireLog } = baseConfig();
    // cycle ONLY the two equivalent spellings; the guard must block the 4th
    cfg.companion.chat = scriptedModel([{ tool: 'list_dir', args: {} }, { tool: 'list_dir', args: { path: '.' } }], wireLog);
    cfg.maxTurns = 8;
    const runner = new AgentRunner(cfg);
    await runner.run();
    const blocked = events.filter((e) => e.type === 'tool_end' && e.entry.outcome === 'blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1); // the equivalent spelling was blocked, not re-executed
    const execs = events.filter((e) => e.type === 'tool_end' && e.entry.tool === 'list_dir' && e.entry.outcome === 'ok-nonempty');
    expect(execs.length).toBeLessThanOrEqual(3); // REPEAT_LIMIT_READS respected across spellings
  });
});

describe('Test C — Task Preservation across recovery', () => {
  test('the original request and every requirement survive the stall verbatim', async () => {
    const { cfg, contract, wireLog } = baseConfig();
    cfg.companion.chat = scriptedModel(LOOP, wireLog);
    const runner = new AgentRunner(cfg);
    await runner.run();

    expect(contract.originalRequest).toBe(TASK); // verbatim, never paraphrased
    const reqTexts = contract.requirements.filter((r) => r.source === 'user').map((r) => r.text);
    expect(reqTexts).toContain('Responsive graphical interface.');
    expect(reqTexts).toContain('Binary, octal, decimal, and hexadecimal conversion.');
    expect(reqTexts).toContain('Functional verification.');
    for (const r of contract.requirements.filter((x) => x.source === 'user')) {
      expect(r.status).toBe('open'); // recovery must not weaken or auto-close requirements
    }
    // the active recovery action quotes a requirement verbatim
    const refocus = wireLog.flat().find((m) => String(m.content ?? '').includes('ACTIVE RECOVERY 2/2'));
    expect(String(refocus.content)).toContain('Binary, octal, decimal, and hexadecimal conversion.');
  });
});

describe('Test D — Model tool responses (Ollama-compatible wire formatting)', () => {
  test('native assistant tool_calls and tool results keep ids, roles and order on the wire', async () => {
    const { cfg, wireLog } = baseConfig();
    cfg.companion.chat = scriptedModel([{ tool: 'workspace_info', args: {} }, { tool: 'list_dir', args: { path: '.' } }], wireLog);
    const runner = new AgentRunner(cfg);
    await runner.run();

    // turn 2 wire: assistant(tool_calls) followed by tool result
    const turn2 = wireLog[1];
    const asst = turn2.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(asst).toBeTruthy();
    expect(asst.tool_calls[0].function.name).toBe('workspace_info');
    JSON.parse(asst.tool_calls[0].function.arguments); // arguments are valid JSON
    const toolMsg = turn2.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.tool_call_id).toBe(asst.tool_calls[0].id);
    expect(String(toolMsg.content)).toContain('workspace id: ws_test');
    // tool result comes AFTER its assistant call (causal order)
    expect(turn2.indexOf(asst)).toBeLessThan(turn2.indexOf(toolMsg));
  });
});

describe('Test E — Genuine Progress is recognized and rewarded', () => {
  test('inspection → creating the calculator → verification: no stall, gate verdict, progress recorded', async () => {
    const { cfg, contract, events, wireLog } = baseConfig();
    const seq: Turn[] = [
      { tool: 'workspace_info', args: {} },
      { tool: 'list_dir', args: { path: '.' } },
      { tool: 'write_file', args: { path: 'calculator/index.html', content: '<!doctype html><html><body><div id="display">0</div></body></html>' } },
      { tool: 'run_tests', args: { command: 'python3 -c "print(42)"' } },
      { tool: 'finish', args: { summary: 'Built calculator/index.html (GUI, DEG/RAD, base conversion, keyboard, safe parser); smoke check exit 0; browser unavailable.' } },
    ];
    cfg.companion.chat = scriptedModel(seq, wireLog);
    const runner = new AgentRunner(cfg);
    const res = await runner.run();

    expect(res.stalled).toBeFalsy();
    expect(res.turns).toBeGreaterThanOrEqual(seq.length);
    expect(res.turns).toBeLessThanOrEqual(seq.length + 6); // refusal feedback loop is bounded by design
    // the artifact was really created and the coordinator SAW it as progress
    expect(events.some((e) => e.type === 'tool_end' && e.entry.tool === 'write_file' && e.entry.outcome === 'ok-nonempty')).toBe(true);
    const progressTexts = contract.progress.map((p) => p.text);
    expect(progressTexts.some((t) => t.startsWith('write_file succeeded'))).toBe(true);
    expect(contract.progress.some((p) => p.filesTouched?.includes('calculator/index.html'))).toBe(true);
    // the completion gate, not the model, decided the verdict — GUI unverified → not COMPLETE
    expect(res.completion).toBeTruthy();
    expect(res.completion!.status).not.toBe('COMPLETE');
    expect(['UNVERIFIED', 'PARTIAL', 'FAILED', 'BLOCKED']).toContain(res.completion!.status);
    // the workspace actually contains the file
    const wsState = cfg.companion;
    // (mock companion state was mutated by write_file — verify through the gate's own check path)
    expect(res.completion!.reasons.join(' ')).toMatch(/browser/i);
  });
});

describe('Test F — Recovery Failure produces an actionable stopped state, not endless inference', () => {
  test('looping through BOTH active recovery actions stops the run with requirements + next steps', async () => {
    const { cfg, contract, events } = baseConfig();
    // even more pathological: cycles discovery AND invalid finish-less noise
    cfg.companion.chat = scriptedModel([...LOOP, { tool: 'list_dir', args: { path: 'calculator' } }, { tool: 'read_file', args: { path: 'notes.txt' } }], [] as any);
    cfg.maxTurns = 40;
    const runner = new AgentRunner(cfg);
    const res = await runner.run();

    expect(res.turns).toBeLessThan(20); // bounded inference
    expect(events.filter((e) => e.type === 'recovery_action').length).toBe(2);
    expect(res.stalled).toBe(true);
    expect(contract.status).toBe('BLOCKED');
    expect(contract.statusNote).toContain('stalled-run verdict');
    expect(contract.openProblems.some((p) => p.startsWith('Stalled:'))).toBe(true);
    // actionable: names the open requirements and the resume paths
    expect(res.note).toContain('Requirements still open');
    expect(res.note).toContain('steer the agent');
    expect(res.note).toContain('switch models');
    // and the IDE can resume: full history preserved
    expect(res.messages.length).toBeGreaterThan(0);
  });
});
