// RecoveryCoordinator (Milestone 4) — outcome-aware stall classification and
// a bounded recovery ladder for the AgentRunner.
//
// Extends the existing journal (runner.recentCalls) with:
//  - stall CLASSES based on actual tool evidence, not keyword overlap:
//      'repetition'    — the same canonical call blocked again and again
//      'progress'      — many turns of pure activity (reads/retries), no
//                        writes/verification
//      'verification'  — tests/builds repeatedly failing without new edits
//  - a TWO-STEP recovery ladder per problem, then an honest STOP:
//      1. workspace_refocus  — re-anchor on the authoritative workspace and
//         quote the open requirements verbatim (they are never paraphrased)
//      2. strategy_directive — a concrete alternative strategy derived from
//         the stall class and the last real tool outputs
//      → exhausted: the run STOPS with a stalled verdict (never endless
//         inference), the contract records BLOCKED + open problems, and the
//         IDE can resume/steer/switch models from the preserved history.
//  - validation-failure streaks (schema-invalid calls) trigger recovery once
//    per streak and escalate to the coordinator (onEscalation).
//  - automatic steering: evidence-triggered guidance (truncated large edits,
//    stuck validation) delivered at a safe boundary — never interleaved with
//    manual steering, rate-limited once per trigger, disableable.
//
// All envelopes are deduplicated per call signature: a signature gets at most
// one recovery envelope per ladder step.
import type { TaskContract } from './task-contract';

export type StallClass = 'repetition' | 'progress' | 'verification';
export type RecoveryAction = 'workspace_refocus' | 'strategy_directive';
export type AutoSteeringTrigger = 'truncated-edit' | 'stuck';

export interface RecoveryEvent {
  kind: 'recovery_action' | 'stalled' | 'auto_steering' | 'streak_recovery';
  action?: RecoveryAction;
  trigger?: AutoSteeringTrigger;
  stallClass?: StallClass;
  signature?: string;
  step?: 1 | 2;
  message: string;
}

export interface RecoveryEnvelope {
  text: string;
  header: string; // first line, for dedup bookkeeping
}

export interface RecoveryDeps {
  contract?: TaskContract;
  onEvent: (e: RecoveryEvent) => void;
  onEscalation?: (esc: { kind: string; message: string }) => void;
  autoSteering?: boolean;
}

const STREAK_RECOVERY_THRESHOLD = 3; // consecutive schema-invalid calls per streak
const ACTIVITY_STALL_AFTER = 6;      // consecutive no-progress turns before a progress stall

export class RecoveryCoordinator {
  // one envelope per (signature, step) — envelope dedup
  private issued = new Set<string>();
  // GLOBAL ladder position for this run: two coordinator actions total, then
  // the honest stop (bounded inference; never endless recovery).
  private ladderStep: 0 | 1 | 2 = 0;
  // once per trigger rate limiting for automatic steering
  private autoFired = new Set<AutoSteeringTrigger>();
  // automatic steering queue: delivered AFTER manual steering, never dropped
  private autoQueue: { trigger: AutoSteeringTrigger; text: string }[] = [];
  // consecutive schema-invalid calls (streak detection)
  private invalidStreak = 0;
  // consecutive turns without measurable progress (progress stall)
  private noProgressTurns = 0;
  private lastWriteTurn = 0;

  constructor(private deps: RecoveryDeps) {}

  get enabled(): boolean {
    return this.deps.autoSteering !== false;
  }

  // ---- automatic steering intake ----
  queueAutoSteering(trigger: AutoSteeringTrigger, text: string): void {
    if (!this.enabled) return;
    if (this.autoFired.has(trigger)) return; // once per trigger, no loops
    this.autoFired.add(trigger);
    this.autoQueue.push({ trigger, text });
    this.deps.onEvent({ kind: 'auto_steering', trigger, message: text });
  }

  /** Drain the automatic queue for delivery at a safe boundary. Manual
   * steering is consumed by the runner FIRST; automatic waits its turn. */
  drainAutoSteering(): { trigger: AutoSteeringTrigger; text: string }[] {
    const out = this.autoQueue.splice(0, this.autoQueue.length);
    return out;
  }

