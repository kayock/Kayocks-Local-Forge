// Forge Control & Agent Reliability Upgrade — regression tests (Part 7).
// Tests 1–7 reproduce the calculator failures and verify the fixes:
//   1 repeated directory listing      → coordinator recovery, no infinite loop
//   2 nested workspace                → resolver reports/flattens the nested root
//   3 model handoff                   → replacement model gets the ORIGINAL requirements
//   4 false completion                → gate refuses COMPLETE without evidence
//   5 interrupted run                 → resume with workspace/requirements/progress intact
//   6 browser verification            → real evidence captured, or honest UNVERIFIED
//   7 multi-machine attribution       → correct host/workspace attribution (MOCKED here;
//                                       real integration lives in companion/test/*.mjs)
// Run: bun test tests/forge.test.ts
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { CORE_TOOLS } from '../src/lib/agent/tools';
import { detectToolDialect } from '../src/lib/agent/dialects';
import { runDrills, type DrillHost } from '../src/lib/agent/drills';
import { createContract, buildHandoffPacket, contractPromptBlock, addSteering, recordProgress } from '../src/lib/agent/task-contract';
import { evaluateCompletion } from '../src/lib/agent/completion';
import { extractArchive, statPath } from '../companion/src/fsapi.js';
import type { AgentEvent, ToolLogEntry } from '../src/lib/agent/types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Mock companion (MOCKED — in-memory workspace; mirrors the real companion's
// REST contract including the new /stat and /extract endpoints).
// ---------------------------------------------------------------------------
interface ScriptEntry { text?: string; toolCalls?: { id: string; name: string; args: any }[] }

