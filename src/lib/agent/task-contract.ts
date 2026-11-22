// TaskContract — the coordinator-owned, persistent task specification
// (Forge upgrade — Problem C).
//
// The calculator failure ("graphical scientific calculator with number base
// converter" delivered as a four-operation CLI calculator) happened because
// nothing in the system carried the original requirements across turns, model
// switches, compaction and resume. This module owns the contract:
//
//  - created/updated by the coordinator (IDE or pipeline), NOT by the model;
//  - requirements are append-only for models: a model may add progress notes
//    and PROPOSE changes, but never silently erase or weaken a requirement —
//    proposals are recorded and wait for the user;
//  - the latest explicit user steering always takes precedence;
//  - serialized to JSON so it survives model switches, handoffs, compaction,
//    interrupted runs and continue/resume;
//  - re-injected verbatim into every new turn context — never summarized away.
import type { EvidenceRecord } from './types';

export interface Requirement {
  id: string;
  text: string;
  source: 'user' | 'derived';        // derived = planner/model refinement, non-authoritative
  addedAt: number;
  status: 'open' | 'done' | 'blocked' | 'waived';
  statusBy?: 'model' | 'user' | 'gate';
  note?: string;
}

export interface RequirementProposal {
  id: string;
  requirementId?: string;             // change to existing, or new requirement
  action: 'add' | 'modify' | 'remove' | 'weaken';
  proposedText?: string;
  reason: string;
  at: number;
  resolved?: boolean;
}

export interface SteeringNote {
  text: string;
  at: number;
  appliedAt?: number;                 // injected into the agent loop
}

export interface ContractProgress {
  text: string;
  at: number;
  by: string;                         // stage/model id or 'coordinator'
  filesTouched?: string[];
}

