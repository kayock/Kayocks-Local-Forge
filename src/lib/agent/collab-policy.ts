// Collaboration outcomes. A process that returns is not the same thing as an
// accepted development task. A missing reviewer verdict is not a request
// for changes.
import { detectToolDialect } from './dialects';

export type ReviewerVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'BLOCKED' | 'UNKNOWN';

export type CollaborationCompletion =
  | 'ACCEPTED'
  | 'CHANGES_REQUESTED'
  | 'VERDICT_MISSING'
  | 'REVIEW_EVIDENCE_MISSING'
  | 'TESTS_FAILED'
  | 'NOT_TESTED'
  | 'BLOCKED'
  | 'PAUSED'
  | 'INCOMPLETE';

export type PlanningStatus = 'DELIVERED' | 'MISSING';

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
  // Approval without a successful read of the relevant files. Defaults keep
  // older callers on the previous path.
  evidenceMissing?: boolean;
  evidenceRetriesUsed?: number;
}

export type Followup =
  | { action: 'retry-tester' }
  | { action: 'retry-reviewer'; reason: 'verdict' | 'evidence' }
  | { action: 'debugger'; reason: 'acceptance-failed' | 'request-changes' }
  | { action: 'stop'; completion: CollaborationCompletion };

export function reviewFollowup(input: FollowupInput): Followup {
  const evidenceMissing = input.evidenceMissing === true;
  const evidenceRetriesUsed = input.evidenceRetriesUsed ?? 1;
  if (input.requiredMissing && input.testerRetriesUsed < 1) return { action: 'retry-tester' };
  if (input.verdict === 'UNKNOWN' && input.verdictRetriesUsed < 1) return { action: 'retry-reviewer', reason: 'verdict' };
  if (input.verdict === 'APPROVE' && evidenceMissing && evidenceRetriesUsed < 1) return { action: 'retry-reviewer', reason: 'evidence' };
  const canRework = input.reworkUsed < input.reworkLimit;
  if (input.requiredFailed && canRework) return { action: 'debugger', reason: 'acceptance-failed' };
  if (input.verdict === 'REQUEST_CHANGES' && canRework) return { action: 'debugger', reason: 'request-changes' };
  return { action: 'stop', completion: completionFor(input) };
}

export function completionFor(input: Pick<FollowupInput, 'verdict' | 'requiredMissing' | 'requiredFailed' | 'testerProducedEvidence' | 'evidenceMissing'>): CollaborationCompletion {
  if (input.verdict === 'BLOCKED') return 'BLOCKED';
  if (input.requiredFailed) return 'TESTS_FAILED';
  if (input.requiredMissing || (input.verdict === 'APPROVE' && !input.testerProducedEvidence)) return 'NOT_TESTED';
  if (input.verdict === 'UNKNOWN') return 'VERDICT_MISSING';
  if (input.verdict === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
  if (input.verdict === 'APPROVE' && input.evidenceMissing) return 'REVIEW_EVIDENCE_MISSING';
  if (input.verdict === 'APPROVE' && input.testerProducedEvidence) return 'ACCEPTED';
  return 'INCOMPLETE';
}

const SOURCE_FILE = /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|toml|json|ya?ml|md|txt|css|html)$/i;

export function normalizeReviewPath(path: string): string {
  return String(path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function pathCovers(actual: string, required: string): boolean {
  const read = normalizeReviewPath(actual);
  const want = normalizeReviewPath(required);
  if (!read || !want) return false;
  return read === want || read.endsWith('/' + want) || want.endsWith('/' + read);
}

export function pathsNamedInText(text: string): string[] {
  const found: string[] = [];
  const re = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|toml|json|ya?ml|md|txt|css|html))\b/gi;
  for (const match of text.matchAll(re)) {
    const path = normalizeReviewPath(match[1]);
    if (path && !found.includes(path)) found.push(path);
  }
  return found;
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) if (path && !out.includes(path)) out.push(path);
  return out;
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)tests?\//i.test(path) || /(?:^|\/)test_[^/]+$/i.test(path) || /\.(?:test|spec)\.[^/]+$/i.test(path) || /_test\.[^/]+$/i.test(path);
}

// A large tree is not the review scope. Three or fewer relevant files must
// all be read. Beyond that, the requirement is the tests plus one
// implementation file from the files this task actually changed.
function capReviewPaths(paths: string[]): string[] {
  if (paths.length <= 3) return paths;
  const tests = paths.filter(isTestPath);
  const impl = paths.filter((path) => !tests.includes(path));
  const picked = uniquePaths([...tests.slice(0, 2), ...impl.slice(0, 1)]);
  return picked.length ? picked : paths.slice(0, 3);
}

export function requiredReviewPaths(input: { changedFiles: string[]; task: string; plan: string }): string[] {
  const changed = uniquePaths(input.changedFiles.map(normalizeReviewPath).filter((path) => SOURCE_FILE.test(path)));
  const named = uniquePaths([...pathsNamedInText(input.task), ...pathsNamedInText(input.plan)]);
  let relevant = changed;
  if (changed.length && named.length) {
    const overlap = changed.filter((path) => named.some((name) => pathCovers(path, name)));
    if (overlap.length) relevant = overlap;
  } else if (!changed.length) relevant = named;
  return capReviewPaths(relevant);
}

