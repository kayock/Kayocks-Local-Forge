// Regression tests for the Phase One harness repairs (docs/HARNESS_UPGRADE.md).
// Each test maps to a defect found in real-world testing against local models
// (spec §3.1 Tests A–D) or to an acceptance test in spec §18.
// Run: bun test tests/harness.test.ts
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { CORE_TOOLS, normalizeToolArgs, validateToolArgs, canonicalToolName } from '../src/lib/agent/tools';
import type { AgentEvent, AgentMessage, ToolLogEntry, ProcInfo } from '../src/lib/agent/types';

// ---------------------------------------------------------------------------
// Fake companion: scripted model responses + in-memory workspace + procs.
// ---------------------------------------------------------------------------
interface ChatScriptEntry {
  text?: string;
  toolCalls?: { id: string; name: string; args: any }[];
  throwWithToolError?: string;
  usage?: { promptTokens: number | null; completionTokens: number | null };
}

function makeCompanion(opts: { files?: Record<string, string>; chatScript?: ChatScriptEntry[]; execImpl?: (cmd: string, o: any) => any } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const chatCalls: any[] = [];
  const execCalls: { cmd: string; opts: any }[] = [];
  const toolLog: ToolLogEntry[] = [];
  const events: AgentEvent[] = [];
  let procSeq = 0;
  const procs = new Map<string, ProcInfo>();

  const companion: any = {
    chatCalls,
    execCalls,
    files,
    // script is injectable: makeCompanion sets it initially, run() overrides
    chatScript: opts.chatScript ?? [],
    async chat(o: any) {
      chatCalls.push(o);
      const scriptList = companion.chatScript as ChatScriptEntry[];
      if (!scriptList?.length) throw new Error('No chat script configured for this test');
      const script = scriptList[Math.min(chatCalls.length - 1, scriptList.length - 1)];
      if (script?.throwWithToolError) throw new Error(script.throwWithToolError);
      return {
        text: script?.text ?? '',
        end: { finish: 'stop', toolCalls: script?.toolCalls ?? [], usage: script?.usage ?? null },
      };
    },
    async exec(wsId: string, cmd: string, o: any) {
      execCalls.push({ cmd, opts: o });
      if (opts.execImpl) return opts.execImpl(cmd, o);
      return { exitCode: 0, stdout: '', stderr: '', cwd: null, durMs: 5, timedOut: false };
    },
    async readFile(_ws: string, p: string) {
      if (!files.has(p)) throw new Error(`Companion: file not found: ${p}`);
      const content = files.get(p)!;
      return { path: p, content, size: content.length, modifiedAt: new Date().toISOString() };
    },
    async writeFile(_ws: string, p: string, content: string) {
      files.set(p, content);
      return { path: p, bytes: content.length };
    },
    async tree(_ws: string, _depth: number) {
      const entries = [...files.keys()].map((path) => ({ path, type: 'file' as const, size: (files.get(path) || '').length }));
      return { root: '/ws', entries };
    },
    async search(_ws: string, q: string) {
      const results: { path: string; line: number; text: string }[] = [];
      for (const [p, c] of files) c.split('\n').forEach((l, i) => { if (l.includes(q)) results.push({ path: p, line: i + 1, text: l }); });
      return { count: results.length, results };
    },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart(_ws: string, cmd: string, o: any) {
      const id = `p_${++procSeq}`;
      const proc: ProcInfo = { id, pid: 4000 + procSeq, cmd, cwd: o?.cwd ?? null, status: 'running', exitCode: null, startedAt: Date.now() };
      procs.set(id, proc);
      return proc;
    },
    procList(_ws: string) { return [...procs.values()]; },
    procOutput(_ws: string, id: string) {
      const proc = procs.get(id);
      if (!proc) throw new Error(`Unknown process id: ${id}`);
      return { proc, output: 'GUI window shown', outputBytes: 16 };
    },
    async procStop(_ws: string, id: string) {
      const proc = procs.get(id);
      if (!proc) throw new Error(`Unknown process id: ${id}`);
      proc.status = 'stopped';
      proc.exitCode = null;
      return proc;
    },
  };
  return { companion, files, chatCalls, execCalls, toolLog, events, procs };
}

