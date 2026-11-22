// Objective acceptance for software collaborations. This is separate from the
// reviewer's own VERDICT line: that text is preserved and never rewritten.

export type ObjectiveStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT TESTED' | 'NOT_APPLICABLE';

export interface TestEvidence {
  command: string;
  exitCode: number | null;
  output: string;
  files: string[];
  at: number;
  machine: string;
  runId: string;
  revision: string | null;
  tool: string;
}

export interface ObjectiveAcceptance {
  status: ObjectiveStatus;
  reason: string;
  reviewerVerdict: string;
  evidence: TestEvidence[];
}

const TEST_TOOLS = new Set(['run_tests', 'run_command', 'run_build']);

export function collaborationRequiresExecution(stages: string[] | undefined): boolean {
  if (!stages || stages.length === 0) return true;
  return stages.some((stage) => stage === 'coder' || stage === 'tester' || stage === 'debugger');
}

function currentEvidence(evidence: TestEvidence[], runId: string, revision: string | null): TestEvidence[] {
  return evidence.filter((item) => {
    if (item.runId !== runId) return false;
    if (!TEST_TOOLS.has(item.tool)) return false;
    if (revision == null) return item.revision == null;
    return item.revision === revision;
  });
}

function substantiveOutput(output: string): boolean {
  return output
    .split('\n')
    .filter((line) => !/^\$ /.test(line) && !/^exit code:/.test(line) && !/^duration:/.test(line) && !/^cwd:/.test(line) && !/^workspace revision:/.test(line))
    .join('\n')
    .trim().length > 0;
}

export function evaluateObjectiveAcceptance(input: {
  applicable: boolean;
  reviewerVerdict: string;
  evidence: TestEvidence[];
  runId: string;
  revision: string | null;
}): ObjectiveAcceptance {
  const reviewerVerdict = input.reviewerVerdict;
  if (!input.applicable) {
    return {
      status: 'NOT_APPLICABLE',
      reason: 'This collaboration does not produce an executable artifact, so test execution is not required.',
      reviewerVerdict,
      evidence: [],
    };
  }
  const evidence = currentEvidence(input.evidence, input.runId, input.revision);
  if (evidence.length === 0) {
    return {
      status: 'NOT TESTED',
      reason: 'No test command was executed for this collaboration run and workspace revision.',
      reviewerVerdict,
      evidence,
    };
  }
  const failed = evidence.filter((item) => item.exitCode !== 0);
  if (failed.length > 0) {
    const first = failed[0];
    return {
      status: 'FAIL',
      reason: `${first.command} exited ${first.exitCode ?? 'without a code'} on ${first.machine}.`,
      reviewerVerdict,
      evidence,
    };
  }
  const skipped = evidence.filter((item) => /\b(skipped|no tests|not executed)\b/i.test(item.output) && !/\backnowledg/i.test(item.output));
  const passed = evidence.some((item) => /\b[1-9]\d*\s+(pass|passed|passing)\b/i.test(item.output) || /\bok\s+\d+\b/i.test(item.output));
  if (skipped.length > 0 && !passed) {
    return {
      status: 'INCOMPLETE',
      reason: 'Tests were skipped without an explicit acknowledgment.',
      reviewerVerdict,
      evidence,
    };
  }
  if (!evidence.some((item) => substantiveOutput(item.output || ''))) {
    return {
      status: 'INCOMPLETE',
      reason: 'A command reported success without any captured output to check.',
      reviewerVerdict,
      evidence,
    };
  }
  return {
    status: 'PASS',
    reason: `${evidence.length} test command${evidence.length === 1 ? '' : 's'} completed with captured output.`,
    reviewerVerdict,
    evidence,
  };
}
