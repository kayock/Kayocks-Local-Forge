// Regression tests for large tool-call arguments (Phase 1.5 spec §1).
// Maps to the observed Qwen3-Coder-30B failure: edit_file/write_file with
// realistic Python/Tkinter source repeatedly failed with "args were not valid
// JSON and could not be parsed" while the raw payload was recoverable.
// Every test verifies the EXACT written file contents, not just a status.
// Run: bun test tests/toolargs.test.ts
import { describe, test, expect } from 'bun:test';
import { AgentRunner } from '../src/lib/agent/runner';
import { CORE_TOOLS, normalizeToolArgs, validateToolArgs } from '../src/lib/agent/tools';
import { parseToolCallArgs, repairToolCallJson } from '../src/lib/agent/toolargs';
import { createToolCallAssembler, repairToolCallJson as jsRepair } from '../companion/src/toolcalls.js';
import type { AgentEvent, ToolLogEntry } from '../src/lib/agent/types';

// ---------------------------------------------------------------------------
// Helpers: in-memory companion + runner (same shape as harness.test.ts)
// ---------------------------------------------------------------------------
function makeCompanion(opts: { files?: Record<string, string>; chatScript?: { text?: string; toolCalls?: { id: string; name: string; args: any }[] }[] } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const chatCalls: any[] = [];
  const writes: { path: string; bytes: number; content: string }[] = [];
  const companion: any = {
    chatCalls, files, writes,
    chatScript: opts.chatScript ?? [],
    async chat(o: any) {
      chatCalls.push(o);
      const script = companion.chatScript[Math.min(chatCalls.length - 1, companion.chatScript.length - 1)];
      return { text: script?.text ?? '', end: { finish: 'stop', toolCalls: script?.toolCalls ?? [], usage: null } };
    },
    async exec() { return { exitCode: 0, stdout: '', stderr: '', cwd: null, durMs: 5, timedOut: false }; },
    async readFile(_w: string, p: string) {
      if (!files.has(p)) throw new Error(`file not found: ${p}`);
      const c = files.get(p)!;
      return { path: p, content: c, size: c.length, modifiedAt: new Date().toISOString() };
    },
    async writeFile(_w: string, p: string, c: string) {
      files.set(p, c);
      writes.push({ path: p, bytes: c.length, content: c });
      return { path: p, bytes: c.length };
    },
    async tree() { return { root: '/ws', entries: [...files.keys()].map((path) => ({ path, type: 'file' as const })) }; },
    async search() { return { count: 0, results: [] }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart() { throw new Error('no'); }, procList() { return []; },
    procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
  };
  return companion;
}

function run(companion: any, cfg: any = {}) {
  const events: AgentEvent[] = [];
  if (cfg.chatScript) companion.chatScript = cfg.chatScript;
  const runner = new AgentRunner({
    companion, workspaceId: 'ws1',
    provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }, model: 'm',
    systemPrompt: 'sys', task: 'write/edit code', tools: CORE_TOOLS,
    toolProtocol: 'native',
    approver: async () => 'allow',
    onEvent: (e) => events.push(e),
    ...cfg,
  } as any);
  return { runner, events, promise: runner.run() };
}

const toolEnds = (events: AgentEvent[]) => events.filter((e: any) => e.type === 'tool_end').map((e: any) => e.entry as ToolLogEntry);