function makeCompanion(opts: {
  files?: Record<string, string>;
  chatScript?: ScriptEntry[];
  execImpl?: (cmd: string) => { exitCode: number; stdout: string; stderr: string };
  browser?: 'available' | 'unavailable';
  statFiles?: Set<string>; // paths that "exist" for /stat beyond files
} = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const chatCalls: any[] = [];
  const execCalls: { cmd: string }[] = [];
  const events: AgentEvent[] = [];
  let browserVerified = false;

  const companion: any = {
    chatCalls,
    execCalls,
    files,
    chatScript: opts.chatScript ?? [],
    async chat(o: any) {
      chatCalls.push(o);
      const s = companion.chatScript[Math.min(chatCalls.length - 1, companion.chatScript.length - 1)];
      return { text: s?.text ?? '', end: { finish: 'stop', toolCalls: s?.toolCalls ?? [] } };
    },
    async exec(_ws: string, cmd: string) {
      execCalls.push({ cmd });
      const r = opts.execImpl ? opts.execImpl(cmd) : { exitCode: 0, stdout: '', stderr: '' };
      return { ...r, cwd: null, durMs: 5, timedOut: false };
    },
    async readFile(_ws: string, p: string) {
      if (!files.has(p)) throw new Error(`Companion: file not found: ${p}`);
      const content = files.get(p)!;
      return { path: p, content, size: content.length, modifiedAt: new Date().toISOString() };
    },
    async writeFile(_ws: string, p: string, content: string) { files.set(p, content); return { path: p, bytes: content.length }; },
    async tree(_ws: string, _d: number) {
      const entries = [...files.keys()].map((p) => ({ path: p, type: 'file' as const, size: (files.get(p) || '').length }));
      return { root: '/host/workspace-root', entries };
    },
    async search(_ws: string, q: string) {
      const results: any[] = [];
      for (const [p, c] of files) c.split('\n').forEach((l, i) => { if (l.includes(q)) results.push({ path: p, line: i + 1, text: l }); });
      return { count: results.length, results };
    },
    async mkdir() {}, async deletePath() {}, async rename() {},
    // Forge /stat contract: directories implied by file paths "exist and are
    // non-empty"; everything else is missing with a parentExists report.
    async statPath(_ws: string, p: string) {
      const rel = String(p || '.').replace(/^\.\//, '').replace(/\/+$/, '');
      if (rel === '.' || rel === '') return { path: rel, exists: true, type: 'dir', empty: files.size === 0 && !(opts.statFiles?.size), entryCount: files.size + (opts.statFiles?.size ?? 0) };
      if (files.has(rel)) return { path: rel, exists: true, type: 'file', size: (files.get(rel) || '').length };
      const hasChild = [...files.keys()].some((k) => k.startsWith(rel + '/'));
      if (hasChild || opts.statFiles?.has(rel)) return { path: rel, exists: true, type: 'dir', empty: !hasChild, entryCount: 0 };
      const top = rel.split('/')[0];
      const parentExists = top === rel ? true : [...files.keys()].some((k) => k.startsWith(top + '/')) || (opts.statFiles?.has(top) ?? false);
      return { path: rel, exists: false, parentExists, reason: 'not-found (parent exists)' };
    },
    // Forge /extract contract (mirrors fsapi.extractArchive semantics).
    async extractArchive(_ws: string, archivePath: string, o: any = {}) {
      if (!files.has(archivePath)) throw new Error(`Companion: file not found: ${archivePath}`);
      // the mock archive "calculator repo.zip" contains the nested project
      if (!archivePath.endsWith('.zip')) throw new Error('Unsupported archive type');
      const nestedRoot = 'calculator repo';
      const members = [`${nestedRoot}/main.py`, `${nestedRoot}/README.md`];
      let extracted = 0;
      for (const m of members) {
        const rel = o.flatten ? m.slice(nestedRoot.length + 1) : m;
        if (o.dest && o.dest !== '.') files.set(`${o.dest === '.' ? '' : o.dest + '/'}${rel}`, `// ${rel}`);
        else files.set(rel, `// ${rel}`);
        extracted++;
      }
      return {
        archive: archivePath, dest: o.dest ?? '.', extracted, skippedExisting: 0, bytes: 64,
        nestedRoot, flattened: !!o.flatten,
        note: nestedRoot ? (o.flatten ? 'flattened' : `nested root ${nestedRoot}/ kept`) : undefined,
        sample: members.slice(0, 5), totalEntries: members.length,
      };
    },
    // browser adapter surface (Part 6)
    async browserOpen(_ws: string, o: any) {
      if (opts.browser === 'unavailable') return { unavailable: 'No local browser found (Chrome, Edge, Chromium or Brave).' };
      return { ok: true, url: o?.url ?? 'about:blank', visible: !!o?.visible, browser: 'mock-browser' };
    },
    async browserNavigate(_ws: string, url: string) { return { ok: true, url, title: 'Calculator' }; },
    async browserEval(_ws: string, expression: string) { return { ok: true, value: expression.length, consoleErrors: [] }; },
    async browserVerify(_ws: string, o: any) {
      if (opts.browser === 'unavailable') return { unavailable: 'No local browser found (Chrome, Edge, Chromium or Brave).' };
      browserVerified = true;
      return {
        ok: true, url: o.url, title: 'Calculator',
        checks: (o.checks ?? []).map((c: any) => ({ check: c.selector ?? c.evaluate ?? '?', pass: true })),
        checksPassed: (o.checks ?? []).length, checksTotal: (o.checks ?? []).length,
        consoleErrors: [], verdict: 'BROWSER VERIFICATION PASSED', verifiedAt: new Date().toISOString(),
      };
    },
    async browserClose() { return { ok: true }; },
    async browserStatus() { return { running: opts.browser !== 'unavailable' }; },
  };
  return { companion, files, chatCalls, events, browserWasVerified: () => browserVerified };
}

function run(companion: any, task: string, cfg: any = {}) {
  const events: AgentEvent[] = [];
  if (cfg.chatScript) companion.chatScript = cfg.chatScript;
  const runner = new AgentRunner({
    companion,
    workspaceId: 'ws1',
    provider: { kind: 'openai', baseUrl: 'http://station:8080/v1' },
    model: cfg.model ?? 'test-model',
    systemPrompt: 'You are a coding agent.',
    task,
    tools: CORE_TOOLS,
    approver: async () => 'allow',
    onEvent: (e) => events.push(e),
    ...cfg,
  } as any);
  return { runner, events, promise: runner.run() };
}

const toolEnds = (events: AgentEvent[]) => events.filter((e: any) => e.type === 'tool_end').map((e: any) => e.entry);
const browserAdapter = (c: any) => ({
  open: (wsId: string, o: any) => c.browserOpen(wsId, o),
  navigate: (wsId: string, url: string) => c.browserNavigate(wsId, url),
  eval: (wsId: string, expression: string) => c.browserEval(wsId, expression),
  verify: (wsId: string, o: any) => c.browserVerify(wsId, o),
  close: (wsId: string) => c.browserClose(wsId),
  status: (wsId: string) => c.browserStatus(wsId),
});
const calcRequest = 'Build a graphical scientific calculator with a number base converter. It must open in a browser and evaluate expressions.';

// ---------------------------------------------------------------------------
// TEST 1 — Repeated directory listing (the calculator loop)
// ---------------------------------------------------------------------------
describe('Test 1: repeated directory listing → coordinator recovery', () => {
  test('identical list_dir calls are blocked, a coordinator recovery envelope is injected, steering is applied, and the run terminates', async () => {
    const h = makeCompanion(); // "calculator repo" does NOT exist
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 7; i++) script.push({ text: '{"tool": "list_dir", "args": {"path": "calculator repo"}}' });
    script.push({ text: '{"tool": "finish", "args": {"summary": "gave up honestly"}}' });
    // no contract here — this test exercises recovery, not the completion gate
    const { runner, events, promise } = run(h.companion, 'Investigate the calculator repo', {
      toolProtocol: 'text',
      chatScript: script,
      workspaceMeta: { id: 'ws1', rootPath: '/host/workspace-root', machineLabel: 'Station', platform: 'linux' },
    });
    const p = promise;
    runner.steer('Stop listing that path — the folder does not exist, check the root instead.');
    const r = await p;

    // repetition was detected and blocked, not re-executed forever
    const blocked = toolEnds(events).filter((e) => e.output?.includes('REPEATED CALL'));
    expect(blocked.length).toBeGreaterThan(0);
    expect(events.some((e: any) => e.type === 'loop_detected')).toBe(true);

    // MISSING is distinguished from EMPTY (Problem B feeds Problem A)
    const first = toolEnds(events)[0];
    expect(first.output).toContain('MISSING');
    expect(first.output).not.toContain('(empty directory');

    // coordinator recovery envelope with the REAL result (Problem A)
    expect(r.messages.some((m: any) => m.content?.includes('[COORDINATOR RECOVERY'))).toBe(true);
    expect(events.some((e: any) => e.type === 'stall_detected')).toBe(true);
    // the envelope quotes the actual tool result, it does not fabricate one
    const envelope = r.messages.find((m: any) => m.content?.includes('[COORDINATOR RECOVERY'));
    expect(envelope!.content).toContain('MISSING');

    // steering applied promptly at the next turn boundary, not lost
    expect(events.some((e: any) => e.type === 'steering_applied')).toBe(true);
    expect(r.messages.some((m: any) => m.content?.startsWith('[USER STEERING'))).toBe(true);

    // no infinite loop: run terminated via finish within the scripted turns
    expect(r.turns).toBeLessThanOrEqual(script.length);
    expect(r.content).toContain('gave up honestly');
  });

  test('a legitimate repeated operation (same command after a real file change) is NOT blocked', async () => {
    const h = makeCompanion({
      execImpl: (cmd) => ({ exitCode: 0, stdout: cmd.includes('v2') ? 'result v2' : 'result v1', stderr: '' }),
    });
    const { events, promise } = run(h.companion, 'write then verify twice', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "write_file", "args": {"path": "app.py", "content": "v1"}}' },
        { text: '{"tool": "run_command", "args": {"command": "python app.py"}}' },
        { text: '{"tool": "edit_file", "args": {"path": "app.py", "find": "v1", "replace": "v2"}}' },
        { text: '{"tool": "run_command", "args": {"command": "python app.py"}}' },
        { text: '{"tool": "finish", "args": {"summary": "verified after each change"}}' },
      ],
    });
    await promise;
    const blocked = toolEnds(events).filter((e) => e.output?.includes('REPEATED CALL'));
    // the second identical run_command is legitimate (workspace changed in
    // between) and must have executed — only zero blocks allowed here
    expect(blocked.length).toBe(0);
    expect(h.companion.execCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — Nested workspace (calculator repo/calculator repo/)
// ---------------------------------------------------------------------------
describe('Test 2: nested workspace resolution', () => {
  test('REAL fsapi: extract reports the nested project root; flatten strips it; existing files are never silently overwritten', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-nested-'));
    const ws = { path: tmp };
    // build a real nested zip with the store method (no compression) using bun's zlib
    const zip = buildStoreZip([['calculator repo/', ''], ['calculator repo/main.py', 'print(1)'], ['calculator repo/README.md', '# calc']]);
    fs.writeFileSync(path.join(tmp, 'calculator repo.zip'), zip);

    // as-is: nested root DETECTED and REPORTED
    const r1 = await extractArchive(ws, 'calculator repo.zip', { dest: '.' });
    expect(r1.nestedRoot).toBe('calculator repo');
    expect(r1.flattened).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'calculator repo/main.py'))).toBe(true);
    expect(r1.note).toContain('nested project root');

    // flatten:true strips it — explicit, not silent
    fs.mkdirSync(path.join(tmp, 'flat'));
    const r2 = await extractArchive(ws, 'calculator repo.zip', { dest: 'flat', flatten: true });
    expect(r2.flattened).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'flat/main.py'))).toBe(true);

    // no silent overwrite
    fs.writeFileSync(path.join(tmp, 'flat/main.py'), 'USER CONTENT');
    const r3 = await extractArchive(ws, 'calculator repo.zip', { dest: 'flat', flatten: true });
    expect(r3.skippedExisting).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(tmp, 'flat/main.py'), 'utf8')).toBe('USER CONTENT');

    // zip-slip is rejected
    const evil = buildStoreZip([['../escape.txt', 'x']]);
    fs.writeFileSync(path.join(tmp, 'evil.zip'), evil);
    let rejected = false;
    try { await extractArchive(ws, 'evil.zip', { dest: '.' }); } catch { rejected = true; }
    expect(rejected).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('statPath distinguishes empty from missing (the empty-listing trap)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-stat-'));
    const ws = { path: tmp };
    const missing = await statPath(ws, 'calculator repo');
    expect(missing.exists).toBe(false);
    expect(missing.parentExists).toBe(true);
    fs.mkdirSync(path.join(tmp, 'empty-dir'));
    const empty = await statPath(ws, 'empty-dir');
    expect(empty.exists).toBe(true);
    expect((empty as any).empty).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// TEST 3 — Model handoff
