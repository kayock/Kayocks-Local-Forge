import { describe, expect, test } from 'bun:test';
import { AgentRunner } from '@/lib/agent/runner';
import { toolsByNames } from '@/lib/agent/tools';
import { fallbackSystemAddon, plannerPrompt, reviewerPrompt, testerPrompt } from '@/lib/agent/prompts';
import { evaluateObjectiveAcceptance, type TestEvidence } from '@/lib/agent/acceptance';
import {
  allocatedContextFromModelMeta,
  compactToBudget,
  compactionBudgetChars,
  resolveContextCapacity,
} from '@/lib/agent/context-capacity';
import {
  checkAcceptanceCommands,
  commandsMatch,
  extractAcceptanceCommands,
  parseReviewerVerdict,
  assessReviewEvidence,
  completionFor,
  plannerRetryTask,
  planningDeliverable,
  requiredReviewPaths,
  reviewFollowup,
  reviewReads,
} from '@/lib/agent/collab-policy';

const RUN = 'reliability';
const REV = 'rev';

function wire(toolChars: number) {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: 'system' },
    { role: 'tool', content: 't'.repeat(toolChars) },
  ];
  for (let i = 0; i < 8; i++) messages.push({ role: 'user', content: `recent ${i}` });
  return messages;
}

describe('context capacity', () => {
  test('uses the allocated context and ignores the training context', () => {
    const meta = allocatedContextFromModelMeta({ n_ctx: 4096, n_ctx_train: 262144 });
    expect(meta.tokens).toBe(4096);
    expect(meta.trainTokens).toBe(262144);
    const resolved = resolveContextCapacity({ liveTokens: meta.tokens });
    expect(resolved.tokens).toBe(4096);
    expect(resolved.source).toBe('live');
    expect(resolved.verified).toBe(true);
    expect(resolved.note).not.toContain('8192');
  });

  test('an omitted context stays unknown instead of assuming 8192', () => {
    const resolved = resolveContextCapacity({});
    expect(resolved.tokens).toBeNull();
    expect(resolved.source).toBe('unknown');
    expect(resolved.verified).toBe(false);
    expect(compactionBudgetChars(resolved)).toBeNull();
    const original = wire(20000);
    const compacted = compactToBudget(original.map((message) => ({ ...message })), null);
    expect(compacted[1].content.length).toBe(20000);
  });

  test('4096 compacts a prompt that an 8192 assumption would still send', () => {
    const narrow = compactionBudgetChars(resolveContextCapacity({ liveTokens: 4096 }));
    const assumed = compactionBudgetChars(resolveContextCapacity({ liveTokens: 8192 }));
    expect(narrow).toBe((4096 - 1200) * 4);
    expect(assumed).toBe((8192 - 1200) * 4);
    const prompt = wire(15000);
    expect(15000).toBeGreaterThan(narrow!);
    expect(15000).toBeLessThan(assumed!);
    const compacted = compactToBudget(prompt, narrow);
    expect(String(compacted[1].content)).toContain('earlier tool output trimmed');
    expect(String(compactToBudget(wire(15000), assumed)[1].content)).not.toContain('trimmed');
  });

  test('8192, 16384, and larger contexts keep their own budgets', () => {
    for (const tokens of [8192, 16384, 32768]) {
      const budget = compactionBudgetChars(resolveContextCapacity({ liveTokens: tokens }));
      expect(budget).toBe((tokens - 1200) * 4);
      const compacted = compactToBudget(wire(15000), budget);
      expect(String(compacted[1].content)).not.toContain('trimmed');
    }
  });

  test('the effective capacity is the smaller of the explicit limit and the live server', () => {
    const serverSmaller = resolveContextCapacity({ explicit: true, explicitTokens: 16384, liveTokens: 4096 });
    expect(serverSmaller.tokens).toBe(4096);
    expect(serverSmaller.source).toBe('min');
    const participantSmaller = resolveContextCapacity({ explicit: true, explicitTokens: 8192, liveTokens: 16384 });
    expect(participantSmaller.tokens).toBe(8192);
    expect(participantSmaller.source).toBe('min');
  });

  test('tool definitions and reserved output reduce the character budget', () => {
    const resolved = resolveContextCapacity({ liveTokens: 4096, reservedOutputTokens: 512 });
    const budget = compactionBudgetChars(resolved, 1000);
    expect(budget).toBe((4096 - 512) * 4 - 1000);
  });
});