// A realistic Python/Tkinter source generator (TaskForge-like GUI code).
function makeTkinterSource(lines: number, seed = 'A'): string {
  const out: string[] = [
    '#!/usr/bin/env python3',
    '"""TaskForge — a desktop task manager (generated test fixture)."""',
    'import tkinter as tk',
    'from tkinter import ttk, messagebox',
    '',
    'class TaskManager:',
    '    """Manages tasks. Underscores galore: task_manager_py_uses_many_things."""',
    '    def __init__(self, root):',
    '        self.root = root',
    '        self.tasks = []',
    '        self._build_ui()',
    '',
    '    def _build_ui(self):',
    '        self.listbox = tk.Listbox(self.root, width=60, height=20)',
    '        self.listbox.pack(fill=tk.BOTH, expand=True)',
  ];
  let i = out.length;
  while (out.length < lines) {
    out.push(`    def method_${i}_${seed}(self, arg_${i}):`);
    out.push(`        """Method ${i}: handles arg_${i} with "quotes" and 'apostrophes'."""`);
    out.push(`        text = f"task ${i}: {arg_${i}!r} \\\\ path C:\\\\Users\\\\dev\\\\task_${i}.json"`);
    out.push(`        self.tasks.append({"id": ${i}, "title": text, "done": False})`);
    out.push(`        self.listbox.insert(tk.END, text)`);
    out.push('');
    i++;
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// A. Pure parsing/repair layer (IDE side)
// ---------------------------------------------------------------------------
describe('tool-call argument repair (IDE-side, spec §1)', () => {
  test('valid 10KB+ content parses exactly (object preserved byte-for-byte)', () => {
    const content = makeTkinterSource(400); // ~14KB
    const json = JSON.stringify({ path: 'taskforge_gui.py', content });
    const r = parseToolCallArgs(json);
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe(content);
    expect(r.from).toBe('clean');
  });

  test('valid 50KB+ content parses exactly', () => {
    const content = makeTkinterSource(1500); // ~52KB
    const json = JSON.stringify({ path: 'big.py', content });
    const r = parseToolCallArgs(json);
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe(content);
    expect(r.rawLength).toBeGreaterThan(50000);
  });

  test('markdown-invalid escapes (\\_) are repaired and the underscore is preserved', () => {
    // What Qwen3-Coder emitted in the field: markdown-escaped underscores.
    const broken = '{"path": "a.py", "content": "def my\\_function(x\\_1):\\n    return x\\_1 + 1"}';
    const r = parseToolCallArgs(broken);
    expect(r.ok).toBe(true);
    expect(r.from).toBe('repaired');
    expect(r.args!.content).toBe('def my_function(x_1):\n    return x_1 + 1');
    expect((r.repairs ?? []).some((s) => s.includes('\\_'))).toBe(true);
  });

  test('literal newlines inside strings are escaped and content is preserved', () => {
    // A backend that emits real newlines inside a JSON string breaks parse;
    // repair must recover the same logical content.
    const broken = '{"path": "a.py", "content": "line1\nline2\nline3"}';
    const r = parseToolCallArgs(broken);
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe('line1\nline2\nline3');
  });

  test('truncated JSON (finish=length) is completed; truncated flag is set', () => {
    const full = { path: 'taskforge_gui.py', content: makeTkinterSource(200) };
    const json = JSON.stringify(full);
    // cut off 400 chars before the end — inside the content string
    const truncated = json.slice(0, json.length - 400);
    const r = parseToolCallArgs(truncated);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.args!.path).toBe('taskforge_gui.py');
    // content is a PREFIX of the intended content — never invented data
    expect((r.args!.content as string).length).toBeLessThan(full.content.length);
    expect(full.content.startsWith(r.args!.content)).toBe(true);
  });

  test('truncation detection: unbalanced brackets are closed, never fabricated content', () => {
    const truncated = '{"path": "a.py", "content": "x = [1, 2, 3", "replaceAll": true';
    const r = parseToolCallArgs(truncated);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.args!.replaceAll).toBe(true);
  });

  test('Windows paths and backslashes survive exactly', () => {
    const args = { path: 'src\\utils\\loader.py', content: 'p = "C:\\\\Users\\\\dev\\\\file.txt"\nopen(p)' };
    const r = parseToolCallArgs(JSON.stringify(args));
    expect(r.ok).toBe(true);
    expect(r.args!.path).toBe('src\\utils\\loader.py');
    expect(r.args!.content).toBe('p = "C:\\\\Users\\\\dev\\\\file.txt"\nopen(p)');
  });

  test('embedded JSON strings inside content survive exactly', () => {
    const content = 'config = \'{"model": "qwen3", "ctx": 8192}\'\njson.loads(config)';
    const r = parseToolCallArgs(JSON.stringify({ path: 'a.py', content }));
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe(content);
  });

  test('unicode content (CJK + emoji) survives exactly', () => {
    const content = '# 注释\nlabel = tk.Label(text="任务管理 🚀 任务")\n';
    const r = parseToolCallArgs(JSON.stringify({ path: 'a.py', content }));
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe(content);
  });

  test('double-encoded JSON strings are unwrapped', () => {
    const inner = JSON.stringify({ path: 'a.py', content: 'x = 1\n' });
    const r = parseToolCallArgs(JSON.stringify(inner));
    expect(r.ok).toBe(true);
    expect(r.args!.path).toBe('a.py');
  });

  test('multiline strings with quotes/backslashes (Python docstrings) survive', () => {
    const content = '"""\nUsage:\n  python tool.py "arg with \\"quotes\\""\nPath: C:\\dev\\tool\n"""';
    const r = parseToolCallArgs(JSON.stringify({ path: 'a.py', content }));
    expect(r.ok).toBe(true);
    expect(r.args!.content).toBe(content);
  });

  test('unparseable payloads fail with a precise error and preserved preview — nothing is silently discarded', () => {
    const garbage = '{"path": "a.py", "content": "def broken(: __name__ == "__main__": ';
    const r = parseToolCallArgs(garbage);
    if (!r.ok) {
      expect(r.error).toContain('JSON');
      expect(r.rawPreview!.startsWith('{"path"')).toBe(true);
    }
    // Either way the tool must never write garbage: validateToolArgs blocks
    // {_raw} args before execution.
    const v = validateToolArgs('write_file', { _raw: garbage });
    expect(v).toContain('NOT executed');
    expect(v).toContain('No files were changed');
  });

  test('repair never invents content: truncation completion only appends closers', () => {
    const truncated = '{"a": "value with \\"escaped\\" quotes and more text';
    const rep = repairToolCallJson(truncated);
    expect(rep.truncatedCompleted).toBe(true);
    const parsed = JSON.parse(rep.text);
    expect(parsed.a.startsWith('value with "escaped" quotes')).toBe(true);
  });

  test('companion and IDE repairers agree on the \\_ case', () => {
    const broken = '{"path": "a.py", "content": "x\\_1 = 2"}';
    const a = jsRepair(broken);
    const b = repairToolCallJson(broken);
    expect(a.text).toBe(b.text);
    expect(JSON.parse(a.text).content).toBe('x_1 = 2');
  });
});

