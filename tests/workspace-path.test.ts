import { describe, expect, test } from 'bun:test';
import { Coordinator } from '@/lib/agent/coordinator';
import { canonRelPath, toolsByNames } from '@/lib/agent/tools';
import { coderPrompt, plannerPrompt } from '@/lib/agent/prompts';

const ROOT = '/tmp/lf-ds-1795374696';
const STALE = '/tmp/lf-ds-1794617131/hello.txt';

describe('workspace path resolution', () => {
  test('relative paths stay relative and in-workspace absolute paths collapse to the root', () => {
    expect(canonRelPath('hello.txt', ROOT)).toBe('hello.txt');
    expect(canonRelPath('./hello.txt', ROOT)).toBe('hello.txt');
    expect(canonRelPath('src/app.ts', ROOT)).toBe('src/app.ts');
    expect(canonRelPath(`${ROOT}/hello.txt`, ROOT)).toBe('hello.txt');
    expect(canonRelPath(`${ROOT}/nested/a.txt`, ROOT)).toBe('nested/a.txt');
  });

  test('an outside absolute path is not rewritten into a nested workspace path', () => {
    expect(canonRelPath(STALE, ROOT)).toBe(STALE);
    expect(canonRelPath(STALE, ROOT)).not.toBe('tmp/lf-ds-1794617131/hello.txt');
    expect(canonRelPath('/tmp/lf-ds-1795374696-evil/hello.txt', ROOT)).toBe('/tmp/lf-ds-1795374696-evil/hello.txt');
  });

  test('write_file refuses the stale absolute path and read_file sees the same root file', async () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const commands: { cmd: string; cwd?: string }[] = [];
    const write = toolsByNames(['write_file'])[0];
    const read = toolsByNames(['read_file'])[0];
    const shell = toolsByNames(['run_command'])[0];
    const ctx = {
      workspaceId: 'ws',
      workspaceMeta: { id: 'ws', rootPath: ROOT, machineLabel: 'Portable', platform: 'linux' },
      fs: {
        async writeFile(p: string, content: string) {
          writes.push(p);
          files.set(p, content);
          return { created: true, bytes: content.length, path: p };
        },
        async readFile(p: string) {
          if (!files.has(p)) throw new Error(`File not found: ${p}`);
          const content = files.get(p)!;
          return { content, size: content.length };
        },
        async listDir() { return []; },
      },
      async runCommand(cmd: string, opts?: { cwd?: string }) {
        commands.push({ cmd, cwd: opts?.cwd });
        if (cmd.includes('hello.txt') && !cmd.includes(STALE)) {
          return { exitCode: 0, stdout: files.get('hello.txt') || '', stderr: '', cwd: opts?.cwd || ROOT, durMs: 1, timedOut: false };
        }
        return { exitCode: 1, stdout: '', stderr: 'No such file', cwd: opts?.cwd || ROOT, durMs: 1, timedOut: false };
      },
    };
    await expect(write.run({ path: STALE, content: 'hello-from-portable' }, ctx as any)).rejects.toThrow(/outside the workspace/);
    expect(writes).toEqual([]);
    expect([...files.keys()]).not.toContain('tmp/lf-ds-1794617131/hello.txt');

    const wrote = await write.run({ path: 'hello.txt', content: 'hello-from-portable' }, ctx as any);
    expect(wrote.output).toContain('hello.txt');
    expect(wrote.output).not.toContain('tmp/lf-ds-1794617131');
    expect(files.get('hello.txt')).toBe('hello-from-portable');

    const same = await write.run({ path: `${ROOT}/hello.txt`, content: 'hello-from-portable' }, ctx as any);
    expect(writes.at(-1)).toBe('hello.txt');
    expect(same.output).toContain('Wrote hello.txt');

    const seen = await read.run({ path: 'hello.txt' }, ctx as any);
    expect(seen.output).toContain('hello-from-portable');
    await expect(read.run({ path: '../hello.txt' }, ctx as any)).rejects.toThrow(/traversal|escapes/);

    const cmd = await shell.run({ command: 'cat hello.txt' }, ctx as any);
    expect(cmd.output).toContain('hello-from-portable');
    expect(commands[0].cwd).toBeUndefined();
    expect(commands[0].cmd).toBe('cat hello.txt');
  });

  test('planner and coder share one workspace and a stale absolute write is not stored', async () => {
    const files = new Map<string, string>();
    const prompts: string[] = [];
    const coder = [
      JSON.stringify({ tool: 'write_file', args: { path: STALE, content: 'hello-from-portable' } }),
      JSON.stringify({ tool: 'write_file', args: { path: 'hello.txt', content: 'hello-from-portable' } }),
      JSON.stringify({ tool: 'read_file', args: { path: 'hello.txt' } }),
      JSON.stringify({ tool: 'run_command', args: { command: 'cat hello.txt' } }),
      JSON.stringify({ tool: 'finish', args: { summary: 'wrote hello.txt and read it back' } }),
    ];
    let coderN = 0;
    const companion = {
      async chat(opts: any) {
        const sys = opts.messages.find((m: any) => m.role === 'system')?.content || '';
        prompts.push(sys);
        const planner = prompts.length === 1;
        const text = planner
          ? JSON.stringify({ tool: 'finish', args: { summary: 'PLAN:\n1. Create hello.txt containing hello-from-portable' } })
          : coder[coderN++] || coder[coder.length - 1];
        opts.onChunk?.({ t: 'text', v: text });
        return { text, end: { t: 'end', toolCalls: [] } };
      },
      async writeFile(_ws: string, p: string, content: string) {
        files.set(p, content);
        return { created: true, bytes: content.length, path: p };
      },
      async readFile(_ws: string, p: string) {
        if (!files.has(p)) throw new Error(`File not found: ${p}`);
        return { content: files.get(p), size: files.get(p)!.length };
      },
      async exec(_ws: string, cmd: string) {
        return { exitCode: files.has('hello.txt') ? 0 : 1, stdout: files.get('hello.txt') || '', stderr: '', cwd: '.', durMs: 1, timedOut: false, cmd };
      },
      async tree() { return { entries: [...files.keys()].map((path) => ({ path, type: 'file', size: files.get(path)!.length })) }; },
    };
    const mesh = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'workspaceRevision') return async () => ({ revision: 'abc' });
        return async () => ({});
      },
    });
    const target = {
      machineId: 'pc_554398e6',
      machineName: 'Portable',
      provider: { kind: 'openai' as const, baseUrl: 'http://127.0.0.1:11434' },
      model: 'deepseek-q8:latest',
      toolProtocol: 'text' as const,
      maxTurns: 8,
      allowAutomatic: true,
    };
    const coordinator = new Coordinator({
      workspaceHost: companion as any,
      workspaceId: 'ws-temp',
      workspacePath: ROOT,
      workspaceContext: { platform: 'linux', workspacePath: ROOT, machineLabel: 'Portable' },
      mesh: mesh as any,
      task: 'Create hello.txt containing exactly hello-from-portable',
      machines: [target],
      maxTurnsPerStage: 8,
      reworkPasses: 0,
      stages: ['planner', 'coder'],
      onEvent: () => {},
      approver: async () => 'allow',
      clientForMachine: () => companion as any,
    });
    const report = await coordinator.run({ planner: target, coder: target });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toContain(ROOT);
    expect(prompts[1]).toContain(ROOT);
    expect(prompts[0]).toContain('PLANNER');
    expect(prompts[1]).toContain('CODER');
    expect(files.get('hello.txt')).toBe('hello-from-portable');
    expect(files.has('tmp/lf-ds-1794617131/hello.txt')).toBe(false);
    expect(report.results.map((r) => r.stage)).toEqual(['planner', 'coder']);
    expect(report.results.every((r) => r.machine === 'Portable')).toBe(true);
    expect(report.results[1].hitTurnLimit).toBe(false);
    const plan = plannerPrompt({ platform: 'linux', workspacePath: ROOT });
    const code = coderPrompt({ platform: 'linux', workspacePath: ROOT });
    expect(plan).toContain(ROOT);
    expect(code).toContain(ROOT);
  });
});