describe('acceptance commands', () => {
  test('preserves the workspace-root unittest command and rejects the substituted one', () => {
    const task = [
      'Create work/mul.py and work/test_mul.py.',
      'The tester must run python3 -m unittest work.test_mul.',
    ].join('\n');
    expect(extractAcceptanceCommands(task)).toEqual(['python3 -m unittest work.test_mul']);
    expect(commandsMatch('python3 -m unittest work.test_mul', 'python3 -m unittest work.test_mul')).toBe(true);
    expect(commandsMatch('cd work && python3 -m unittest test_mul', 'python3 -m unittest work.test_mul')).toBe(false);
  });

  test('a passing substitute does not override a missing mandatory command', () => {
    const evidence: TestEvidence[] = [{
      command: 'cd work && python3 -m unittest test_mul',
      exitCode: 0,
      output: 'Ran 2 tests\nOK',
      files: ['work/mul.py'],
      at: 1,
      machine: 'Station',
      runId: RUN,
      revision: REV,
      tool: 'run_command',
    }];
    const result = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence,
      runId: RUN,
      revision: REV,
      requiredCommands: ['python3 -m unittest work.test_mul'],
    });
    expect(result.status).toBe('NOT TESTED');
    expect(result.reason).toContain('python3 -m unittest work.test_mul');
    expect(result.reason).toContain('does not replace');
  });

  test('the required command must pass before objective acceptance does', () => {
    const failed = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [{
        command: 'python3 -m unittest work.test_mul',
        exitCode: 1,
        output: 'ModuleNotFoundError: No module named mul',
        files: [],
        at: 1,
        machine: 'Station',
        runId: RUN,
        revision: REV,
        tool: 'run_command',
      }],
      runId: RUN,
      revision: REV,
      requiredCommands: ['python3 -m unittest work.test_mul'],
    });
    expect(failed.status).toBe('FAIL');
    expect(failed.reason).toContain('python3 -m unittest work.test_mul');
    const passed = evaluateObjectiveAcceptance({
      applicable: true,
      reviewerVerdict: 'APPROVE',
      evidence: [{
        command: 'python3 -m unittest work.test_mul',
        exitCode: 0,
        output: 'Ran 2 tests\nOK',
        files: ['work/test_mul.py'],
        at: 2,
        machine: 'Station',
        runId: RUN,
        revision: REV,
        tool: 'run_command',
      }],
      runId: RUN,
      revision: REV,
      requiredCommands: ['python3 -m unittest work.test_mul'],
    });
    expect(passed.status).toBe('PASS');
  });
});

