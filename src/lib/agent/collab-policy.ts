// Collaboration outcomes. A process that returns is not the same thing as an
// accepted development task. A missing reviewer verdict is not a request
// for changes.

export type ReviewerVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'BLOCKED' | 'UNKNOWN';

export type CollaborationCompletion =
  | 'ACCEPTED'
  | 'CHANGES_REQUESTED'
  | 'VERDICT_MISSING'
  | 'TESTS_FAILED'
  | 'NOT_TESTED'
  | 'BLOCKED'
  | 'PAUSED'
  | 'INCOMPLETE';

export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const lines = text.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCKED)\b/gi) || [];
  if (!lines.length) return 'UNKNOWN';
  const last = lines[lines.length - 1].replace(/^VERDICT:\s*/i, '').toUpperCase();
  if (last.startsWith('APPROVE')) return 'APPROVE';
  if (last.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (last.startsWith('BLOCKED')) return 'BLOCKED';
  return 'UNKNOWN';
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/g, '');
}

export function commandsMatch(actual: string, required: string): boolean {
  return normalizeCommand(actual) === normalizeCommand(required);
}

export function extractAcceptanceCommands(task: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    let cmd = String(raw || '').trim().replace(/^`+|`+$/g, '').trim();
    const embedded = cmd.match(/\b((?:python3?|pytest|npm|cargo|go)\s+\S(?:.*\S)?)$/i);
    if (embedded && !/^(?:python3?|pytest|npm|cargo|go)\b/i.test(cmd)) cmd = embedded[1];
    cmd = normalizeCommand(cmd);
    if (!cmd || cmd.length > 240) return;
    if (!/^(?:python3?|pytest|npm|cargo|go)\b/i.test(cmd)) return;
    if (!/\b(unittest|pytest|npm test|npm run test|cargo test|go test)\b/i.test(cmd)) return;
    if (!found.includes(cmd)) found.push(cmd);
  };
  for (const match of task.matchAll(/`([^`\n]+)`/g)) push(match[1]);
  for (const match of task.matchAll(/(?:must run|acceptance command(?: is)?|required command)\s*:?\s*([^\n]+)/gi)) push(match[1]);
  return found;
}

export interface AcceptanceCheck {
  missing: string[];
  failed: { command: string; exitCode: number | null; output: string }[];
  passed: string[];
  substitutes: string[];
}

export function checkAcceptanceCommands(
  evidence: { command: string; exitCode: number | null; output?: string }[],
  required: string[],
): AcceptanceCheck {
  const missing: string[] = [];
  const failed: AcceptanceCheck['failed'] = [];
  const passed: string[] = [];
  for (const command of required) {
    const hits = evidence.filter((item) => commandsMatch(item.command, command));
    if (!hits.length) {
      missing.push(command);
      continue;
    }
    if (hits.some((item) => item.exitCode === 0)) passed.push(command);
    else {
      const last = hits[hits.length - 1];
      failed.push({ command, exitCode: last.exitCode, output: last.output || '' });
    }
  }
  const substitutes = evidence
    .filter((item) => item.exitCode === 0 && !required.some((command) => commandsMatch(item.command, command)))
    .map((item) => item.command);
  return { missing, failed, passed, substitutes };
}

export interface FollowupInput {
  verdict: ReviewerVerdict;
  verdictRetriesUsed: number;
  requiredMissing: boolean;
  requiredFailed: boolean;
  testerRetriesUsed: number;
  reworkUsed: number;
  reworkLimit: number;
  testerProducedEvidence: boolean;
}

export type Followup =
  | { action: 'retry-tester' }
  | { action: 'retry-reviewer' }
  | { action: 'debugger'; reason: 'acceptance-failed' | 'request-changes' }
  | { action: 'stop'; completion: CollaborationCompletion };

export function reviewFollowup(input: FollowupInput): Followup {
  if (input.requiredMissing && input.testerRetriesUsed < 1) return { action: 'retry-tester' };
  if (input.verdict === 'UNKNOWN' && input.verdictRetriesUsed < 1) return { action: 'retry-reviewer' };
  const canRework = input.reworkUsed < input.reworkLimit;
  if (input.requiredFailed && canRework) return { action: 'debugger', reason: 'acceptance-failed' };
  if (input.verdict === 'REQUEST_CHANGES' && canRework) return { action: 'debugger', reason: 'request-changes' };
  return { action: 'stop', completion: completionFor(input) };
}

export function completionFor(input: Pick<FollowupInput, 'verdict' | 'requiredMissing' | 'requiredFailed' | 'testerProducedEvidence'>): CollaborationCompletion {
  if (input.verdict === 'BLOCKED') return 'BLOCKED';
  if (input.requiredFailed) return 'TESTS_FAILED';
  if (input.requiredMissing || (input.verdict === 'APPROVE' && !input.testerProducedEvidence)) return 'NOT_TESTED';
  if (input.verdict === 'UNKNOWN') return 'VERDICT_MISSING';
  if (input.verdict === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
  if (input.verdict === 'APPROVE' && input.testerProducedEvidence) return 'ACCEPTED';
  return 'INCOMPLETE';
}