// ---------------------------------------------------------------------------
describe('Test 3: model handoff preserves the original assignment', () => {
  test('the replacement model receives the verbatim request, requirements and progress — not a generic summary', async () => {
    const contract = createContract(calcRequest, { workspaceId: 'ws1', path: '/host/workspace-root', machineLabel: 'Station' });
    let c: typeof contract = contract;
    c = recordProgress(c, 'Created calculator.py with basic arithmetic (CLI only)', 'coder:model-a');
    c = addSteering(c, 'The converter must support binary, octal and hex.');

    const packet = buildHandoffPacket(c, {
      fromModel: 'model-a', toModel: 'model-b',
      filesTouched: ['calculator.py'],
      testsRun: [{ command: 'python -m pytest -q', exitCode: 0, passed: true }],
      blockers: [],
      lastSuccessfulOperation: 'write_file calculator.py',
      remainingWork: contract.requirements.filter((r) => r.status === 'open').map((r) => r.text),
    });

    expect(packet).toContain('MODEL HANDOFF');
    expect(packet).toContain(calcRequest);            // verbatim, never paraphrased
    expect(packet).toContain('number base converter');
    expect(packet).toContain('binary, octal and hex'); // user steering preserved
    expect(packet).toContain('basic arithmetic');      // progress carried over
    expect(packet).toContain('pytest');                // tests already executed

    // runner-level: the replacement model actually RECEIVES the packet
    const h = makeCompanion();
    const { promise, runner } = run(h.companion, 'Continue the task.', {
      model: 'model-b',
      toolProtocol: 'text',
      chatScript: [{ text: '{"tool": "finish", "args": {"summary": "continuing"}}' }],
      contextMessages: [{ role: 'user', content: packet }],
      contract,
      maxTurns: 3,
    });
    await promise;
    const firstWire = h.companion.chatCalls[0].messages;
    const packetMsg = firstWire.find((m: any) => m.content?.includes('MODEL HANDOFF'));
    expect(packetMsg).toBeDefined();
    expect(packetMsg.content).toContain(calcRequest);
    // the contract block is also re-injected in the system prompt
    expect(firstWire[0].content).toContain('TASK CONTRACT');
    expect(firstWire[0].content).toContain(calcRequest);
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — False completion (the four-operation CLI "scientific calculator")
// ---------------------------------------------------------------------------
describe('Test 4: false completion is refused by the evidence gate', () => {
  test('finish without tests/browser evidence is refused; verdict is NOT COMPLETE', async () => {
    const h = makeCompanion({ files: {} });
    const contract = createContract(calcRequest, { workspaceId: 'ws1', path: '/host/workspace-root', machineLabel: 'Station' });
    const { events, promise } = run(h.companion, calcRequest, {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "write_file", "args": {"path": "calculator.py", "content": "print(eval(input()))"}}' },
        { text: '{"tool": "finish", "args": {"summary": "Created calculator.py — a fully working scientific calculator (done)."}}' },
        { text: '{"tool": "finish", "args": {"summary": "Created calculator.py — a fully working scientific calculator (done)."}}' },
      ],
      contract,
      maxTurns: 6,
    });
    const r = await promise;

    // gate refused the first finish and told the model exactly what is missing
    const gates = events.filter((e: any) => e.type === 'completion_gate');
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(gates[0] && (gates[0] as any).status).not.toBe('COMPLETE');
    expect((gates[0] as any).missing.join(' ')).toMatch(/No sufficient evidence|verification|Browser|browser/i);

    // the [COMPLETION GATE] refusal reached the conversation
    expect(r.messages.some((m: any) => m.content?.includes('[COMPLETION GATE'))).toBe(true);

    // final verdict: bounded acceptance, honest status
    expect(r.completion).toBeDefined();
    expect(r.completion!.status).not.toBe('COMPLETE');
    expect(['UNVERIFIED', 'PARTIAL', 'FAILED']).toContain(r.completion!.status);
    // the contract carries the honest status too
    expect(contract.status).not.toBe('COMPLETE');
    expect(contract.status).not.toBe('ACTIVE');
  });

  test('a GUI task with NO browser available is UNVERIFIED even when tests pass', async () => {
    const h = makeCompanion({ browser: 'unavailable' });
    const contract = createContract(calcRequest, { workspaceId: 'ws1', path: '/host/workspace-root', machineLabel: 'Station' });
    const { promise } = run(h.companion, calcRequest, {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "write_file", "args": {"path": "index.html", "content": "<h1>calc</h1>"}}' },
        { text: '{"tool": "browser_verify", "args": {"url": "http://127.0.0.1:8000/index.html"}}' },
        { text: '{"tool": "run_tests", "args": {}}' },
        { text: '{"tool": "finish", "args": {"summary": "index.html built and tests pass. Scientific calculator complete with number base converter GUI."}}' },
        { text: '{"tool": "finish", "args": {"summary": "index.html built and tests pass. Scientific calculator complete with number base converter GUI."}}' },
      ],
      contract,
      execImpl: () => ({ exitCode: 0, stdout: '1 passed', stderr: '' }),
      companionBrowser: browserAdapter(h.companion),
      maxTurns: 8,
    });
    const r = await promise;
    // the browser-unavailable report was honest, and the gate refused COMPLETE
    expect(r.completion!.status).not.toBe('COMPLETE');
    expect(r.completion!.status).toBe('UNVERIFIED');
    expect(r.completion!.reasons.join(' ')).toMatch(/browser/i);
  });

  test('a task WITH real evidence (files + passing tests + browser checks) reaches COMPLETE', async () => {
    const h = makeCompanion({ browser: 'available' });
    const contract = createContract('Build a web calculator page (GUI) that evaluates expressions; verified in a browser.', { workspaceId: 'ws1', path: '/host/workspace-root', machineLabel: 'Station' });
    const { promise, events } = run(h.companion, 'Build the calculator', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "write_file", "args": {"path": "index.html", "content": "<h1>calculator</h1>"}}' },
        { text: '{"tool": "run_tests", "args": {"command": "npm test"}}' },
        { text: '{"tool": "browser_verify", "args": {"url": "http://127.0.0.1:8000", "checks": [{"selector": "#display", "contains": "42"}]}}' },
        { text: '{"tool": "finish", "args": {"summary": "index.html written; web calculator GUI verified in browser with selector checks; tests pass."}}' },
      ],
      contract,
      execImpl: () => ({ exitCode: 0, stdout: '1 test passed\nexit code: 0', stderr: '' }),
      companionBrowser: browserAdapter(h.companion),
      maxTurns: 8,
    });
    const r = await promise;
    expect(r.completion!.status).toBe('COMPLETE');
    expect(contract.status).toBe('COMPLETE');
    expect(contract.evidence.some((e) => e.kind === 'browser-verified')).toBe(true);
    expect(h.browserWasVerified()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 5 — Interrupted run
// ---------------------------------------------------------------------------
describe('Test 5: interrupted run resumes with everything intact', () => {
  test('turn-limit pause preserves history; resume keeps requirements, progress and workspace', async () => {
    const h = makeCompanion();
    const contract = createContract(calcRequest, { workspaceId: 'ws1', path: '/host/workspace-root', machineLabel: 'Station' });
    const versionBefore = contract.version;
    const reqsBefore = JSON.stringify(contract.requirements.map((r) => [r.text, r.status, r.source]));

    const first = run(h.companion, calcRequest, {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "write_file", "args": {"path": "calculator.py", "content": "# basic"}}' },
        { text: '{"tool": "list_dir", "args": {"path": "."}}' },
      ],
      contract,
      maxTurns: 2,
    });
    const r1 = await first.promise;
    expect(r1.hitTurnLimit).toBe(true);
    expect(r1.messages.length).toBeGreaterThan(2);
    expect(contract.version).toBeGreaterThan(versionBefore); // progress recorded

    // interrupt = nothing else persisted; resume replays the SAME messages
    const second = run(h.companion, 'Continue.', {
      toolProtocol: 'text',
      chatScript: [{ text: '{"tool": "finish", "args": {"summary": "resumed"}}' }],
      contextMessages: r1.messages,
      contract,
      maxTurns: 4,
    });
    const r2 = await second.promise;
    // the resumed model sees the original task and the earlier tool results
    const wire = h.companion.chatCalls[h.companion.chatCalls.length - 1].messages;
    expect(wire.some((m: any) => m.content?.includes(calcRequest))).toBe(true);
    expect(wire.some((m: any) => m.content?.includes('[TOOL RESULT]') || m.content?.includes('Wrote calculator.py'))).toBe(true);
    // requirements untouched by the interruption
    expect(JSON.stringify(contract.requirements.map((r) => [r.text, r.status, r.source]))).toBe(reqsBefore);
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — Browser verification (mocked browser; real-machine path in
// companion/test/server.integration.test.mjs)
// ---------------------------------------------------------------------------
describe('Test 6: browser verification evidence (mocked browser session)', () => {
  test('browser_verify produces structured evidence and UNVERIFIED wording when unavailable', async () => {
    const hUnavail = makeCompanion({ browser: 'unavailable' });
    const { events, promise } = run(hUnavail.companion, 'verify page', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "browser_verify", "args": {"url": "http://127.0.0.1:8000/index.html"}}' },
        { text: '{"tool": "finish", "args": {"summary": "stopped"}}' },
      ],
      companionBrowser: browserAdapter(hUnavail.companion),
      maxTurns: 4,
    });
    await promise;
    const entry = toolEnds(events)[0];
    expect(entry.output).toContain('BROWSER UNAVAILABLE');
    expect(entry.output).toContain('UNVERIFIED');
    expect(entry.output).not.toMatch(/BROWSER VERIFICATION PASSED/i);
  });
});

// ---------------------------------------------------------------------------
// TEST 7 — Multi-machine operation (MOCKED attribution; real integration:
// companion/test/server.integration.test.mjs boots the actual server)
// ---------------------------------------------------------------------------
describe('Test 7: multi-machine attribution (MOCKED — real companion integration test exists separately)', () => {
  test('tool results are attributed to the machine that executed them', async () => {
    const hStation = makeCompanion();
    const hWindows = makeCompanion();
    const mk = (h: any, label: string) => run(h.companion, 'list files', {
      toolProtocol: 'text',
      chatScript: [
        { text: '{"tool": "workspace_info"}' },
        { text: '{"tool": "list_dir", "args": {"path": "."}}' },
        { text: '{"tool": "finish", "args": {"summary": "listed"}}' },
      ],
      workspaceMeta: { id: 'ws1', rootPath: label === 'Station' ? '/home/station/calc' : 'C:\\Users\\dell\\calc', machineLabel: label, platform: label === 'Station' ? 'linux' : 'win32' },
      maxTurns: 4,
    });
    const a = mk(hStation, 'Station');
    const b = mk(hWindows, 'Windows Dell');
    await a.promise;
    await b.promise;

    const aEntries = toolEnds(a.events);
    const bEntries = toolEnds(b.events);
    expect(aEntries.every((e) => e.machine === 'Station')).toBe(true);
    expect(bEntries.every((e) => e.machine === 'Windows Dell')).toBe(true);
    expect(aEntries[0].output).toContain('/home/station/calc');
    expect(bEntries[0].output).toContain('C:\\Users\\dell\\calc');
    expect(aEntries[0].output).toContain('machine: Station');
    expect(bEntries[0].output).toContain('machine: Windows Dell');
  });
});

// ---------------------------------------------------------------------------
// Part 2: dialect ladder (tagged + pythonic + native JSON)
// ---------------------------------------------------------------------------
describe('Part 2: tool-call dialect handling', () => {
  test('tagged <tool_call> dialect is parsed and executed', async () => {
    const h = makeCompanion();
    const { events, promise } = run(h.companion, 'tagged model', {
      toolProtocol: 'text',
      chatScript: [
        { text: '<think>ok</think>\n<tool_call>\n{"tool": "list_dir", "args": {"path": "."}}\n</tool_call>' },
        { text: '{"tool": "finish", "args": {"summary": "done"}}' },
      ],
      maxTurns: 4,
    });
    await promise;
    const kinds = toolEnds(events).map((e) => e.tool);
    expect(kinds).toContain('list_dir');
    expect(events.some((e: any) => e.type === 'dialect_learned')).toBe(true);
  });

  test('pythonic call syntax is parsed; conversational prose is NOT executed as a tool call', async () => {
    const a = detectToolDialect('list_dir(path=".")');
    expect(a?.dialect).toBe('py');
    expect(a?.action.tool).toBe('list_dir');
    const b = detectToolDialect('run_tests(command="npm test")');
    expect(b?.action.tool).toBe('run_tests');
    const c = detectToolDialect('I think the calculator should have a nice display. What do you think?');
    expect(c).toBeNull();
    const d = detectToolDialect('<tool_call>list_dir path="."</tool_call>');
    expect(d?.dialect).toBe('tagged');
    expect(d?.action.tool).toBe('list_dir');
  });
});

// ---------------------------------------------------------------------------
// Part 2: reliability drills (mock host — the real-companion drill runs via
// scripts/run-drills.ts against live hardware)
// ---------------------------------------------------------------------------
describe('Part 2: reliability drills (MOCKED host)', () => {
  test('all eight drills pass on a healthy host and the report records per-step evidence', async () => {
    const files = new Map<string, string>();
    const host: DrillHost = {
      label: 'mock-host',
      listDir: async (p) => {
        // top-level files PLUS implied intermediate directories (like a real tree)
        const dirs = new Set<string>();
        for (const k of files.keys()) {
          const parts = k.split('/');
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        const all: { path: string; type: 'file' | 'dir'; size?: number }[] = [
          ...[...files.keys()].map((k) => ({ path: k, type: 'file' as const, size: (files.get(k) || '').length })),
          ...[...dirs].map((d) => ({ path: d, type: 'dir' as const, size: undefined })),
        ];
        const rel = (!p || p === '.') ? '' : p.replace(/^\.\//, '').replace(/\/+$/, '');
        const prefix = rel ? rel + '/' : '';
        return all.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
          .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
      },
      readFile: async (p) => {
        if (!files.has(p)) throw new Error(`file not found: ${p}`);
        return { content: files.get(p)!, size: (files.get(p) || '').length };
      },
      writeFile: async (p, c) => { files.set(p, c); return { bytes: c.length }; },
      deletePath: async (p) => { for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k); },
      exec: async (cmd) => {
        if (/exit\(3\)|sys.exit\(3\)/.test(cmd)) return { exitCode: 3, stdout: '', stderr: '' };
        if (cmd.includes('pipeline.js')) return { exitCode: 0, stdout: 'pipeline-ok', stderr: '' };
        return { exitCode: 0, stdout: 'drill-ok-777', stderr: '' };
      },
      stat: async (p) => ({ exists: p === '.', reason: p === '.' ? undefined : 'not-found' }),
      search: async (q) => [...files.entries()].filter(([, c]) => c.includes(q)).flatMap(([p]) => [{ path: p, line: 1, text: q }]),
    };
    const report = await runDrills(host, { model: 'mock-model' });
    expect(report.passed).toBe(report.passed + report.failed); // sanity
    expect(report.failed).toBe(0);
    expect(report.score).toContain('drills passed');
    expect(report.steps.length).toBeGreaterThanOrEqual(8);
    expect(report.recommendation).toContain('reliably');
  });

  test('a host that lies about failing commands fails the error-recognition drill honestly', async () => {
    const host: DrillHost = {
      label: 'lying-host',
      listDir: async () => [],
      readFile: async () => { throw new Error('file not found'); },
      writeFile: async () => ({ bytes: 0 }),
      deletePath: async () => {},
      exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }), // lies: everything "succeeds"
    };
    const report = await runDrills(host);
    expect(report.failed).toBeGreaterThan(0);
    expect(report.recommendation).toContain('Fix first');
  });
});

// ---------------------------------------------------------------------------
// Problem D unit: the gate itself
// ---------------------------------------------------------------------------
describe('Problem D: completion gate decisions', () => {
  const contract = createContract(calcRequest, { workspaceId: 'ws1', path: '/x', machineLabel: 'Station' });

  test('nothing verified → UNVERIFIED, never COMPLETE', () => {
    const r = evaluateCompletion({ contract, filesCheck: [], testsRun: [], browserEvidence: 'untested', finishSummary: 'I am done!' });
    expect(r.status).toBe('UNVERIFIED');
  });

  test('failing test → FAILED even with a confident summary', () => {
    const r = evaluateCompletion({ contract, filesCheck: [{ path: 'calc.py', exists: true }], testsRun: [{ command: 'pytest', exitCode: 2, passed: false }], browserEvidence: 'untested', finishSummary: 'calc.py works, scientific calculator done' });
    expect(r.status).toBe('FAILED');
    expect(r.reasons.join(' ')).toContain('pytest');
  });

  test('user override is reported without altering records', () => {
    const c = createContract('task', { workspaceId: 'ws1', path: '/x', machineLabel: 'Station' });
    c.status = 'COMPLETE';
    c.statusNote = 'overridden by user';
    const r = evaluateCompletion({ contract: c, filesCheck: [], testsRun: [], browserEvidence: 'untested' });
    expect(r.status).toBe('COMPLETE');
    expect(r.overriddenByUser).toBe(true);
    expect(r.reasons[0]).toContain('overridden by the user');
  });
});

// ---------------------------------------------------------------------------
// helpers: minimal STORE-method zip writer (no compression) for tests
// ---------------------------------------------------------------------------
function buildStoreZip(members: [string, string][]): Buffer {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf: Buffer) => { let c = 0 ^ -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0; };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of members) {
    const nameBuf = Buffer.from(name);
    const dataBuf = Buffer.from(data, 'utf8');
    const crc = crc32(dataBuf);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(dataBuf.length, 18); l.writeUInt32LE(dataBuf.length, 22);
    l.writeUInt16LE(nameBuf.length, 26);
    locals.push(l, nameBuf, dataBuf);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(dataBuf.length, 20); c.writeUInt32LE(dataBuf.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(off, 42);
    centrals.push(c, nameBuf);
    off += 30 + nameBuf.length + dataBuf.length;
  }
  const cdStart = off;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