describe('reviewer verdict and coordinator follow-up', () => {
  test('a missing verdict stays UNKNOWN and is not a request for changes', () => {
    expect(parseReviewerVerdict('The implementation looks complete. Task complete.')).toBe('UNKNOWN');
    const follow = reviewFollowup({
      verdict: 'UNKNOWN',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
    });
    expect(follow).toEqual({ action: 'stop', completion: 'VERDICT_MISSING' });
  });

  test('a missing verdict gets one retry before it is final', () => {
    expect(reviewFollowup({
      verdict: 'UNKNOWN',
      verdictRetriesUsed: 0,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
    }).action).toBe('retry-reviewer');
  });

  test('REQUEST_CHANGES and a failed acceptance command can start the debugger once', () => {
    expect(parseReviewerVerdict('Needs a fix.\nVERDICT: REQUEST_CHANGES')).toBe('REQUEST_CHANGES');
    expect(reviewFollowup({
      verdict: 'REQUEST_CHANGES',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
    })).toEqual({ action: 'debugger', reason: 'request-changes' });
    expect(reviewFollowup({
      verdict: 'APPROVE',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: true,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
    })).toEqual({ action: 'debugger', reason: 'acceptance-failed' });
    expect(reviewFollowup({
      verdict: 'REQUEST_CHANGES',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: true,
      testerRetriesUsed: 1,
      reworkUsed: 1,
      reworkLimit: 1,
      testerProducedEvidence: true,
    })).toEqual({ action: 'stop', completion: 'TESTS_FAILED' });
  });

  test('approval without tester evidence is not accepted', () => {
    expect(reviewFollowup({
      verdict: 'APPROVE',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: false,
    })).toEqual({ action: 'stop', completion: 'NOT_TESTED' });
    const check = checkAcceptanceCommands([], ['python3 -m unittest work.test_mul']);
    expect(check.missing).toEqual(['python3 -m unittest work.test_mul']);
  });

  test('BLOCKED is preserved and the last verdict line wins', () => {
    expect(parseReviewerVerdict('VERDICT: REQUEST_CHANGES\nVERDICT: APPROVE')).toBe('APPROVE');
    expect(parseReviewerVerdict('Cannot review the workspace.\nVERDICT: BLOCKED')).toBe('BLOCKED');
    expect(reviewFollowup({
      verdict: 'BLOCKED',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
      evidenceMissing: false,
      evidenceRetriesUsed: 1,
    })).toEqual({ action: 'stop', completion: 'BLOCKED' });
  });

  test('approval after reading the changed implementation and test is accepted', () => {
    const required = requiredReviewPaths({
      changedFiles: ['work/mul.py', 'work/test_mul.py', 'notes.md'],
      task: 'Implement work/mul.py and work/test_mul.py. The tester must run `python3 -m unittest work.test_mul`.',
      plan: '1. Create work/mul.py and work/test_mul.py',
    });
    expect(required).toEqual(['work/mul.py', 'work/test_mul.py']);
    const reads = reviewReads([
      { role: 'assistant', content: '{"tool":"read_file","args":{"path":"work/mul.py"}}' },
      { role: 'user', content: '[TOOL RESULT] read_file \ndef mul(a, b):\n    return a * b\nContinue: reply with exactly one JSON tool call, or finish.' },
      { role: 'assistant', toolCalls: [{ name: 'read_file', args: { path: 'work/test_mul.py' } }] },
      { role: 'tool', name: 'read_file', content: 'from .mul import mul\n' },
    ]);
    expect(assessReviewEvidence(reads, required).sufficient).toBe(true);
    expect(completionFor({
      verdict: 'APPROVE',
      requiredMissing: false,
      requiredFailed: false,
      testerProducedEvidence: true,
      evidenceMissing: false,
    })).toBe('ACCEPTED');
  });

  test('approval without inspection is not accepted and does not start the debugger', () => {
    const required = requiredReviewPaths({
      changedFiles: ['work/mul.py', 'work/test_mul.py'],
      task: 'Implement work/mul.py and work/test_mul.py.',
      plan: '',
    });
    const listedOnly = reviewReads([
      { role: 'assistant', toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { role: 'tool', name: 'list_dir', content: 'work/\n' },
      { role: 'assistant', content: '{"tool":"read_file","args":{"path":"work/mul.py"}}' },
      { role: 'user', content: '[TOOL RESULT] read_file (ERROR)\nUnknown tool "read_file" for this role.' },
    ]);
    const evidence = assessReviewEvidence(listedOnly, required);
    expect(evidence.sufficient).toBe(false);
    expect(evidence.missing).toEqual(['work/mul.py', 'work/test_mul.py']);
    expect(reviewFollowup({
      verdict: 'APPROVE',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
      evidenceMissing: true,
      evidenceRetriesUsed: 0,
    })).toEqual({ action: 'retry-reviewer', reason: 'evidence' });
    expect(reviewFollowup({
      verdict: 'APPROVE',
      verdictRetriesUsed: 1,
      requiredMissing: false,
      requiredFailed: false,
      testerRetriesUsed: 1,
      reworkUsed: 0,
      reworkLimit: 1,
      testerProducedEvidence: true,
      evidenceMissing: true,
      evidenceRetriesUsed: 1,
    })).toEqual({ action: 'stop', completion: 'REVIEW_EVIDENCE_MISSING' });
  });

  test('a large change set does not require reading every file', () => {
    const required = requiredReviewPaths({
      changedFiles: ['src/a.py', 'src/b.py', 'src/c.py', 'src/d.py', 'tests/test_a.py', 'tests/test_b.py', 'README.md'],
      task: 'Update the src package.',
      plan: '',
    });
    expect(required).toEqual(['tests/test_a.py', 'tests/test_b.py', 'src/a.py']);
  });

  test('a missing plan is not a successful plan, and a rejected write created nothing', () => {
    const delivered = planningDeliverable('PLAN:\n1. Create work/mul.py\n2. Run python3 -m unittest work.test_mul', []);
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.plan).toContain('work/mul.py');
    const missing = planningDeliverable('I created work/mul.py and the tests pass.', [
      { role: 'assistant', content: '{"tool":"write_file","args":{"path":"work/mul.py","content":"x"}}' },
      { role: 'user', content: '[TOOL RESULT] write_file (ERROR)\nUnknown tool "write_file" for this role. Available tools: finish.' },
    ]);
    expect(missing.status).toBe('MISSING');
    expect(missing.plan).toContain('Planning deliverable: MISSING');
    expect(missing.plan).toContain('write_file work/mul.py was rejected');
    expect(missing.plan).toContain('Do not treat the planner\'s claims as created files.');
    const retry = plannerRetryTask('Create work/mul.py. Acceptance command: python3 -m unittest work.test_mul');
    expect(retry).toContain('TASK:');
    expect(retry).toContain('Create work/mul.py');
    expect(retry).toContain('did not create');
    expect(retry).toContain('PLAN:');
  });

  test('a read is counted when the model writes a sentence before the tool JSON', () => {
    const reads = reviewReads([
      { role: 'assistant', content: 'Reading the implementation.\n{"tool":"read_file","args":{"path":"work/mul.py"}}' },
      { role: 'user', content: '[TOOL RESULT] read_file \ndef mul(a, b):\n    return a * b\n' },
    ]);
    expect(assessReviewEvidence(reads, ['work/mul.py'])).toEqual({ sufficient: true, missing: [] });
  });
});