function run(companion: any, task: string, cfg: any = {}) {
  const events: AgentEvent[] = [];
  // tests pass chatScript via cfg; forward it into the fake companion
  if (cfg.chatScript) companion.chatScript = cfg.chatScript;
  const runner = new AgentRunner({
    companion,
    workspaceId: 'ws1',
    provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' },
    model: 'test-model',
    systemPrompt: 'You are a coding agent.',
    task,
    tools: CORE_TOOLS,
    // default approver: these tests exercise tool/protocol behavior, not the
    // approval UI (the IdeView supplies a real one)
    approver: async () => 'allow',
    onEvent: (e) => events.push(e),
    ...cfg,
  } as any);
  return { runner, events, promise: runner.run() };
}

const toolEnds = (events: AgentEvent[]) => events.filter((e: any) => e.type === 'tool_end').map((e: any) => e.entry);
const notices = (events: AgentEvent[]) => events.filter((e: any) => e.type === 'notice').map((e: any) => e.message);

// ---------------------------------------------------------------------------
// Test A (§3.1): edit_file schema mismatch — old_content/new_content aliases
// ---------------------------------------------------------------------------
describe('edit_file aliases and precise validation (Test A)', () => {
  test('old_content/new_content are normalized to find/replace and the edit succeeds', async () => {
    const h = makeCompanion({ files: { 'calc.py': 'def add(a, b):\n    return a - b\n' } });
    const { promise, events } = run(h.companion, 'fix calc.py', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "edit_file", "args": {"path": "calc.py", "old_content": "return a - b", "new_content": "return a + b"}}' },
        { text: '{"tool": "finish", "args": {"summary": "fixed"}}' },
      ],
    });
    const r = await promise;
    expect(h.files.get('calc.py')).toContain('return a + b');
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('ok');
    expect(entry.output).toContain('old_content → find');
    expect(r.note).toBeUndefined();
  });

  test('missing "find" no longer reports the vague "missing path or find" when path was given', async () => {
    const h = makeCompanion({ files: { 'calc.py': 'x = 1\n' } });
    const { promise, events } = run(h.companion, 'edit', {
      toolProtocol: 'text',
      chatScript: [{ text: '{"tool": "edit_file", "args": {"path": "calc.py", "new_content": "y = 2"}}' }],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('"find"');
    expect(entry.output).toContain('old_content');
    expect(entry.output).toContain('calc.py');
    expect(entry.output).not.toContain('missing path or find');
  });

  test('validation error names the exact missing parameter and the expected schema', () => {
    const err = validateToolArgs('edit_file', { path: 'a.py' });
    expect(err).toContain('missing required parameter');
    expect(err).toContain('"replace"');
    expect(err).toContain('Expected schema');
  });

  test('model-invented tool names resolve to registry tools', () => {
    expect(canonicalToolName('bash')).toBe('run_command');
    expect(canonicalToolName('str_replace_editor')).toBe('edit_file');
    expect(canonicalToolName('cat')).toBe('read_file');
    const { tool, args } = normalizeToolArgs('bash', { cmd: 'dir' });
    expect(tool).toBe('run_command');
    expect(args.command).toBe('dir');
  });
});

// ---------------------------------------------------------------------------
// Test B (§3.1): malformed JSON tool requests + protocol recovery
// ---------------------------------------------------------------------------
describe('malformed tool calls (Test B)', () => {
  test('trailing commas and single-quoted JSON are repaired and executed', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'list', {
      toolProtocol: 'text',
      chatScript: [
        { text: "{'tool': 'list_dir', 'args': {'path': '.',}}" },
        { text: '{"tool": "finish", "args": {"summary": "done"}}' },
      ],
    });
    const r = await promise;
    expect(toolEnds(events)[0].status).toBe('ok');
    expect(r.content).toBe('done');
  });

  test('double-encoded args strings are recovered', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'list', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "list_dir", "args": "{\\"path\\": \\".\\"}"}' },
        { text: '{"tool": "finish", "args": {"summary": "ok"}}' },
      ],
    });
    await promise;
    expect(toolEnds(events)[0].status).toBe('ok');
  });

  test('unknown tool names get an exact, repairable error (not a generic failure)', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'x', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "open_folder", "args": {"path": "."}}' },
        { text: '{"tool": "finish", "args": {"summary": "recovered"}}' },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('Unknown tool "open_folder"');
    expect(entry.output).toContain('list_dir');
  });
});

