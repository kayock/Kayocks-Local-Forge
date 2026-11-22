import { describe, expect, test } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { toolsByNames } from '@/lib/agent/tools';
import { testerPrompt } from '@/lib/agent/prompts';
import { STAGE_TOOLS as coordinatorTools } from '@/lib/agent/coordinator';
import { STAGE_TOOLS as fanoutTools } from '@/lib/agent/fanout';
import { STAGE_TOOLS as orchestratorTools } from '@/lib/agent/orchestrator';
import { collaborationRequiresExecution, evaluateObjectiveAcceptance, type TestEvidence } from '@/lib/agent/acceptance';
import { allowAutomatic, defaultParticipation } from '@/lib/fleet/participation';

const RUN = 'collab-current';
const REV = 'rev-current';

function evidence(over: Partial<TestEvidence> = {}): TestEvidence {
  return {
    command: 'node --test tests/qr.test.mjs',
    exitCode: 0,
    output: '$ node --test tests/qr.test.mjs\nexit code: 0\n# pass 4\nok 1 - homepage renders',
    files: ['src/app.js'],
    at: 1_700_000_000_000,
    machine: 'Portable',
    runId: RUN,
    revision: REV,
    tool: 'run_tests',
    ...over,
  };
}

describe('objective acceptance', () => {
  test('an untested application cannot receive an objective PASS', () => {
    const result = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [],
      runId: RUN,
      revision: REV,
    });
    expect(result.reviewerVerdict).toBe('APPROVE');
    expect(result.status).toBe('NOT TESTED');
  });

  test('a failing test blocks acceptance and an APPROVE verdict cannot override it', () => {
    const result = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [evidence({ exitCode: 1, output: '$ node --test\nexit code: 1\nnot ok 1 - page loads' })],
      runId: RUN,
      revision: REV,
    });
    expect(result.reviewerVerdict).toBe('APPROVE');
    expect(result.status).toBe('FAIL');
    expect(result.reason).toContain('exited 1');
  });

  test('a successful test run with captured output can pass the gate', () => {
    const result = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'REQUEST_CHANGES',
      evidence: [evidence()],
      runId: RUN,
      revision: REV,
    });
    expect(result.status).toBe('PASS');
    expect(result.evidence[0].machine).toBe('Portable');
    expect(result.evidence[0].command).toContain('qr.test');
  });

  test('stale evidence from another run or revision does not count', () => {
    const result = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [
        evidence({ runId: 'collab-old' }),
        evidence({ revision: 'rev-old' }),
      ],
      runId: RUN,
      revision: REV,
    });
    expect(result.status).toBe('NOT TESTED');
  });

  test('success with no captured output is incomplete, and a skipped run is incomplete', () => {
    const empty = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [evidence({ output: '$ npm test\nexit code: 0\nduration: 0.1s' })],
      runId: RUN,
      revision: REV,
    });
    expect(empty.status).toBe('INCOMPLETE');
    const skipped = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [evidence({ output: '$ npm test\nexit code: 0\n# tests 0\n# skipped 3\nno tests' })],
      runId: RUN,
      revision: REV,
    });
    expect(skipped.status).toBe('INCOMPLETE');
  });

  test('a collaboration that does not produce executable work is not forced through the test gate', () => {
    expect(collaborationRequiresExecution(['planner', 'reviewer'])).toBe(false);
    const result = evaluateObjectiveAcceptance({
      applicable: false,
      reviewerVerdict: 'APPROVE',
      evidence: [],
      runId: RUN,
      revision: null,
    });
    expect(result.status).toBe('NOT_APPLICABLE');
    expect(collaborationRequiresExecution(undefined)).toBe(true);
  });
});

describe('tester role restrictions', () => {
  test('tester tool lists cannot rewrite application files', () => {
    for (const names of [coordinatorTools.tester, fanoutTools.tester, orchestratorTools.tester]) {
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('edit_file');
      expect(names).not.toContain('append_file');
      expect(names).toContain('run_tests');
      expect(names).toContain('run_command');
    }
    expect(testerPrompt({ workspacePath: '/w', platform: 'linux' })).toContain('Do not rewrite application files');
  });

  test('a tester run rejects write_file instead of applying it', async () => {
    let wrote = false;
    const companion = {
      async chat(opts: any) {
        opts.onChunk?.({ t: 'thinking', v: '{"tool":"write_file","args":{"path":"src/app.js","content":"rewritten"}}' });
        return {
          text: '',
          end: { finish: 'stop', toolCalls: [
            { id: 'c1', name: 'write_file', args: { path: 'src/app.js', content: 'rewritten' } },
            { id: 'c2', name: 'finish', args: { summary: 'PASS' } },
          ] },
        };
      },
      async writeFile() { wrote = true; return { bytes: 1 }; },
      async readFile() { throw new Error('missing'); },
      async tree() { return { root: '/w', entries: [] }; },
      async statPath() { return { exists: true, type: 'dir', empty: true, entryCount: 0 }; },
      async search() { return { results: [] }; },
      async exec() { return { exitCode: 0, stdout: 'ok 1\n', stderr: '', cwd: '/w', durMs: 1, timedOut: false }; },
      async mkdir() {}, async deletePath() {}, async rename() {},
      procStart() { throw new Error('no'); }, procList() { return []; },
      procOutput() { throw new Error('no'); }, procStop() { throw new Error('no'); },
    };
    const events: any[] = [];
    const runner = new AgentRunner({
      companion, workspaceId: 'ws1',
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:11434' }, model: 'deepseek-q8:latest',
      systemPrompt: 'tester', task: 'verify',
      tools: toolsByNames(coordinatorTools.tester), toolProtocol: 'native', maxTurns: 4,
      onEvent: (e) => events.push(e),
    } as any);
    const result = await runner.run();
    expect(wrote).toBe(false);
    const blocked = events.find((e) => e.type === 'tool_end' && e.entry.tool === 'write_file');
    expect(blocked.entry.status).toBe('error');
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
    expect(events.some((e) => e.type === 'notice' && String(e.message).includes('No visible answer yet'))).toBe(true);
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
    expect(result.content).toBe('PASS');
  });
});

describe('fleet defaults stay in place', () => {
  test('Portable stays the preferred worker and Windows stays manual-only', () => {
    expect(defaultParticipation({ machineId: 'pc_554398e6', name: 'Portable', platform: 'linux' })).toBe('enabled');
    expect(defaultParticipation({ machineId: 'pc_c597ded2', name: 'Windows', platform: 'win32' })).toBe('manual');
    expect(allowAutomatic('manual', true)).toBe(false);
    expect(allowAutomatic('enabled')).toBe(true);
  });
});
