import { describe, expect, test } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { toolsByNames } from '@/lib/agent/tools';

describe('text protocol tool catalog', () => {
  test('lists write_file in the prompt and executes a JSON write', async () => {
    const files = new Map<string, string>();
    const prompts: string[] = [];
    const script = [
      '{"tool":"write_file","args":{"path":"hello.txt","content":"hello-from-portable"}}',
      '{"tool":"finish","args":{"summary":"wrote hello.txt"}}',
    ];
    let n = 0;
    const companion = {
      async chat(opts: any) {
        const sys = opts.messages.find((m: any) => m.role === 'system')?.content || '';
        prompts.push(sys);
        expect(opts.tools).toBeUndefined();
        const text = script[n++] || script[script.length - 1];
        opts.onChunk?.({ t: 'text', v: text });
        return { text, end: { t: 'end', toolCalls: [] } };
      },
      async writeFile(_ws: string, path: string, content: string) {
        files.set(path, content);
        return { created: true, bytes: content.length, diffAdded: 1, diffRemoved: 0 };
      },
      async readFile() { throw new Error('not found'); },
      async tree() { return { entries: [] }; },
    };
    const runner = new AgentRunner({
      companion: companion as any,
      workspaceId: 'ws',
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:11434' },
      model: 'llama3.2:3b',
      systemPrompt: 'You are the coder.',
      task: 'Create hello.txt',
      tools: toolsByNames(['write_file', 'finish']),
      toolProtocol: 'text',
      maxTurns: 4,
      onEvent: () => {},
    });
    const result = await runner.run();
    const catalog = prompts[0].split('TOOLS AVAILABLE IN THIS RUN')[1] || '';
    expect(prompts[0]).toContain('TOOLS AVAILABLE IN THIS RUN');
    expect(catalog).toContain('write_file(path, content)');
    expect(catalog).not.toContain('run_command');
    expect(files.get('hello.txt')).toBe('hello-from-portable');
    expect(result.content).toContain('wrote hello.txt');
  });
});