export interface TaskContract {
  id: string;
  originalRequest: string;            // verbatim — never paraphrased
  requirements: Requirement[];
  constraints: string[];
  acceptanceCriteria: string[];
  progress: ContractProgress[];
  evidence: EvidenceRecord[];
  openProblems: string[];
  workspace: { workspaceId: string | null; path: string; machineLabel: string };
  steering: SteeringNote[];
  proposals: RequirementProposal[];
  status: 'ACTIVE' | 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'UNVERIFIED';
  statusNote?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

let contractSeq = 0;
const genId = (p: string) => `${p}_${Date.now().toString(36)}_${++contractSeq}`;

export function createContract(originalRequest: string, workspace: TaskContract['workspace'], opts?: {
  constraints?: string[];
  acceptanceCriteria?: string[];
}): TaskContract {
  return {
    id: genId('tc'),
    originalRequest,
    requirements: requirementsFromRequest(originalRequest),
    constraints: opts?.constraints ?? [],
    acceptanceCriteria: opts?.acceptanceCriteria ?? [],
    progress: [],
    evidence: [],
    openProblems: [],
    workspace,
    steering: [],
    proposals: [],
    status: 'ACTIVE',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
}

// Seed requirements from the request when the user did not enumerate them:
// split on numbered/bulleted lines or "and"-joined feature clauses. Derived
// requirements are marked non-authoritative; the original request itself
// remains the ground truth regardless.
export function requirementsFromRequest(request: string): Requirement[] {
  const lines = request.split('\n').map((l) => l.trim()).filter(Boolean);
  const enumerated = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  const mk = (text: string, source: 'user' | 'derived'): Requirement => ({
    id: genId('req'),
    text: text.replace(/^([-*•]|\d+[.)])\s+/, '').trim(),
    source,
    addedAt: Date.now(),
    status: 'open',
  });
  if (enumerated.length >= 2) return enumerated.map((l) => mk(l, 'user'));
  return [mk(request, 'user')];
}

// ---- coordinator operations (user-side) ----

export function addRequirement(c: TaskContract, text: string, source: 'user' | 'derived' = 'user'): TaskContract {
  return bump({ ...c, requirements: [...c.requirements, mkReq(text, source)] });
}
export function addSteering(c: TaskContract, text: string): TaskContract {
  return bump({ ...c, steering: [...c.steering, { text, at: Date.now() }] });
}
export function markSteeringApplied(c: TaskContract, idx: number): TaskContract {
  const steering = c.steering.map((s, i) => (i === idx ? { ...s, appliedAt: Date.now() } : s));
  return bump({ ...c, steering });
}
export function waiveRequirement(c: TaskContract, id: string, note?: string): TaskContract {
  const requirements = c.requirements.map((r) => (r.id === id ? { ...r, status: 'waived' as const, statusBy: 'user' as const, note: note ?? r.note } : r));
  return bump({ ...c, requirements });
}
export function setOpenProblems(c: TaskContract, problems: string[]): TaskContract {
  return bump({ ...c, openProblems: problems.slice(0, 20) });
}
export function setStatus(c: TaskContract, status: TaskContract['status'], note?: string): TaskContract {
  return bump({ ...c, status, statusNote: note });
}

function mkReq(text: string, source: 'user' | 'derived'): Requirement {
  return { id: genId('req'), text, source, addedAt: Date.now(), status: 'open' };
}
function bump(c: TaskContract): TaskContract {
  return { ...c, updatedAt: Date.now(), version: c.version + 1 };
}

// In-place mutation for the coordinator/runner, which HOLDS the live contract
// object (IdeView keeps contractRef and persists on onContractUpdate). Bumps
// version/updatedAt and returns the SAME object so references stay valid.
export function bumpInPlace(c: TaskContract): TaskContract {
  c.updatedAt = Date.now();
  c.version = c.version + 1;
  return c;
}

// ---- model-side operations (limited by design) ----

// Models record progress and evidence, and PROPOSE requirement changes.
// Proposals never modify requirements — only the user (or the gate applying
// the recorded rules) does. This is the "must not silently erase or weaken
// user requirements" rule.
export function recordProgress(c: TaskContract, text: string, by: string, filesTouched?: string[]): TaskContract {
  return bump({ ...c, progress: [...c.progress.slice(-49), { text, at: Date.now(), by, filesTouched }] });
}
export function addEvidence(c: TaskContract, evidence: EvidenceRecord): TaskContract {
  return bump({ ...c, evidence: [...c.evidence.slice(-99), evidence] });
}
export function addProposal(c: TaskContract, p: Omit<RequirementProposal, 'id' | 'at' | 'resolved'>): TaskContract {
  return bump({ ...c, proposals: [...c.proposals, { ...p, id: genId('prop'), at: Date.now(), resolved: false }] });
}
export function resolveProposal(c: TaskContract, id: string): TaskContract {
  return bump({ ...c, proposals: c.proposals.map((p) => (p.id === id ? { ...p, resolved: true } : p)) });
}
// Tester/reviewer may mark derived (non-authoritative) requirement status;
// user-sourced requirements are only marked done by the completion gate.
export function markRequirementStatus(c: TaskContract, id: string, status: Requirement['status'], by: 'model' | 'user' | 'gate', note?: string): TaskContract {
  const requirements = c.requirements.map((r) => {
    if (r.id !== id) return r;
    if (r.source === 'user' && by === 'model' && status === 'done') {
      // a model may not declare a user requirement done — the gate decides
      return { ...r, note: note ? `${r.note ?? ''} [model claims done — pending verification]` : r.note };
    }
    return { ...r, status, statusBy: by, note: note ?? r.note };
  });
  return bump({ ...c, requirements });
}

// ---- persistence (localStorage-safe JSON; also used by node/e2e with a Map) ----

const KEY = 'localforge-contracts-v1';
type ContractStore = Record<string, TaskContract>; // key = projectId or contract id

export function loadContracts(storage: Pick<Storage, 'getItem' | 'setItem'> | null): ContractStore {
  if (!storage) return {};
  try {
    return JSON.parse(storage.getItem(KEY) || '{}') as ContractStore;
  } catch {
    return {};
  }
}
export function saveContract(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key: string, contract: TaskContract): void {
  if (!storage) return;
  try {
    const all = loadContracts(storage);
    all[key] = contract;
    // keep the store bounded: last 40 contracts
    const keys = Object.keys(all);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    storage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage full/unavailable — contract still lives in memory */ }
}

// ---- prompt injection ----

// Rendered verbatim into the system/task prompt of EVERY model that touches
// the task — planner, coder, tester, reviewer, replacement model after a
// switch. Requirements are quoted, never summarized.
export function contractPromptBlock(c: TaskContract, opts?: { role?: string }): string {
  const lines: string[] = [];
  lines.push('=== TASK CONTRACT (coordinator-owned; read carefully) ===');
  lines.push(`Original user request (VERBATIM — do not reinterpret or shrink it):`);
  lines.push(`"""${c.originalRequest}"""`);
  if (c.requirements.length) {
    lines.push('Requirements:');
    for (const r of c.requirements) {
      const flag = r.source === 'derived' ? ' (derived — non-authoritative)' : '';
      const st = r.status !== 'open' ? ` [${r.status}${r.statusBy ? ` by ${r.statusBy}` : ''}]` : '';
      lines.push(`- ${r.text}${flag}${st}`);
    }
  }
  if (c.constraints.length) lines.push(`Constraints:\n${c.constraints.map((s) => `- ${s}`).join('\n')}`);
  if (c.acceptanceCriteria.length) lines.push(`Acceptance criteria (all must be verifiable to declare COMPLETE):\n${c.acceptanceCriteria.map((s) => `- ${s}`).join('\n')}`);
  if (c.progress.length) {
    lines.push('Progress so far:');
    for (const p of c.progress.slice(-8)) lines.push(`- ${new Date(p.at).toISOString().slice(11, 19)} ${p.by}: ${p.text}`);
  }
  if (c.openProblems.length) lines.push(`Open problems:\n${c.openProblems.map((s) => `- ${s}`).join('\n')}`);
  const pendingSteering = c.steering.filter((s) => !s.appliedAt);
  if (pendingSteering.length) {
    lines.push(`LATEST USER STEERING (HIGHEST PRIORITY — overrides older instructions):
${pendingSteering.map((s) => `- ${s.text}`).join('\n')}`);
  }
  if (c.proposals.some((p) => !p.resolved)) {
    lines.push('Pending requirement proposals (awaiting the user — do NOT act on them as if approved):');
    for (const p of c.proposals) if (!p.resolved) lines.push(`- [${p.action}] ${p.proposedText ?? '(see requirement)'} — ${p.reason}`);
  }
  lines.push(`Workspace: ${c.workspace.path || '(unresolved)'} on ${c.workspace.machineLabel}.`);
  lines.push('Rules: every requirement above stays in force until the user waives it. Declaring success without satisfying them and running the verification commands is a task failure. If a requirement cannot be met, say so plainly and keep status PARTIAL/BLOCKED — never claim COMPLETE.');
  if (opts?.role) lines.push(`Your role in this contract: ${opts.role}.`);
  return lines.join('\n');
}

// ---- Problem E: handoff packet ----

export interface HandoffState {
  fromModel: string;
  toModel?: string;
  filesTouched: string[];
  testsRun: { command: string; exitCode: number | null; passed: boolean }[];
  blockers: string[];
  lastSuccessfulOperation: string;
  remainingWork: string[];
  recentConversation?: { role: string; content: string }[];
  toolResults?: string[];
}

// A concise, accurate handoff for a replacement model. The contract block is
// included VERBATIM (never substituted by a generic summary); the state below
// is factual, extracted from the run journal, not from the model's claims.
export function buildHandoffPacket(c: TaskContract, state: HandoffState): string {
  const lines: string[] = [];
  lines.push('=== MODEL HANDOFF — READ THIS FIRST ===');
  if (state.toModel) lines.push(`You are replacing ${state.fromModel || 'the previous model'}${state.toModel ? ` with ${state.toModel}` : ''} on an in-progress task. Nothing below is optional context.`);
  lines.push(contractPromptBlock(c, { role: 'continue the work exactly where it stopped' }));
  lines.push('--- Verified run state (coordinator journal, not model claims) ---');
  if (state.filesTouched.length) lines.push(`Files created/modified (observed): ${state.filesTouched.join(', ')}`);
  else lines.push('Files created/modified (observed): none yet');
  if (state.testsRun.length) {
    lines.push('Tests already executed:');
    for (const t of state.testsRun) lines.push(`- ${t.command} → exit ${t.exitCode}${t.passed ? ' (passed)' : ' (FAILED)'}`);
  } else lines.push('Tests already executed: NONE — verification is still owed.');
  if (state.lastSuccessfulOperation) lines.push(`Last successful operation: ${state.lastSuccessfulOperation}`);
  if (state.blockers.length) lines.push(`Current blockers:\n${state.blockers.map((b) => `- ${b}`).join('\n')}`);
  if (state.remainingWork.length) lines.push(`Remaining work (from the contract):\n${state.remainingWork.map((r) => `- ${r}`).join('\n')}`);
  if (state.toolResults?.length) {
    lines.push('Relevant recent tool results:');
    for (const t of state.toolResults.slice(-5)) lines.push(`- ${t.slice(0, 300)}`);
  }
  if (state.recentConversation?.length) {
    lines.push('Recent conversation tail:');
    for (const m of state.recentConversation.slice(-6)) lines.push(`  [${m.role}] ${m.content.slice(0, 200)}`);
  }
  lines.push('Continue the task from exactly where it stopped. Do not redo verified work. Do not declare COMPLETE unless every acceptance criterion above has captured evidence.');
  return lines.join('\n');
}