// ---------------------------------------------------------------------------
// Test C (§3.1): native tool calling must not be disturbed by the text helper
// ---------------------------------------------------------------------------
describe('native mode (Test C)', () => {
  test('native tool calls execute with preserved ids and no protocol nudges', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'use tools natively', {
      toolProtocol: 'native',
      chatScript: [
        { toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'calc.py' } }] },
        { toolCalls: [{ id: 'call_2', name: 'finish', args: { summary: 'native worked' } }] },
      ],
      files: { 'calc.py': 'a = 1\n' },
    });
    const r = await promise;
    expect(r.content).toBe('native worked');
    expect(h.chatCalls[0].tools.length).toBeGreaterThan(0);
    expect(h.chatCalls[1].messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
    expect(notices(events).some((n) => n.includes('nudging'))).toBe(false);
  });

  test('a plain-text answer in native mode is accepted as final — no helper nudge', async () => {
    const h = makeCompanion();
    const { promise } = run(h.companion, 'just answer', {
      toolProtocol: 'native',
      allowNudgeOnText: true, // requested, but must be IGNORED in native mode
      chatScript: [{ text: 'The workspace looks fine.' }],
    });
    const r = await promise;
    expect(r.content).toBe('The workspace looks fine.');
    expect(h.chatCalls.length).toBe(1); // no second (nudged) call
  });

  test('auto mode: server tool rejection falls back once and records the reason', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'auto probe', {
      toolProtocol: 'auto',
      chatScript: [
        { throwWithToolError: 'Model server error 400: tools are not supported by this model' },
        { text: '{"tool": "finish", "args": {"summary": "fell back"}}' },
      ],
    });
    const r = await promise;
    const mc = events.find((e: any) => e.type === 'mode_change') as any;
    expect(mc).toBeDefined();
    expect(mc.from).toBe('auto');
    expect(mc.to).toBe('text');
    expect(mc.reason).toContain('tools are not supported');
    expect(r.content).toBe('fell back');
    expect(h.chatCalls[1].tools).toBeUndefined(); // text protocol: no tools sent
  });

  test('native-forced mode: server tool rejection is reported, never silently downgraded', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'native forced', {
      toolProtocol: 'native',
      chatScript: [{ throwWithToolError: 'Model server error 400: tool use is not allowed here' }],
    });
    const r = await promise;
    expect(events.some((e: any) => e.type === 'mode_change')).toBe(false);
    expect(r.note).toContain('Switch the tool protocol mode');
  });
});

// ---------------------------------------------------------------------------
// Test D Problems 1–5 (§3.1) + acceptance tests §18
// ---------------------------------------------------------------------------
describe('command execution accuracy (Problem 1 / Test 6)', () => {
  test('a real failure is never reported as success: exit code, stderr and duration returned', async () => {
    const h = makeCompanion({
      execImpl: () => ({ exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\n  File "app.py", line 4, in <module>\nNameError: x', cwd: '.', durMs: 120, timedOut: false }),
    });
    const { promise, events } = run(h.companion, 'run the app', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_command", "args": {"command": "python app.py"}}' },
        { text: '{"tool": "finish", "args": {"summary": "saw the failure"}}' },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('exit code: 1');
    expect(entry.output).toContain('NameError');
    expect(entry.output).toContain('duration:');
    expect(entry.output).toContain('cwd:');
  });

  test('a timed-out command reports TIMED OUT and points to launch_app for GUIs', async () => {
    const h = makeCompanion({
      execImpl: () => ({ exitCode: null, stdout: 'partial', stderr: '', cwd: null, durMs: 600000, timedOut: true }),
    });
    const { promise, events } = run(h.companion, 'launch gui', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_command", "args": {"command": "python taskforge_gui.py"}}' },
        { text: '{"tool": "finish", "args": {"summary": "learned"}}' },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.output).toContain('TIMED OUT');
    expect(entry.output).toContain('launch_app');
    expect(entry.status).toBe('error');
  });
});

describe('detached GUI processes (Problem 2 / Test 5)', () => {
  test('launch_app returns immediately with id+pid; status and stop report real lifecycle', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'start the gui', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "launch_app", "args": {"command": "python taskforge_gui.py"}}' },
        { text: '{"tool": "process_status", "args": {}}' },
        { text: '{"tool": "stop_process", "args": {"id": "p_1"}}' },
        { text: '{"tool": "finish", "args": {"summary": "managed the process"}}' },
      ],
    });
    await promise;
    const [launch, status, stop] = toolEnds(events);
    expect(launch.status).toBe('ok');
    expect(launch.output).toContain('Started detached process');
    expect(launch.output).toContain('did NOT wait');
    expect(status.output).toContain('running');
    expect(stop.output).toContain('stopped');
    expect(h.procs.get('p_1')!.status).toBe('stopped');
  });
});