describe('role instructions and the text tool helper', () => {
  test('the planner is told which tools are prohibited and the text helper stays intact', () => {
    const prompt = plannerPrompt({ workspacePath: '/ws', platform: 'linux', tree: 'work/' });
    expect(prompt).toContain('list_dir');
    expect(prompt).toContain('MUST NOT CALL');
    expect(prompt).toContain('PLAN:');
    expect(prompt).toContain('did not create');
    expect(prompt).not.toContain('Inspect before editing');
    const helper = fallbackSystemAddon();
    expect(helper).toContain('{"tool": "<tool_name>", "args": { ... }}');
  });

  test('the tester must execute independently and the reviewer must emit a verdict', () => {
    const tester = testerPrompt({ workspacePath: '/ws', platform: 'linux' });
    expect(tester).toContain('Do not rewrite application files');
    expect(tester).toContain('not evidence');
    expect(tester).toContain('NOT_TESTED');
    const reviewer = reviewerPrompt({ workspacePath: '/ws', platform: 'linux' });
    expect(reviewer).toContain('VERDICT: APPROVE');
    expect(reviewer).toContain('VERDICT: REQUEST_CHANGES');
    expect(reviewer).toContain('VERDICT: BLOCKED');
    expect(reviewer).toContain('cannot run commands');
    expect(reviewer).toContain('read_file');
    expect(reviewer).toContain('not accepted');
  });

  test('an unavailable tool is rejected with the role catalog, not the global catalog', async () => {
    const events: any[] = [];
    const runner = new AgentRunner({
      companion: {
        async chat(opts: any) {
          opts.onChunk?.({ t: 'text', v: '{"tool":"list_dir","args":{"path":"."}}' });
          return { text: '', end: { t: 'end', toolCalls: [] } };
        },
      } as any,
      workspaceId: 'ws',
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:12450/v1' },
      model: 'Bryce-ALS-Q4_K_M',
      liveContextTokens: 16384,
      systemPrompt: 'planner',
      task: 'Plan the work.',
      tools: toolsByNames(['finish']),
      toolProtocol: 'text',
      maxTurns: 1,
      onEvent: (event) => events.push(event),
    });
    await runner.run();
    const blocked = events.find((event) => event.type === 'tool_end' && event.entry?.tool === 'list_dir');
    expect(blocked.entry.status).toBe('error');
    expect(blocked.entry.output).toContain('Available tools: finish');
    expect(blocked.entry.output).not.toContain('run_command');
  });
});
