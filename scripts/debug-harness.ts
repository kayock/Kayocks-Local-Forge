// Debug: replicate tests/harness.test.ts makeCompanion + run exactly.
import { AgentRunner } from '../src/lib/agent/runner';
import { CORE_TOOLS } from '../src/lib/agent/tools';

function makeCompanion(opts: { files?: Record<string, string>; chatScript?: any[]; execImpl?: (cmd: string, o: any) => any } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const chatCalls: any[] = [];
  const execCalls: any[] = [];
  const companion: any = {
    chatCalls,
    execCalls,
    files,
    async chat(o: any) {
      chatCalls.push(o);
      const list = opts.chatScript ?? [];
      const script = list[Math.min(chatCalls.length - 1, Math.max(0, list.length - 1))];
      if (script?.throwWithToolError) throw new Error(script.throwWithToolError);
      if (list.length > chatCalls.length - 1 && script === undefined) throw new Error('unexpected extra chat call');
      return { text: script?.text ?? '', end: { finish: 'stop', toolCalls: script?.toolCalls ?? [], usage: script?.usage ?? null } };
    },
    async exec(_ws: string, cmd: string, o: any) {
      execCalls.push({ cmd, opts: o });
      if (opts.execImpl) return opts.execImpl(cmd, o);
      return { exitCode: 0, stdout: '', stderr: '', cwd: null, durMs: 5, timedOut: false };
    },
    async readFile(_ws: string, p: string) {
      if (!files.has(p)) throw new Error(`Companion: file not found: ${p}`);
      const content = files.get(p)!;
      return { path: p, content, size: content.length, modifiedAt: new Date().toISOString() };
    },
    async writeFile(_ws: string, p: string, content: string) { files.set(p, content); return { path: p, bytes: content.length }; },
    async tree(_ws: string, _depth: number) {
      return { root: '/ws', entries: [...files.keys()].map((path) => ({ path, type: 'file' as const, size: (files.get(path) || '').length })) };
    },
    async search() { return { count: 0, results: [] }; },
    async mkdir() {}, async deletePath() {}, async rename() {},
    procStart(_ws: string, cmd: string, o: any) {
      const id = `p_${chatCalls.length}`;
      return { id, pid: 4001, cmd, cwd: o?.cwd ?? null, status: 'running', exitCode: null, startedAt: Date.now() };
    },
    procList() { return []; },
    procOutput() { return { proc: { id: 'p_1' }, output: 'x', outputBytes: 1 }; },
    async procStop() { return { id: 'p_1', status: 'stopped' }; },
  };
  return { companion, files, chatCalls, execCalls };
}

function run(companion: any, task: string, cfg: any = {}) {
  const events: any[] = [];
  const runner = new AgentRunner({
    companion, workspaceId: 'ws1',
    provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }, model: 'test-model',
    systemPrompt: 'You are a coding agent.', task, tools: CORE_TOOLS,
    onEvent: (e: any) => events.push(e),
    ...cfg,
  } as any);
  return { runner, events, promise: runner.run() };
}

const h = makeCompanion({ files: { 'calc.py': 'def add(a, b):\n    return a - b\n' } });
const origChat = h.companion.chat.bind(h.companion);
h.companion.chat = async (o: any) => {
  try { return await origChat(o); } catch (e: any) { console.error('CHAT STACK:', e.stack); throw e; }
};
const { promise, events } = run(h.companion, 'fix calc.py', {
  toolProtocol: 'text',
  chatScript: [{ text: '{"tool": "edit_file", "args": {"path": "calc.py", "old_content": "return a - b", "new_content": "return a + b"}}' }],
});
const r = await promise;
console.log('content:', JSON.stringify(r.content));
console.log('note:', JSON.stringify(r.note));
console.log('file now:', JSON.stringify(h.files.get('calc.py')));
console.log('events:', events.map((e) => e.type).join(','));
const te = events.filter((e: any) => e.type === 'tool_end');
console.log('toolEnds:', JSON.stringify(te.map((e: any) => ({ tool: e.entry.tool, status: e.entry.status })))); 