export interface TranscriptMessage {
  role?: string;
  content?: string;
  name?: string;
  toolCalls?: { name?: string; args?: Record<string, unknown> | string | null }[];
}

const READ_ALIASES = new Set(['read_file', 'cat', 'open_file', 'view_file', 'view']);

function argPath(args: Record<string, unknown> | string | null | undefined): string {
  if (!args || typeof args !== 'object') return '';
  const value = args.path ?? args.file ?? args.filepath ?? args.file_path;
  return typeof value === 'string' ? value.trim() : '';
}

function callsFromAssistant(message: TranscriptMessage): { name: string; path: string }[] {
  if (message.role !== 'assistant') return [];
  if (message.toolCalls?.length) {
    return message.toolCalls.map((call) => ({ name: String(call.name || ''), path: argPath(call.args) }));
  }
  // The runner executes a tool call that is embedded after a sentence. Evidence
  // uses that same detection, so a genuine read is not dropped for a preamble.
  const parsed = detectToolDialect(String(message.content || ''));
  if (!parsed) return [];
  return [{ name: parsed.action.tool, path: argPath(parsed.action.args) }];
}

export function toolResultFailed(content: string): boolean {
  const header = content.slice(0, 160);
  const body = content.replace(/^\[TOOL RESULT\][^\n]*\n/, '').trim();
  const head = body.slice(0, 240);
  return /\(ERROR\)/.test(header)
    || /^Unknown tool\b/.test(head)
    || /^MISSING:/.test(head)
    || /^Error reading\b/.test(head)
    || /^Error:/.test(head)
    || /^CONFLICT:/.test(head);
}

function matchingResult(messages: TranscriptMessage[], start: number, tool: string): { index: number; content: string } | null {
  for (let i = start; i < Math.min(messages.length, start + 4); i++) {
    const message = messages[i];
    const content = String(message.content || '');
    if (message.role === 'tool' && (!message.name || message.name === tool)) return { index: i, content };
    if (message.role === 'user' && new RegExp(`\\[TOOL RESULT\\]\\s*${tool}\\b`).test(content)) return { index: i, content };
  }
  return null;
}

export function reviewReads(messages: TranscriptMessage[]): { path: string; ok: boolean }[] {
  const reads: { path: string; ok: boolean }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const calls = callsFromAssistant(messages[i]).filter((call) => READ_ALIASES.has(call.name));
    let cursor = i + 1;
    for (const call of calls) {
      const result = matchingResult(messages, cursor, 'read_file') || matchingResult(messages, cursor, call.name);
      const ok = !!result && !toolResultFailed(result.content) && result.content.trim().length > 0;
      if (call.path) reads.push({ path: call.path, ok });
      if (result) cursor = result.index + 1;
    }
  }
  return reads;
}

export function assessReviewEvidence(reads: { path: string; ok: boolean }[], required: string[]): { sufficient: boolean; missing: string[] } {
  const okReads = reads.filter((read) => read.ok);
  if (!required.length) {
    const anySource = okReads.some((read) => SOURCE_FILE.test(normalizeReviewPath(read.path)));
    return { sufficient: anySource, missing: anySource ? [] : ['a source or test file from this task'] };
  }
  const missing = required.filter((path) => !okReads.some((read) => pathCovers(read.path, path)));
  return { sufficient: missing.length === 0, missing };
}

const PLANNER_CLAIM_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_path', 'rename_path', 'mkdir', 'run_command', 'run_tests', 'list_dir', 'read_file', 'workspace_info']);

export function plannerRejectionNotes(messages: TranscriptMessage[]): string[] {
  const notes: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    for (const call of callsFromAssistant(messages[i])) {
      if (!PLANNER_CLAIM_TOOLS.has(call.name)) continue;
      const result = matchingResult(messages, i + 1, call.name);
      if (result && !toolResultFailed(result.content)) continue;
      const where = call.path ? ` ${call.path}` : '';
      notes.push(`${call.name}${where} was rejected and did not change the workspace.`);
    }
  }
  return notes;
}

export function planningDeliverable(summary: string, messages: TranscriptMessage[]): { status: PlanningStatus; plan: string } {
  const idx = summary.lastIndexOf('PLAN:');
  const plan = idx >= 0 ? summary.slice(idx + 'PLAN:'.length).trim() : '';
  const notes = plannerRejectionNotes(messages);
  const rejection = notes.length
    ? `Planner tool calls that did not change the workspace:\n${notes.map((note) => `- ${note}`).join('\n')}\nDo not treat the planner's claims as created files.`
    : '';
  if (!plan) {
    return {
      status: 'MISSING',
      plan: ['No PLAN section was produced. Planning deliverable: MISSING.', 'The planner did not create implementation files.', rejection].filter(Boolean).join('\n'),
    };
  }
  return { status: 'DELIVERED', plan: [plan, rejection].filter(Boolean).join('\n\n') };
}

// The retry still has to carry the task. A prompt that only says "add PLAN:"
// lets the model answer that no task was provided.
export function plannerRetryTask(task: string): string {
  return [
    'Your previous reply had no PLAN: section, so planning is not complete.',
    'A rejected tool call did not create or change any file. Do not claim that a file exists.',
    'Call finish. The summary must contain a section titled PLAN: with numbered steps and the exact acceptance command.',
    'Do not call write_file, edit_file, list_dir, or run_command.',
    '',
    'TASK:',
    String(task || '').trim(),
  ].join('\n');
}