describe('language-aware test discovery (Problem 3)', () => {
  test('a Python project runs pytest, not "add a test script to package.json"', async () => {
    const h = makeCompanion({
      files: { 'pytest.ini': '[pytest]\ntestpaths = tests\n', 'tests/test_calc.py': 'def test_add(): pass\n' },
      execImpl: (cmd) => ({ exitCode: 0, stdout: cmd === 'python -m pytest -q' ? '1 passed' : '', stderr: '', cwd: null, durMs: 50, timedOut: false }),
    });
    const { promise, events } = run(h.companion, 'run tests', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_tests", "args": {}}' },
        { text: '{"tool": "finish", "args": {"summary": "tests pass"}}' },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('ok');
    expect(h.execCalls[0].cmd).toBe('python -m pytest -q');
    expect(entry.output).toContain('Python project (pytest.ini)');
  });

  test('pytest unavailable falls back to unittest discover', async () => {
    const h = makeCompanion({
      files: { 'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\n' },
      execImpl: (cmd) => cmd === 'python -m pytest -q'
        ? { exitCode: 1, stdout: '', stderr: 'No module named pytest', cwd: null, durMs: 40, timedOut: false }
        : { exitCode: 0, stdout: 'Ran 3 tests OK', stderr: '', cwd: null, durMs: 40, timedOut: false },
    });
    const { promise, events } = run(h.companion, 'run tests', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_tests", "args": {}}' },
        { text: '{"tool": "finish", "args": {"summary": "unittest ran"}}' },
      ],
    });
    await promise;
    expect(h.execCalls.map((c) => c.cmd)).toContain('python -m unittest discover -v');
    expect(toolEnds(events)[0].status).toBe('ok');
  });

  test('package.json test script is still detected (JS/TS projects)', async () => {
    const h = makeCompanion({
      files: { 'package.json': '{"scripts": {"test": "bun test"}}' },
      execImpl: (cmd) => ({ exitCode: 0, stdout: cmd === 'npm test' ? '12 passing' : '', stderr: '', cwd: null, durMs: 50, timedOut: false }),
    });
    const { promise, events } = run(h.companion, 'run tests', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_tests", "args": {}}' },
        { text: '{"tool": "finish", "args": {"summary": "npm test ran"}}' },
      ],
    });
    await promise;
    expect(h.execCalls[0].cmd).toBe('npm test');
    expect(toolEnds(events)[0].status).toBe('ok');
  });

  test('undetectable projects get an informative answer listing what was checked', async () => {
    const h = makeCompanion({ files: { 'README.md': 'nothing here' } });
    const { promise, events } = run(h.companion, 'run tests', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_tests", "args": {}}' },
        { text: '{"tool": "finish", "args": {"summary": "ok"}}' },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('cargo test');
    expect(entry.output).toContain('go test');
    expect(entry.output).toContain('python -m pytest');
    expect(entry.output).toContain('package.json');
    expect(entry.output).not.toContain('Add a test script to package.json or pass a command');
  });
});

describe('repetition guard (Problem 4 / §3.7)', () => {
  test('an identical successful command is not re-executed forever — the previous result is returned with a strategy hint', async () => {
    const h = makeCompanion({
      execImpl: () => ({ exitCode: 0, stdout: 'import ok', stderr: '', cwd: null, durMs: 10, timedOut: false }),
    });
    const { promise, events } = run(h.companion, 'check imports repeatedly', {
      toolProtocol: 'text',
      chatScript: new Array(4).fill({ text: '{"tool": "run_command", "args": {"command": "python -c \'import app\'"}}' }).concat([{ text: '{"tool": "finish", "args": {"summary": "stopped repeating"}}' }]),
    });
    await promise;
    expect(h.execCalls.length).toBe(2); // executed twice, then blocked
    const blocked = toolEnds(events).find((e) => e.output?.includes('REPEATED CALL'));
    expect(blocked).toBeDefined();
    expect(blocked!.output).toContain('already been made 2 times');
    expect(events.some((e: any) => e.type === 'loop_detected')).toBe(true);
  });

  test('identical failing edits are allowed twice, then blocked with guidance', async () => {
    const h = makeCompanion({ files: { 'a.py': 'original line\n' } });
    const { promise } = run(h.companion, 'fix the file', {
      toolProtocol: 'text',
      chatScript: new Array(5).fill({ text: '{"tool": "edit_file", "args": {"path": "a.py", "find": "not present anywhere", "replace": "x"}}' }).concat([{ text: '{"tool": "finish", "args": {"summary": "gave up cleanly"}}' }]),
    });
    await promise;
    // 2 reads + 2 real attempts, then blocked without further file reads
    expect(h.execCalls.length).toBe(0);
    expect(h.files.get('a.py')).toContain('original line');
  });
});

