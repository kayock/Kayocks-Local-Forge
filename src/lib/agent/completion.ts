// Evidence-gated completion (Forge upgrade — Problem D).
//
// The calculator agent claimed success after verifying only CLI arithmetic.
// This module makes that impossible: a task is COMPLETE only when the
// coordinator holds captured evidence for every requirement and acceptance
// criterion — files that genuinely exist, tests that actually ran and passed,
// browser verification when GUI/browser functionality is in scope. A model's
// self-reported success ("finish") never satisfies the gate by itself.
//
// Statuses: COMPLETE | PARTIAL | BLOCKED | FAILED | UNVERIFIED.
//   FAILED   — verification was executed and failed
//   BLOCKED  — a recorded blocker prevents finishing the work
//   UNVERIFIED — work exists but the needed verification is unavailable
//                (e.g. no browser for a GUI task); never treated as COMPLETE
//   PARTIAL  — some requirements lack sufficient evidence
//   COMPLETE — every user requirement has evidence and nothing failed
import type { CompletionResult, EvidenceRecord, CompletionStatus } from './types';
import type { TaskContract } from './task-contract';

export interface GateInput {
  contract: TaskContract;
  // filesystem reality check, collected by the runner from the actual
  // workspace (not from model claims)
  filesCheck: { path: string; exists: boolean }[];
  // commands that ran as verification, from the tool journal
  testsRun: { command: string; exitCode: number | null; passed: boolean; summary?: string }[];
  // browser verification state (Part 6); 'untested' = not applicable/attempted
  browserEvidence: 'verified' | 'unavailable' | 'untested';
  finishSummary?: string;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'with', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'that', 'is', 'are', 'be', 'should', 'must', 'it', 'as', 'by', 'from', 'when', 'which', 'use', 'using']);
const GUI_HINTS = /\b(gui|graphical|browser|web|page|html|interface|ui|window|frontend|dashboard)\b/i;

function salientWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s./-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function overlap(a: string, b: string): number {
  const wa = new Set(salientWords(a));
  const wb = new Set(salientWords(b));
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) {
    if (wb.has(w)) hit++;
    else {
      for (const x of wb) if (x.length > 3 && (w.includes(x) || x.includes(w))) { hit++; break; }
    }
  }
  return hit / wa.size;
}

export function evaluateCompletion(input: GateInput): CompletionResult {
  const { contract: c, filesCheck, testsRun, browserEvidence } = input;
  const reasons: string[] = [];
  const missing: string[] = [];
  const evidence: EvidenceRecord[] = [...c.evidence];

  // 0) user override already applied → report it as-is (records kept intact)
  if (c.status === 'COMPLETE' && c.statusNote?.startsWith('overridden')) {
    return { status: 'COMPLETE', missingCriteria: [], reasons: ['Status overridden by the user (recorded; verification evidence is unchanged).'], evidence, overriddenByUser: true, overrideNote: c.statusNote };
  }

  const activeReqs = c.requirements.filter((r) => r.source === 'user' && r.status !== 'waived');

  // 1) verification actually executed and failed → FAILED dominates
  const failedTests = testsRun.filter((t) => !t.passed);
  if (failedTests.length) {
    for (const t of failedTests) reasons.push(`Verification FAILED: ${t.command} exited ${t.exitCode ?? '?'}.`);
  }

  // 2) recorded blockers → BLOCKED
  const blockerReqs = activeReqs.filter((r) => r.status === 'blocked');
  if (blockerReqs.length) {
    for (const r of blockerReqs) reasons.push(`Requirement blocked: ${r.text}${r.note ? ` — ${r.note}` : ''}`);
  }

  // 3) evidence accounting per user requirement
  const evidenceTexts = evidence.map((e) => e.detail);
  const unaccounted: string[] = [];
  for (const r of activeReqs) {
    const best = Math.max(
      overlap(r.text, input.finishSummary || ''),
      ...evidenceTexts.map((t) => overlap(r.text, t)),
    );
    if (best >= 0.5) continue;
    unaccounted.push(r.text);
  }
  for (const u of unaccounted) missing.push(`No sufficient evidence that requirement is met: "${u}"`);

  // 4) files genuinely exist on disk
  const missingFiles = filesCheck.filter((f) => !f.exists);
  for (const f of missingFiles) {
    missing.push(`File claimed/expected but missing on disk: ${f.path}`);
    reasons.push(`File "${f.path}" does not exist in the workspace.`);
  }

  // 5) no verification at all → cannot be COMPLETE
  if (!testsRun.length) {
    reasons.push('No verification command was ever executed — self-reported success is not verification.');
  }

  // 6) GUI/browser functionality in scope but not verified in a browser
  const scope = `${c.originalRequest}\n${c.requirements.map((r) => r.text).join('\n')}\n${c.acceptanceCriteria.join('\n')}`;
  const guiInScope = GUI_HINTS.test(scope);
  if (guiInScope && browserEvidence === 'unavailable') {
    missing.push('Browser verification for GUI functionality: UNAVAILABLE — task cannot be COMPLETE without it.');
    reasons.push('GUI/browser functionality is in scope but no browser could be launched. Recorded as UNVERIFIED, not passed.');
  } else if (guiInScope && browserEvidence !== 'verified' && testsRun.length) {
    missing.push('Browser verification for GUI functionality has not been captured.');
    reasons.push('GUI/browser functionality is in scope; open the app with the browser verification tools and record evidence before declaring COMPLETE.');
  }

  // 7) status decision — FAILED/BLOCKED dominate, then UNVERIFIED, PARTIAL, COMPLETE
  let status: CompletionStatus;
  if (failedTests.length || missingFiles.length) status = 'FAILED';
  else if (blockerReqs.length || c.openProblems.length) status = 'BLOCKED';
  else if (!testsRun.length || (guiInScope && browserEvidence !== 'verified')) status = 'UNVERIFIED';
  else if (missing.length) status = 'PARTIAL';
  else status = 'COMPLETE';

  if (status === 'COMPLETE') reasons.unshift('All requirements accounted with captured evidence; verification passed.');
  return { status, missingCriteria: missing, reasons, evidence };
}

// Acceptance criteria suggested from a request, used when the user did not
// enumerate any. Derived, non-authoritative: the gate checks them as helpers,
// user requirements remain the authority.
export function deriveAcceptanceCriteria(request: string): string[] {
  const reqs = request.split('\n').map((l) => l.trim()).filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  const out: string[] = [];
  for (const r of reqs) out.push(`Requirement implemented: ${r.replace(/^([-*•]|\d+[.)])\s+/, '')}`);
  out.push('Relevant build/test/verification command executed with exit code 0 and output captured.');
  if (GUI_HINTS.test(request)) out.push('GUI opens and is exercised in a real browser with console errors captured (when a browser is available).');
  return out;
}
