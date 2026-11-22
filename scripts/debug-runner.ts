// Debug: run the alias test scenario directly and dump events.
import { AgentRunner } from '../src/lib/agent/runner';
import { CORE_TOOLS } from '../src/lib/agent/tools';

const files = new Map([['calc.py', 'def add(a, b):\n    return a - b\n']]);
const companion: any = {
  chatCalls: [],
  async chat(o: any) {
    this.chatCalls.push(o);
    return {
      text: '{"tool": "edit_file", "args": {"path": "calc.py", "old_content": "return a - b", "new_content": "return a + b"}}',
      end: { finish: 'stop', toolCalls: [], usage: null },
    };
  },
  async exec() { return { exitCode: 0, stdout: '', stderr: '', cwd: null, durMs: 5, timedOut: false }; },
  async readFile(_w: string, p: string) {
    if (!files.has(p)) throw new Error('file not found: ' + p);
    const c = files.get(p)!;
    return { path: p, content: c, size: c.length, modifiedAt: '' };
  },
  async writeFile(_w: string, p: string, c: string) { files.set(p, c); return { path: p, bytes: c.length }; },
  async tree() { return { root: '/ws', entries: [] }; },
  async search() { return { count: 0, results: [] }; },
  async mkdir() {}, async deletePath() {}, async rename() {},
  procStart() { throw new Error('no'); }, procList() { return []; },
  procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
};

const events: any[] = [];
const runner = new AgentRunner({
  companion, workspaceId: 'ws1',
  provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }, model: 'm',
  systemPrompt: 'sys', task: 'fix calc.py', tools: CORE_TOOLS,
  toolProtocol: 'text', onEvent: (e) => events.push(e),
} as any);
const r = await runner.run();
console.log('RESULT:', JSON.stringify({ content: r.content, note: r.note, turns: r.turns }, null, 2));
console.log('FILES:', JSON.stringify([...files.entries()]));
for (const e of events) {
  console.log('EVENT:', e.type, e.type === 'tool_end' ? JSON.stringify(e.entry).slice(0, 300) : e.type === 'model_error' ? e.message : '');
}
console.log('CHAT MSGS:', JSON.stringify(companion.chatCalls[0]?.messages?.slice(0, 4), null, 1).slice(0, 800));