  // ---- streak tracking (validation failures) ----
  noteInvalidCall(tool: string, error: string): void {
    this.invalidStreak++;
    if (this.invalidStreak >= STREAK_RECOVERY_THRESHOLD) {
      this.invalidStreak = 0;
      this.deps.onEvent({
        kind: 'streak_recovery',
        message: `${STREAK_RECOVERY_THRESHOLD} consecutive invalid ${tool} calls — recovery guidance issued.`,
      });
      this.deps.onEscalation?.({
        kind: 'repeated-failure',
        message: `${tool} calls keep failing schema validation (${error.slice(0, 160)}) — recovery guidance issued and coordinator informed.`,
      });
      if (this.enabled) {
        this.queueAutoSteering('stuck', [
          'Your tool calls keep failing validation.',
          'Trigger: stuck',
          'Do not re-send the same call. Re-read the exact parameter schema in the tool description, fix the arguments, or choose a different approach.',
        ].join('\n'));
      }
    }
  }

  noteValidCall(): void {
    this.invalidStreak = 0;
  }

  // ---- progress tracking (progress stall classification) ----
  noteTurn(withProgress: boolean, turn: number): void {
    if (withProgress) {
      this.noProgressTurns = 0;
      this.lastWriteTurn = turn;
    } else {
      this.noProgressTurns++;
    }
  }

  classify(): StallClass | null {
    if (this.noProgressTurns >= ACTIVITY_STALL_AFTER) return 'progress';
    return null;
  }

  resetProgressStall(): void {
    this.noProgressTurns = 0;
  }

  // ---- the recovery ladder ----
  /** Returns an envelope to inject as a user message, or null when the ladder
   * is exhausted for this signature (the caller then stops the run honestly). */
  nextStep(sig: string, stallClass: StallClass, ctx: {
    tool: string;
    lastResult: string;
    alternatives: string[];
    contract?: TaskContract;
  }): RecoveryEnvelope | null {
    const step = this.ladderStep;
    if (step >= 2) return null; // exhausted → stalled stop
    const next = (step + 1) as 1 | 2;
    this.ladderStep = next;
    if (this.issued.has(`${sig}#${next}`)) return null;
    this.issued.add(`${sig}#${next}`);

    const action: RecoveryAction = next === 1 ? 'workspace_refocus' : 'strategy_directive';
    const header = `[COORDINATOR RECOVERY — ACTIVE RECOVERY ${next}/2 — ${action} — stall class: ${stallClass}]`;
    const body: string[] = [
      header,
      `You are looping on ${ctx.tool} without the workspace changing. The coordinator has taken over for one recovery step.`,
    ];
    if (next === 1) {
      body.push(
        'STEP 1 — WORKSPACE REFOCUS: stop the failing pattern. Re-anchor using workspace_info and list_dir(".").',
        'The authoritative requirements of this task (quoted verbatim — they remain fully in force and open):',
        ...(ctx.contract?.requirements ?? []).filter((r) => r.source === 'user' && r.status === 'open').slice(0, 8).map((r) => `  • ${r.text}`),
      );
    } else {
      body.push(
        'STEP 2 — STRATEGY DIRECTIVE: repeating the same call cannot succeed. Choose ONE concrete alternative now:',
        ...ctx.alternatives.map((a) => `  • ${a}`),
        'The authoritative requirements of this task (quoted verbatim — they remain fully in force and open):',
        ...(ctx.contract?.requirements ?? []).filter((r) => r.source === 'user' && r.status === 'open').slice(0, 8).map((r) => `  • ${r.text}`),
      );
    }
    body.push(`The last REAL result of your attempts (${stallClass} stall): ${ctx.lastResult.slice(0, 500)}`);
    body.push('If no alternative can progress the task, call finish with an honest PARTIAL/BLOCKED summary — do not keep looping.');
    this.deps.onEvent({
      kind: 'recovery_action',
      action,
      stallClass,
      signature: sig,
      step: next,
      message: `Recovery ${next}/2 (${action}) injected for ${ctx.tool} after a ${stallClass} stall.`,
    });
    return { text: body.join('\n'), header };
  }

  /** True when further recovery cannot help: the run must stop honestly. */
  exhausted(sig: string): boolean {
    return this.ladderStep >= 2;
  }

  /** Steps consumed so far (0, 1 or 2). */
  exhaustedCount(): number {
    return this.ladderStep;
  }
}

// Canonical journal signature: equivalent spellings must collide —
// list_dir({}) ≡ list_dir({path:'.'}) ≡ list_dir({path:'./'}).
export function canonicalSignature(tool: string, args: Record<string, any>): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
    }
    return v;
  };
  const a = walk(args ?? {});
  for (const key of Object.keys(a)) {
    if (/^(path|dir|directory|folder|cwd|target)$/i.test(key) && typeof a[key] === 'string') {
      const norm = String(a[key]).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      a[key] = norm === '' ? '.' : norm;
    }
  }
  return `${tool}::${JSON.stringify(a)}`;
}