// ---------------------------------------------------------------------------
// B. Companion-side streamed assembly (providers.js path)
// ---------------------------------------------------------------------------
describe('streamed tool-call delta assembly (companion, spec §1.4)', () => {
  function feedChunks(asm: ReturnType<typeof createToolCallAssembler>, argsStr: string, fragSize = 64) {
    // simulate an OpenAI-compatible stream: arguments arrive in fragments
    for (let i = 0; i < argsStr.length; i += fragSize) {
      asm.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: argsStr.slice(i, i + fragSize) } }] } }] });
    }
  }

  test('fragmented 50KB args assemble into the exact object', () => {
    const content = makeTkinterSource(1500);
    const argsStr = JSON.stringify({ path: 'taskforge_gui.py', content });
    const asm = createToolCallAssembler();
    feedChunks(asm, argsStr, 97); // awkward fragment size to stress boundaries
    const calls = asm.finalize({ finishReason: 'stop' });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].args.content).toBe(content);
    expect(calls[0].argsRepaired).toBe(false);
    expect(calls[0].argsError).toBeNull();
  });

  test('invalid escapes streamed in fragments are repaired', () => {
    const asm = createToolCallAssembler();
    feedChunks(asm, '{"path": "a.py", "content": "x\\_1 = \\"y\\""}', 7);
    const calls = asm.finalize({ finishReason: 'stop' });
    expect(calls[0].args.content).toBe('x_1 = "y"');
    expect(calls[0].argsRepaired).toBe(true);
    expect((calls[0] as any).argsRepairs.length).toBeGreaterThan(0);
  });

  test('truncated stream (finish=length) is completed and flagged', () => {
    const full = JSON.stringify({ path: 'a.py', content: 'x = "' + 'A'.repeat(500) + '"' });
    const asm = createToolCallAssembler();
    feedChunks(asm, full.slice(0, full.length - 60), 128);
    const calls = asm.finalize({ finishReason: 'length' });
    expect(calls[0].argsTruncated).toBe(true);
    expect(calls[0].args.path).toBe('a.py');
    expect(calls[0].args.content.startsWith('x = "AAAA')).toBe(true);
  });

  test('unrepairable garbage keeps _raw plus a structured error — never a silent fake success', () => {
    const asm = createToolCallAssembler();
    feedChunks(asm, '{"path": "a.py", "content": "def f(: :::: }{{{ nope', 32);
    const calls = asm.finalize({ finishReason: 'stop' });
    if (calls[0].argsError) {
      expect(calls[0].args._raw).toContain('"path"');
      expect(calls[0].argsError).toContain('JSON');
    } else {
      // if repair produced something, it must at least be valid JSON
      expect(typeof calls[0].args).toBe('object');
    }
  });

  test('multiple parallel tool calls keep separate indexes and order', () => {
    const asm = createToolCallAssembler();
    const mk = (index: number, id: string | undefined, name: string | undefined, args: string) => ({
      choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
    });
    asm.feed(mk(0, 'c0', 'write_file', '{"path": "a'));
    asm.feed(mk(1, 'c1', 'edit_file', '{"path": "b.py", "find": "x"'));
    asm.feed(mk(0, undefined, undefined, '.py", "content": "A"}'));
    asm.feed(mk(1, undefined, undefined, ', "replace": "y"}'));
    const calls = asm.finalize({ finishReason: 'stop' });
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].args.path).toBe('a.py');
    expect(calls[1].name).toBe('edit_file');
    expect(calls[1].args.replace).toBe('y');
  });

  test('UTF-8 multibyte characters split across fragment boundaries survive', () => {
    const content = 's = "任务管理任务管理任务管理" * 100\n'; // many 3-byte chars
    const argsStr = JSON.stringify({ path: 'a.py', content });
    const asm = createToolCallAssembler();
    // fragment size 5 guarantees splitting inside multibyte sequences is NOT
    // possible at the JSON-fragment level (fragments are strings), but proves
    // reassembly fidelity for CJK payloads regardless
    feedChunks(asm, argsStr, 5);
    const calls = asm.finalize({ finishReason: 'stop' });
    expect(calls[0].args.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// C. End-to-end through AgentRunner: exact written contents
// ---------------------------------------------------------------------------
describe('end-to-end large tool calls through the runner (spec §1)', () => {
  test('native write_file with 10KB+ Python/Tkinter content writes the exact bytes', async () => {
    const content = makeTkinterSource(400);
    const companion = makeCompanion();
    const { promise, events } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'taskforge_gui.py', content } }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'written' } }] },
      ],
    });
    await promise;
    expect(companion.files.get('taskforge_gui.py')).toBe(content);
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('ok');
    expect(entry.output).toContain(`Wrote taskforge_gui.py (${content.length} bytes)`);
  });

  test('native write_file with 50KB+ content writes the exact bytes', async () => {
    const content = makeTkinterSource(1500);
    const companion = makeCompanion();
    const { promise, events } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'big_gui.py', content } }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'written' } }] },
      ],
    });
    await promise;
    expect(companion.files.get('big_gui.py')).toBe(content);
    expect(toolEnds(events)[0].status).toBe('ok');
  });

  test('write_file delivered as a JSON STRING (stringified args) is decoded and executed exactly', async () => {
    const content = makeTkinterSource(120);
    const companion = makeCompanion();
    const { promise, events } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'gui.py', content }) }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'ok' } }] },
      ],
    });
    await promise;
    expect(companion.files.get('gui.py')).toBe(content);
    expect(toolEnds(events)[0].status).toBe('ok');
    expect(toolEnds(events)[0].parse).toBe('clean');
  });

  test('write_file with markdown-broken escapes is repaired and executed exactly', async () => {
    const companion = makeCompanion();
    const intended = 'def my_function(x_1):\n    return x_1\n';
    const { promise, events } = run(companion, {
      chatScript: [
        // the exact damage pattern seen in the field report (\_ escapes)
        { toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path": "gui.py", "content": "def my\\_function(x\\_1):\\n    return x\\_1\\n"}' }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'ok' } }] },
      ],
    });
    await promise;
    expect(companion.files.get('gui.py')).toBe(intended);
    const entry = toolEnds(events)[0];
    expect(entry.status).toBe('ok');
    expect(entry.parse).toBe('repaired');
    expect(entry.output).toContain('serialization repair');
  });

  test('append_file builds a large file in sections with exact concatenation', async () => {
    const companion = makeCompanion();
    const part1 = 'import tkinter as tk\n\nclass App:\n    def __init__(self):\n        self.x = 1\n';
    const part2 = '\n    def run(self):\n        self.mainloop()\n';
    const part3 = '\nif __name__ == "__main__":\n    App().run()\n';
    const { promise, events } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'app.py', content: part1 } }] },
        { toolCalls: [{ id: 'c2', name: 'append_file', args: { path: 'app.py', content: part2 } }] },
        { toolCalls: [{ id: 'c3', name: 'append_file', args: { path: 'app.py', content: part3 } }] },
        { toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'built in sections' } }] },
      ],
    });
    await promise;
    expect(companion.files.get('app.py')).toBe(part1 + part2 + part3);
    const writes = toolEnds(events).slice(0, 3);
    expect(writes.every((w) => w.status === 'ok')).toBe(true);
    expect(writes[2].output).toContain(`${(part1 + part2 + part3).length} bytes total`);
  });

  test('edit_file with multiline Python snippet replaces exactly once', async () => {
    const original = makeTkinterSource(30);
    const companion = makeCompanion({ files: { 'taskforge_gui.py': original } });
    const find = '    def _build_ui(self):\n        self.listbox = tk.Listbox(self.root, width=60, height=20)';
    const replace = '    def _build_ui(self):\n        self.listbox = tk.Listbox(self.root, width=80, height=24)\n        self.listbox.configure(exportselection=False)';
    const { promise } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'taskforge_gui.py', find, replace } }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'edited' } }] },
      ],
    });
    await promise;
    const expected = original.replace(find, replace);
    expect(companion.files.get('taskforge_gui.py')).toBe(expected);
  });

  test('a failed parse NEVER touches the filesystem (no partial writes) and the task continues', async () => {
    const companion = makeCompanion({ files: { 'gui.py': 'original = True\n' } });
    const { promise, events } = run(companion, {
      chatScript: [
        // unrepairable garbage args
        { toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path": "gui.py", "content": ' }] },
        { toolCalls: [{ id: 'c2', name: 'append_file', args: { path: 'gui.py', content: '# recovery edit\n' } }] },
        { toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'recovered after failed edit' } }] },
      ],
    });
    const r = await promise;
    // the failed call must NOT have modified the file
    expect(companion.files.get('gui.py')).toBe('original = True\n# recovery edit\n');
    const first = toolEnds(events)[0];
    expect(first.status).toBe('error');
    expect(first.output).toContain('NOT executed');
    expect(first.output).toContain('No files were changed');
    // and the run CONTINUED to completion without a restart
    expect(r.content).toBe('recovered after failed edit');
  });

  test('consecutive parse failures trigger failure-pattern recovery guidance (spec §3)', async () => {
    const companion = makeCompanion({ files: { 'gui.py': 'x = 1\n' } });
    // truly unrepairable garbage (differs per attempt — the old identical-args
    // guard could not catch this pattern)
    const broken = (i: number) => ({ toolCalls: [{ id: `c${i}`, name: 'write_file', args: `{"path": "gui${i}.py", "content": "def broken${i}(: :::: }{{{ nope` }] });
    const { promise, events } = run(companion, {
      chatScript: [
        broken(1), broken(2), broken(3),
        { toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'stopped after recovery advice' } }] },
      ],
    });
    await promise;
    const ends = toolEnds(events);
    const recovery = ends.find((e) => e.recoveryIssued);
    expect(recovery).toBeDefined();
    expect(recovery!.output).toContain('[RECOVERY — repeated failure pattern detected]');
    expect(recovery!.output).toContain('edit_file with SHORT find/replace snippets');
    expect(companion.files.get('gui.py')).toBe('x = 1\n'); // untouched
  });

  test('truncated tool arguments are completed for diagnosis but NEVER executed (no partial writes)', async () => {
    const companion = makeCompanion();
    const big = 'X'.repeat(20000);
    const { promise, events } = run(companion, {
      chatScript: [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: `{"path": "a.py", "content": "${big}` }] },
        { toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'handled truncation' } }] },
      ],
    });
    await promise;
    expect(companion.files.has('a.py')).toBe(false); // nothing written
    const first = toolEnds(events)[0];
    expect(first.status).toBe('error');
    expect(first.output).toContain('TRUNCATED');
    expect(first.output).toContain('NOT executed');
    expect(first.output).toContain('append_file');
    // history does not re-send the huge payload: capped marker only
    const secondCall = companion.chatCalls[1];
    const asst = secondCall.messages.find((m: any) => m.role === 'assistant' && m.tool_calls?.length);
    expect(asst).toBeDefined();
    const raw = JSON.stringify(asst.tool_calls[0].function.arguments);
    expect(raw.length).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// D. Alias/schema edges for the new transport
// ---------------------------------------------------------------------------
describe('append_file schema (spec §1 transport)', () => {
  test('missing path gets a precise validation error', () => {
    const v = validateToolArgs('append_file', { content: 'x' });
    expect(v).toContain('"path"');
    expect(v).toContain('Expected schema for append_file');
  });
  test('normalizeToolArgs maps aliases for the new tool', () => {
    const { tool, args } = normalizeToolArgs('append', { file: 'a.py', text: 'x' });
    expect(tool).toBe('append_file');
    expect(args.path).toBe('a.py');
    expect(args.content).toBe('x');
  });
});