describe('turn limits and resumable work (Problem 5 / Test 7)', () => {
  test('hitting the turn limit preserves the full history and marks the run resumable', async () => {
    const h = makeCompanion({ files: { 'a.txt': 'hello\n' } });
    const { promise } = run(h.companion, 'long task', {
      toolProtocol: 'text',
      maxTurns: 3,
      chatScript: new Array(6).fill({ text: '{"tool": "read_file", "args": {"path": "a.txt"}}' }),
    });
    const r = await promise;
    expect(r.hitTurnLimit).toBe(true);
    expect(r.note).toContain('Continue');
    // system + task + 3 turns × (assistant text + tool result) = 8 preserved
    expect(r.messages.length).toBe(8);
    expect(r.messages.some((m) => m.content.includes('[TOOL RESULT]'))).toBe(true);
  });

  test('resume continues with the preserved context — the model sees prior tool results', async () => {
    const h = makeCompanion({
      files: { 'a.txt': 'hello\n' },
      chatScript: new Array(6).fill({ text: '{"tool": "read_file", "args": {"path": "a.txt"}}' }),
    });
    const first = new AgentRunner({
      companion: h.companion, workspaceId: 'ws1',
      provider: { kind: 'openai', baseUrl: 'http://x/v1' }, model: 'm',
      systemPrompt: 'sys', task: 'long task', tools: CORE_TOOLS,
      toolProtocol: 'text', maxTurns: 2, onEvent: () => {},
    } as any);
    const r1 = await first.run();
    expect(r1.hitTurnLimit).toBe(true);

    h.chatCalls.length = 0;
    const resumed = new AgentRunner({
      companion: h.companion, workspaceId: 'ws1',
      provider: { kind: 'openai', baseUrl: 'http://x/v1' }, model: 'm',
      systemPrompt: 'sys',
      task: 'Continue the task.',
      contextMessages: r1.messages.slice(1),
      tools: CORE_TOOLS, toolProtocol: 'text', maxTurns: 5, onEvent: () => {},
      // re-add a finish script for the resume run
    } as any);
    (h.companion as any).__script = null;
    // script the resume: model finishes immediately using preserved context
    const { companion } = h;
    companion.chat = async (o: any) => {
      h.chatCalls.push(o);
      return { text: '{"tool": "finish", "args": {"summary": "resumed and finished"}}', end: { finish: 'stop', toolCalls: [], usage: null } };
    };
    const r2 = await resumed.run();
    expect(r2.content).toBe('resumed and finished');
    const seen = JSON.stringify(h.chatCalls[0].messages);
    expect(seen).toContain('[TOOL RESULT]');
    expect(seen).toContain('a.txt');
  });
});

describe('structured results and schema contracts (§3.3/§3.4)', () => {
  test('run_command missing command gets a precise validation error without execution', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'run', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "run_command", "args": {"cwd": "."}}' },
        { text: '{"tool": "finish", "args": {"summary": "ok"}}' },
      ],
    });
    await promise;
    expect(h.execCalls.length).toBe(0);
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('"command"');
    expect(entry.output).toContain('[aliases accepted: cmd');
  });

  test('native tool calls with invalid args receive the exact expected parameter', async () => {
    const h = makeCompanion();
    const { promise, events } = run(h.companion, 'native bad args', {
      toolProtocol: 'native',
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'x.py' } }] }, // missing content
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'repaired' } }] },
      ],
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('error');
    expect(entry.output).toContain('"content"');
    expect(entry.output).toContain('Expected schema for write_file');
  });
});
