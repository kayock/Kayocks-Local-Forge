// AgentRunner — the autonomous coding agent loop.
//
// Streams model responses through the companion proxy, executes real tools
// against the authorized workspace via the companion, feeds results back to
// the model, and repeats until the task is finished or limits are hit.
//
// Tool-calling modes (spec §3.2, docs/HARNESS_UPGRADE.md):
//  - 'native': genuine provider function calling only. No text-protocol
//    instructions, no nudges — the interference source behind Test C.
//  - 'text':   JSON-per-turn text protocol for models with weak/no native
//    support (Test A's 4B model).
//  - 'auto':   starts native; switches to text ONLY when the server/model
//    rejects the tools API, and records why (mode_change event).
// The chosen mode is persisted per provider/model by the IDE settings store.
//
// Forge upgrade (this phase) additions:
//  - coordinator-level tool journal: identical calls are detected with
//    outcome classes (ok-empty vs ok-nonempty vs error) and the workspace
//    version, so legitimate re-runs after real changes stay allowed while
//    pointless repetition is blocked and then escalated (Problem A);
//  - structured recovery envelopes injected as coordinator messages, based
//    on what the tools ACTUALLY returned — never fabricated results;
//  - user steering queue applied at the next turn boundary (never lost
//    behind retries);
//  - evidence-gated completion on finish via the coordinator's completion
//    gate (Problem D) with a TaskContract (Problem C);
//  - model-aware dialect handling: tagged/pythonic tool-call dialects are
//    detected, executed and remembered per provider+model (Part 2);
//  - stall escalation to a configured replacement model with a structured
//    handoff packet that preserves the original assignment (Problem E).
import type { CompanionClient } from '@/lib/companion/client';
import type { InferenceParams, ProviderConfig } from '@/lib/types';
import type {
  AgentEvent,
  AgentMessage,
  Approver,
  CompletionResult,
  ToolContext,
  ToolDef,
  ToolProtocolMode,
  ToolLogEntry,
} from './types';
import { normalizeProtocolMode, toolResultMessage, FALLBACK_NUDGE } from './protocol';
import { normalizeToolArgs, validateToolArgs, canonicalToolName, summarizeError, canonRelPath } from './tools';
import { detectToolDialect, type ToolDialect } from './dialects';
import { evaluateCompletion } from './completion';
import { buildHandoffPacket, contractPromptBlock, bumpInPlace, type TaskContract } from './task-contract';

export interface RunnerConfig {
  companion: CompanionClient;
  // 0.4.4 multi-machine routing: MODEL traffic goes to the agent's machine
  // (`companion`), TOOL execution to the authoritative workspace host when one
  // is configured. Single-machine setups omit it and everything runs locally.
  toolCompanion?: CompanionClient;
  workspaceId: string;
  provider: ProviderConfig;
  model: string;
  params?: Partial<InferenceParams>;
  systemPrompt: string;
  task: string;
  contextMessages?: AgentMessage[];
  tools: ToolDef[];
  toolProtocol?: ToolProtocolMode | 'auto-native' | 'force-text';
  maxTurns?: number;
  onEvent: (e: AgentEvent) => void;
  approver?: Approver;
  allowedPatterns?: Set<string>;
  signal?: AbortSignal;
  // task mode: when the model stops in plain text without a tool call/finish,
  // nudge it back to the tool protocol instead of accepting the stop.
  // (Only honored in text mode or after an auto fallback — never in native
  // mode, where protocol nudges were observed to degrade capable models.)
  allowNudgeOnText?: boolean;
  // coordinator-supplied steering applied before the first turn (queued the
  // moment an assignment is created, consumed at the run's first boundary)
  initialSteering?: string[];
  // regex-source strings; writes/edits/deletes to matching paths are refused
  protectedPaths?: string[];
  // ---- Forge upgrade (Problems A/C/D/E, Part 2) ----
  // canonical workspace identity surfaced to tools and tool feedback
  workspaceMeta?: { id: string; rootPath: string; machineLabel: string; platform: string; knownTree?: string };
  // coordinator-owned contract; when present, finish passes through the
  // completion gate instead of being accepted on the model's word
  contract?: TaskContract;
  // onContractUpdate lets the IDE persist contract mutations (progress,
  // evidence, gate decisions) as they happen
  onContractUpdate?: (c: TaskContract) => void;
  // learned tool-call dialect ledger callback (Part 2): the IDE persists it
  // per provider+model
  onDialectLearned?: (dialect: ToolDialect, model: string) => void;
  // escalation target for stalls (Problem E): return a replacement
  // provider/model, or null when none is configured
  escalateTo?: () => { provider: ProviderConfig; model: string; label: string } | null;
  // Milestone 1: workspace revision lookup for tool results. Optional; when
  // absent, FS-write results carry the per-file mtime fingerprint only.
  fetchWorkspaceRevision?: () => Promise<string | null>;
  // coordinator hook: fired whenever the runner escalates, so the handoff is
  // recorded in the coordinator's report (Problem A/E bookkeeping)
  onEscalation?: (esc: { kind: string; message: string; tool?: string }) => void;
  // Forge upgrade (Part 6): browser capability over the companion, wired by
  // the IDE from CompanionClient's browser methods. Absent → browser tools
  // degrade with an explicit UNVERIFIED instruction.
  companionBrowser?: {
    open(wsId: string, opts?: { url?: string; visible?: boolean }): Promise<{ ok?: boolean; reused?: boolean; url?: string; visible?: boolean; browser?: string; unavailable?: string }>;
    navigate(wsId: string, url: string): Promise<{ ok: boolean; url: string; title?: string; unavailable?: string }>;
    eval(wsId: string, expression: string): Promise<{ ok: boolean; value?: unknown; error?: string; consoleErrors?: { kind: string; text: string }[]; unavailable?: string }>;
    verify(wsId: string, opts: { url: string; checks?: { selector?: string; contains?: string; minCount?: number; evaluate?: string }[]; saveScreenshot?: string }): Promise<{ ok?: boolean; verdict?: string; checks?: { check: string; pass: boolean; error?: string }[]; checksPassed?: number; checksTotal?: number; consoleErrors?: { kind: string; text: string }[]; screenshotPath?: string; unavailable?: string }>;
    close(wsId: string): Promise<{ ok: boolean; note?: string }>;
    status(wsId: string): Promise<{ running: boolean; url?: string; visible?: boolean }>;
  };
}

const TOOL_OUTPUT_CAP = 30000;
const MAX_CALLS_PER_TURN = 6;

// Repetition thresholds per tool class (spec §3.7): block an identical call
// once it clearly cannot produce new information.
const REPEAT_LIMIT_DEFAULT = 2;   // successful commands, writes, edits
const REPEAT_LIMIT_READS = 3;     // list_dir / read_file / search / process_status
const REPEAT_LIMIT_FAILED = 3;    // identical failing calls get one extra retry
// Escalation (Problem A): after this many BLOCKED attempts of the same
// signature with an unchanged workspace, the coordinator escalates.
const STALL_ESCALATE_AFTER = 2;
const REPEAT_EXEMPT = new Set(['finish']);
// Tools whose success changes workspace state (drives the workspace version
// used to distinguish pointless repetition from legitimate re-runs).
const FS_WRITERS = new Set(['write_file', 'edit_file', 'create_dir', 'delete_path', 'extract_archive']);
const FS_MAYBE_WRITERS = new Set(['run_command', 'launch_app', 'stop_process', 'install_dependencies', 'run_tests', 'run_build']);
const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_project', 'process_status', 'workspace_info']);

export interface RunResult {
  content: string;
  turns: number;
  note?: string;
  // full internal message history — pass as contextMessages to resume
  messages: AgentMessage[];
  hitTurnLimit: boolean;
  // true when the run stopped at a user-requested safe boundary (requestPause)
  paused?: boolean;
  // Forge upgrade — Problem D: coordinator verdict, not the model's claim
  completion?: CompletionResult;
  // Milestone 1: files this run actually wrote/edited (structured result)
  filesChanged: string[];
  usage?: { promptTokens: number | null; completionTokens: number | null };
}

interface JournalEntry {
  count: number;           // executions observed for this exact signature
  blocked: number;         // consecutive blocks without workspace change
  status: 'ok' | 'error';
  outcome: 'ok-empty' | 'ok-nonempty' | 'error';
  output: string;
  workspaceVersion: number;
}

export class AgentRunner {
  private protocol: ToolProtocolMode;
  private messages: AgentMessage[] = [];
  // set by requestPause(); honored at the next safe turn boundary
  private pauseRequested = false;

  /** Pause at the next safe turn boundary (user-requested). In-flight model
   * calls are not interrupted; the boundary keeps all progress resumable. */
  requestPause(): void {
    this.pauseRequested = true;
  }
  private logId = 0;
  private _nudged = false;
  private fellBack = false;
  private recentCalls = new Map<string, JournalEntry>();
  private workspaceVersion = 1;      // bumped by fs-changing operations
  private steeringQueue: string[] = [];
  private filesWritten = new Set<string>();
  private testsRun: { command: string; exitCode: number | null; passed: boolean; summary?: string }[] = [];
  private browserSawUnavailable = false;
  private gateRefusals = 0;
  private lastCompletion: CompletionResult | undefined;
  private lastEscalatedTo: string | null = null;
  // Milestone 1: cumulative token usage for the run (from usage events)
  private usageTotal: { promptTokens: number | null; completionTokens: number | null } = { promptTokens: null, completionTokens: null };

  constructor(private cfg: RunnerConfig) {
    this.protocol = normalizeProtocolMode(cfg.toolProtocol);
    if (cfg.initialSteering?.length) this.steeringQueue.push(...cfg.initialSteering);
  }

  private emit(e: AgentEvent) {
    if (e.type === 'usage') {
      if (e.usage.promptTokens != null) this.usageTotal.promptTokens = (this.usageTotal.promptTokens ?? 0) + e.usage.promptTokens;
      if (e.usage.completionTokens != null) this.usageTotal.completionTokens = (this.usageTotal.completionTokens ?? 0) + e.usage.completionTokens;
    }
    this.cfg.onEvent(e);
  }

  // Public API: user steering during a run. Applied at the next turn
  // boundary — never dropped, never queued behind tool retries (Problem A).
  steer(text: string) {
    const t = text.trim();
    if (!t) return;
    this.steeringQueue.push(t);
    if (this.cfg.contract) {
      this.cfg.contract.steering.push({ text: t, at: Date.now() });
      this.cfg.onContractUpdate?.(this.cfg.contract);
    }
  }

  // The text-protocol helper (nudges + JSON contract) must only engage where
  // it helps: text mode, or auto mode after a genuine fallback. Injecting it
  // into native mode degraded Qwen3-Coder-30B in real testing (Test C).
  private helperAllowed(): boolean {
    if (this.protocol === 'text') return true;
    if (this.protocol === 'auto' && this.fellBack) return true;
    return false;
  }

  private makeToolContext(): ToolContext {
    const { workspaceId } = this.cfg;
    // TOOL execution targets the authoritative workspace host when configured;
    // the model companion is only the fallback for single-machine setups.
    const companion = this.cfg.toolCompanion ?? this.cfg.companion;
    const protectedRes = (this.cfg.protectedPaths || []).map((r) => new RegExp(r));
    const assertEditable = (p: string) => {
      if (protectedRes.some((re) => re.test(p))) {
        throw new Error(`"${p}" is protected by the execution policy and cannot be modified.`);
      }
    };
    return {
      workspaceId,
      assertEditable,
      log: (entry) => this.emit({ type: 'tool_end', call: { id: entry.id, name: entry.tool, args: entry.args }, entry }),
      runCommand: async (cmd, opts) => {
        // shell commands may need confirm after user approval
        try {
          return await companion.exec(workspaceId, cmd, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, confirm: false });
        } catch (e: any) {
          if (e?.name === 'NeedsConfirmError') {
            const decision = await this.askApproval('run_command', { command: cmd }, 'command', `Shell: ${cmd}`);
            if (decision === 'deny') throw new Error('User denied command execution.');
            return await companion.exec(workspaceId, cmd, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, confirm: true });
          }
          throw e;
        }
      },
      procs: {
        launch: (cmd, opts) => companion.procStart(workspaceId, cmd, { cwd: opts?.cwd }),
        list: () => companion.procList(workspaceId),
        output: (id, sinceBytes) => companion.procOutput(workspaceId, id, sinceBytes),
        stop: (id) => companion.procStop(workspaceId, id),
      },
      fs: {
        listDir: async (p) => {
          const rel = (!p || p === '.' || p === './') ? '' : String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
          const t = await companion.tree(workspaceId, 8);
          const prefix = rel ? rel + '/' : '';
          return t.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
            .map((e) => ({ path: e.path.slice(prefix.length), type: e.type, size: e.size }));
        },
        readFile: async (p) => {
          const f = await companion.readFile(workspaceId, p);
          return { content: f.content, size: f.size, modifiedAt: (f as any).modifiedAt };
        },
        writeFile: async (p, c, opts) => companion.writeFile(workspaceId, p, c, opts),
        // Milestone 1: diff preview BEFORE approving a write (companion-side
        // unified diff against the file on disk).
        diffPreview: (companion as any).diffPreview ? async (p: string, content: string) => (companion as any).diffPreview(workspaceId, p, content) : undefined,
        mkdir: async (p) => { await companion.mkdir(workspaceId, p); },
        deletePath: async (p) => { await companion.deletePath(workspaceId, p, true); },
        rename: async (a, b) => { await companion.rename(workspaceId, a, b); },
        search: async (q, o) => {
          const r = await companion.search(workspaceId, q, { isRegex: o?.isRegex, glob: o?.glob });
          return r.results;
        },
        // Forge upgrade (Problem B): true empty-vs-missing inspection. Older
        // companions without /stat degrade: the list_dir tool falls back to an
        // explicit "cannot distinguish" answer instead of asserting emptiness.
        stat: async (p) => {
          const st = await (companion as any).statPath?.(workspaceId, p);
          if (!st) throw new Error('stat unavailable (companion too old, 404)');
          return st;
        },
        // Forge upgrade (Problem B): jailed archive extraction with
        // nested-root detection (calculator regression).
        extractArchive: async (p, opts) => {
          const r = await (companion as any).extractArchive?.(workspaceId, p, opts);
          if (!r) throw new Error('extract unavailable (companion too old, 404)');
          return r;
        },
      },
      // Forge upgrade: canonical workspace identity surfaced to every tool so
      // results can state the machine and absolute root they operated on.
      workspaceMeta: this.cfg.workspaceMeta,
      // Forge upgrade (Part 6): shared local browser over CDP.
      browser: this.cfg.companionBrowser ? {
        open: (o) => this.cfg.companionBrowser!.open(workspaceId, o ?? {}),
        navigate: (url) => this.cfg.companionBrowser!.navigate(workspaceId, url),
        evaluate: (expr) => this.cfg.companionBrowser!.eval(workspaceId, expr),
        verify: (o) => this.cfg.companionBrowser!.verify(workspaceId, o),
        close: () => this.cfg.companionBrowser!.close(workspaceId),
        status: () => this.cfg.companionBrowser!.status(workspaceId),
      } : undefined,
    };
  }

  private async askApproval(tool: string, args: Record<string, unknown>, danger: string, summary: string): Promise<'allow' | 'deny'> {
    const pattern = `${tool}:${summarizeArgs(args)}`;
    if (this.cfg.allowedPatterns?.has(pattern)) return 'allow';
    if (!this.cfg.approver) {
      this.emit({ type: 'notice', message: `Auto-denied ${tool} (no approver configured).` });
      return 'deny';
    }
    this.emit({ type: 'approval_request', req: { id: `ap_${++this.logId}`, tool, args, danger, summary } });
    const decision = await this.cfg.approver({ tool, args, danger, summary });
    this.emit({ type: 'approval_decision', id: `ap_${this.logId}`, decision });
    if (decision === 'allow-always' && this.cfg.allowedPatterns) {
      this.cfg.allowedPatterns.add(pattern);
    }
    return decision === 'deny' ? 'deny' : 'allow';
  }

  // Executes one call end-to-end: alias normalization → validation → approval
  // → repetition guard → execution. Validation failures and repetition blocks
  // return actionable tool results WITHOUT consuming an approval prompt.
  private async executeCall(rawName: string, rawArgs: unknown, callId: string): Promise<{ entry: ToolLogEntry; args: Record<string, any>; name: string }> {
    const name = canonicalToolName(rawName);
    const { args, aliasesApplied } = normalizeToolArgs(rawName, rawArgs);
    const entry: ToolLogEntry = {
      id: `t_${++this.logId}`,
      tool: name,
      args,
      status: 'running',
      startedAt: Date.now(),
      machine: this.cfg.workspaceMeta?.machineLabel,
    };
    if (aliasesApplied && Object.keys(aliasesApplied).length) {
      entry.output = `Note: argument aliases normalized: ${Object.entries(aliasesApplied).map(([a, b]) => `${a} → ${b}`).join(', ')}.`;
    }

    const finishArgs = () => { entry.endedAt = Date.now(); };

    // unknown tool → exact repair information
    const def = this.cfg.tools.find((t) => t.name === name);
    if (!def) {
      entry.status = 'error';
      finishArgs();
      entry.output = validateToolArgs(name, args) || `Unknown tool "${name}".`;
      return { entry, args, name };
    }

    // schema validation BEFORE approval (no side effects, no prompt friction)
    const invalid = validateToolArgs(name, args);
    if (invalid) {
      entry.status = 'error';
      finishArgs();
      entry.output = invalid;
      return { entry, args, name };
    }

    // repetition guard (spec §3.7 + Forge Problem A): identical calls are
    // blocked only when the workspace has NOT changed since the last attempt
    // — a legitimate re-run after a real change is always allowed.
    const sig = `${name}::${stableArgs(args)}`;
    const prev = this.recentCalls.get(sig);
    if (prev && !REPEAT_EXEMPT.has(name) && prev.workspaceVersion === this.workspaceVersion) {
      const reads = READ_TOOLS.has(name);
      const limit = prev.status === 'ok' ? (reads ? REPEAT_LIMIT_READS : REPEAT_LIMIT_DEFAULT) : REPEAT_LIMIT_FAILED;
      if (prev.count >= limit) {
        prev.blocked++;
        const emptyButOk = prev.outcome === 'ok-empty';
        const changedHint = prev.status === 'ok'
          ? 'Repeating it cannot produce new information.'
          : 'Repeating the exact same failing call with identical arguments will fail identically.';
        entry.status = prev.status === 'ok' ? 'ok' : 'error';
        entry.outcome = 'blocked';
        finishArgs();
        entry.output = [
          `[REPEATED CALL — not executed] This exact ${name} call has already been made ${prev.count} times with identical arguments and the workspace has NOT changed since.`,
          `Previous real result (${prev.outcome}): ${prev.output.slice(0, 600)}`,
          emptyButOk
            ? 'Important: the previous result was SUCCESSFUL but empty/absent. That is the actual state of the workspace — not a tool failure. Re-running cannot make files appear.'
            : changedHint,
          `If the environment genuinely changed, change it yourself first (edit a file, run a different command) and your retry will be executed. Otherwise move to the next step of the task, or call finish with an honest summary.`,
        ].join('\n');
        this.emit({
          type: 'loop_detected',
          tool: name,
          count: prev.count,
          action: 'blocked',
          message: `Identical ${name} call repeated ${prev.count}× (workspace unchanged) — previous real result returned with recovery guidance instead of re-executing.`,
        });
        // Problem A: structured coordinator recovery after repeated blocks
        if (prev.blocked >= STALL_ESCALATE_AFTER) {
          await this.handleStall(name, args, prev);
        }
        return { entry, args, name };
      }
    }

    // approval per execution policy
    const needsApproval = def.danger !== 'safe';
    if (needsApproval) {
      const decision = await this.askApproval(def.name, args, def.danger, summarizeCall(def, args));
      if (decision === 'deny') {
        entry.status = 'denied';
        entry.outcome = 'denied';
        finishArgs();
        entry.output = 'User denied this operation.';
        return { entry, args, name };
      }
    }

    try {
      const ctx = this.makeToolContext();
      const res = await def.run(args, ctx);
      entry.status = res.isError ? 'error' : 'ok';
      entry.output = entry.output ? `${entry.output}\n${res.output}` : res.output;
      // Milestone 1: structured results — attached diff, changed file, and a
      // workspace-revision note on FS writes (fetched only when wired).
      if (res.diff) {
        entry.diff = res.diff;
        entry.diffPath = res.diffPath;
        this.emit({ type: 'diff_preview', path: res.diffPath || String(args.path ?? ''), diff: res.diff, added: (res as any).diffAdded, removed: (res as any).diffRemoved });
      }
      if (res.changedFile) entry.changedFile = res.changedFile;
      // Part 2 structured execution feedback + workspace version tracking.
      // Only deterministic FS writers bump the workspace version: a command
      // does not count as a change by itself, otherwise re-running an
      // identical command could never be blocked (the loop the calculator
      // test exposed). A legitimate re-run after a real edit is still
      // allowed because the edit bumped the version.
      if (FS_WRITERS.has(name)) {
        entry.fsChanged = true;
        this.workspaceVersion++;
        if (name === 'write_file' || name === 'edit_file') {
          const p = String(args.path ?? res.changedFile ?? '');
          if (p) this.filesWritten.add(canonRelPath(p));
        }
        if (name === 'extract_archive') {
          const dest = canonRelPath(args.dest ?? '.');
          const nested = (res.output.match(/nested project root "([^"]+)"/) || [])[1];
          this.filesWritten.add(nested && (args.flatten === true || args.flatten === 'true') ? dest : `${dest}/${nested ?? ''}`.replace(/\/$/, ''));
        }
        // Milestone 1: workspace revision in relevant tool results. Fetched
        // lazily and never allowed to break the tool result on failure.
        if (this.cfg.fetchWorkspaceRevision) {
          try {
            const rev = await this.cfg.fetchWorkspaceRevision();
            if (rev) {
              entry.workspaceRevision = rev.slice(0, 12);
              entry.output = `${entry.output}\nworkspace revision: ${rev.slice(0, 12)}`;
            }
          } catch { /* revision lookup is best-effort */ }
        }
      } else if (FS_MAYBE_WRITERS.has(name)) {
        entry.fsChanged = true; // commands may modify the workspace (metadata only)
      }
      if (name === 'run_tests' || name === 'run_build' || /\b(test|pytest|unittest|npm test|cargo test|go test)\b/i.test(String(args.command ?? ''))) {
        const exit = exitFromOutput(entry.output);
        if (exit !== null) this.testsRun.push({ command: String(args.command ?? name), exitCode: exit, passed: exit === 0 && !entry.output.includes('TIMED OUT'), summary: entry.output.slice(0, 400) });
      }
      if (/browser (unavailable|could not be launched)|no browser/i.test(entry.output)) this.browserSawUnavailable = true;
      // Problem D: browser evidence flows into the contract when the
      // verification actually ran and passed (never on a model's word).
      if (name === 'browser_verify' && this.cfg.contract && /BROWSER VERIFICATION PASSED/.test(entry.output)) {
        this.cfg.contract.evidence.push({ kind: 'browser-verified', detail: entry.output.slice(0, 400), at: Date.now(), source: entry.id });
        bumpInPlace(this.cfg.contract);
        this.cfg.onContractUpdate?.(this.cfg.contract);
      }
      if (name === 'browser_verify' && /BROWSER UNAVAILABLE/i.test(entry.output)) this.browserSawUnavailable = true;
      // outcome class for the journal (Problem A: empty ≠ failure)
      entry.outcome = entry.status === 'error' ? 'error' : classifyEmpty(name, entry.output);
      if (name === 'run_command' || name === 'launch_app') {
        const cwd = (entry.output.match(/^cwd: (.+)$/m) || [])[1];
        if (cwd) entry.cwd = cwd.trim();
        const code = exitFromOutput(entry.output);
        if (code !== null) entry.exitCode = code;
      }
      if (name === 'finish' && this.testsRun.length === 0) {
        // nothing — gate handles it
      }
    } catch (e: any) {
      entry.status = 'error';
      entry.outcome = 'error';
      entry.output = `${entry.output ? entry.output + '\n' : ''}ERROR: ${summarizeError(e)}`;
    }
    finishArgs();
    this.recentCalls.set(sig, {
      count: (prev && prev.workspaceVersion === this.workspaceVersion ? prev.count : 0) + 1,
      blocked: prev && prev.workspaceVersion === this.workspaceVersion ? prev.blocked : 0,
      status: entry.status as 'ok' | 'error',
      outcome: entry.outcome as JournalEntry['outcome'],
      output: entry.output || '',
      workspaceVersion: this.workspaceVersion,
    });
    return { entry, args, name };
  }

  // Problem A: structured recovery + escalation when no progress is made.
  // The envelope is built from REAL tool results (the journal), never from
  // fabricated assumptions.
  private async handleStall(tool: string, args: Record<string, any>, prev: JournalEntry) {
    const sigDesc = `${tool}(${Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(String(v)).slice(0, 60)}`).join(', ')})`;
    const lastResult = prev.output.slice(0, 800);
    const emptyOk = prev.outcome === 'ok-empty';
    const alternatives = suggestAlternatives(tool, args, prev.outcome);
    const envelope = [
      `[COORDINATOR RECOVERY — no progress detected]`,
      `You have now attempted the identical call ${sigDesc} ${prev.count + prev.blocked} times without the workspace changing.`,
      `The last REAL result was (${prev.outcome}): ${lastResult}`,
      emptyOk
        ? `This was a SUCCESSFUL result: the empty/absent state it reports is the actual state of the workspace. Repeating the call cannot change it.`
        : `This call keeps failing identically; retrying the same arguments cannot succeed.`,
      `Do ONE of the following instead:`,
      ...alternatives.map((a) => `  • ${a}`),
      `  • If the task truly cannot progress, call finish with an honest summary saying which requirements remain unmet (status PARTIAL/BLOCKED).`,
      this.cfg.contract ? `The original task contract and its requirements remain fully in force — they were not changed by this recovery.` : '',
    ].filter(Boolean).join('\n');
    this.messages.push({ role: 'user', content: envelope });
    this.emit({
      type: 'stall_detected',
      tool,
      attempts: prev.count + prev.blocked,
      message: `No progress after ${prev.count + prev.blocked} attempts of ${tool} — coordinator recovery envelope injected.`,
    });

    // Escalation (Problem E): when a replacement model is configured and the
    // stall persists, hand off with the original assignment preserved.
    if (prev.blocked >= STALL_ESCALATE_AFTER + 1 && this.cfg.escalateTo && this.cfg.contract) {
      const target = this.cfg.escalateTo();
      if (target && target.model !== this.cfg.model) {
        const packet = buildHandoffPacket(this.cfg.contract, {
          fromModel: this.cfg.model,
          toModel: target.model,
          filesTouched: [...this.filesWritten],
          testsRun: this.testsRun,
          blockers: [`Repeated no-progress stall on ${sigDesc}`],
          lastSuccessfulOperation: this.lastSuccess() || 'none recorded',
          remainingWork: this.cfg.contract.requirements.filter((r) => r.status === 'open' && r.source === 'user').map((r) => r.text),
        });
        this.cfg.provider = target.provider;
        this.cfg.model = target.model;
        this.lastEscalatedTo = `${target.label ?? 'model'}: ${target.model}`;
        this.messages.push({ role: 'user', content: packet });
        this.emit({ type: 'escalation', fromModel: this.cfg.model, toModel: target.model, reason: `Stall on repeated ${tool} calls — escalated with the original assignment preserved.` });
        this.cfg.onEscalation?.({ kind: 'stall-escalation', message: `Stall on repeated ${tool} calls — escalated to ${target.model} with the original assignment preserved.`, tool });
        this.recentCalls.clear(); // the new model starts with a clean journal
      }
    }
  }

  private lastSuccess(): string | null {
    let last: string | null = null;
    for (const [sig, e] of this.recentCalls) {
      if (e.status === 'ok') last = `${sig.split('::')[0]} → ${e.output.slice(0, 120)}`;
    }
    return last;
  }

  private async runOneCall(call: { id: string; name: string; args?: unknown }, messageId: string | null): Promise<{ finished: boolean; finalContent: string; entry: ToolLogEntry; name: string }> {
    this.emit({ type: 'tool_start', call: { id: call.id, name: canonicalToolName(call.name), args: normalizeToolArgs(call.name, call.args).args } });
    const { entry, args, name } = await this.executeCall(call.name, call.args, call.id);
    this.emit({ type: 'tool_end', call: { id: call.id, name, args }, entry });
    if (messageId === 'wire') {
      this.messages.push({ role: 'tool', toolCallId: call.id || name, name, content: capOutput(entry.output || '') });
    } else {
      this.messages.push(toolResultMessage(name, capOutput(entry.output || ''), entry.status === 'error'));
    }
    let finished = false;
    let finalContent = '';
    if (name === 'finish') {
      finished = true;
      finalContent = String(args.summary || entry.output || '');
    }
    return { finished, finalContent, entry, name };
  }

  private toWire(): any[] {
    const wire = this.messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name: canonicalToolName(tc.name), arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) },
          })),
        };
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId || m.name || 'tool', content: m.content };
      }
      return { role: m.role, content: m.content };
    });
    return this.compact(wire);
  }

  // Keep prompts within the model's context window: trim old tool outputs /
  // assistant prose when the conversation would overflow. Keeps system, the
  // original task, coordinator/steering/recovery messages and the most recent
  // messages intact (recovery envelopes are never trimmed away).
  private compact(wire: any[]): any[] {
    const numCtx = this.cfg.params?.numCtx ?? 8192;
    const budgetChars = Math.max(8000, (numCtx - 1200) * 4);
    const size = (m: any) => (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
    let total = wire.reduce((a, m) => a + size(m), 0);
    if (total <= budgetChars) return wire;
    const cutoff = Math.max(1, wire.length - 8);
    for (let i = 1; i < cutoff && total > budgetChars; i++) {
      const m = wire[i];
      const len = (m.content ?? '').length;
      if (typeof m.content === 'string' && /\[COORDINATOR RECOVERY|\[USER STEERING|MODEL HANDOFF|TASK CONTRACT/.test(m.content)) continue; // never trimmed
      if ((m.role === 'tool' || (m.role === 'user' && String(m.content ?? '').startsWith('[TOOL RESULT]'))) && len > 240) {
        total -= len - 200;
        m.content = String(m.content).slice(0, 200) + '…[earlier tool output trimmed]';
      } else if (m.role === 'assistant' && len > 500) {
        total -= len - 300;
        m.content = String(m.content).slice(0, 300) + '…[trimmed]';
      }
    }
    return wire;
  }

  private wireTools() {
    return this.cfg.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(t.params.map((p) => [p.name, { type: p.type, description: p.description }])),
          required: t.params.filter((p) => p.required).map((p) => p.name),
        },
      },
    }));
  }

  // Problem D: the evidence gate. Runs when the model calls finish while a
  // contract is active. A not-COMPLETE verdict refuses the finish (bounded),
  // feeds the missing evidence back, and lets the model continue working.
  private async runCompletionGate(summary: string): Promise<{ accepted: boolean; result: CompletionResult }> {
    const contract = this.cfg.contract!;
    const browserEvidence = contract.evidence.some((e) => e.kind === 'browser-verified')
      ? 'verified' as const
      : (this.browserSawUnavailable ? 'unavailable' as const : 'untested' as const);
    // filesystem reality check on files this run wrote and any the summary claims
    const files = new Set(this.filesWritten);
    for (const m of summary.match(/[\w./\\-]+\.[a-zA-Z0-9]{1,6}/g) || []) {
      if (/^https?:/.test(m)) continue;
      files.add(m.replace(/^\.?\//, ''));
    }
    const checked: { path: string; exists: boolean }[] = [];
    for (const p of files) {
      if (this.filesWritten.has(p)) { checked.push({ path: p, exists: true }); continue; }
      // summary-mentioned files must genuinely exist on disk — verify via the
      // companion, never trust the summary text
      try {
        await this.cfg.companion.readFile(this.cfg.workspaceId, p);
        checked.push({ path: p, exists: true });
      } catch {
        checked.push({ path: p, exists: false });
      }
    }
    const result = evaluateCompletion({
      contract,
      filesCheck: checked,
      testsRun: this.testsRun,
      browserEvidence,
      finishSummary: summary,
    });
    const accepted = result.status === 'COMPLETE';
    return { accepted, result };
  }

  async run(): Promise<RunResult> {
    const cfg = this.cfg;
    const maxTurns = cfg.maxTurns ?? 40;

    // Problem C: the contract block leads EVERY run's system prompt (unless
    // the caller already embedded it), so requirements survive model
    // switches, handoffs, compaction and resume — never summarized away.
    let systemPrompt = cfg.systemPrompt;
    if (cfg.contract && !systemPrompt.includes('TASK CONTRACT')) {
      systemPrompt = `${contractPromptBlock(cfg.contract, { role: 'task agent' })}\n\n=== RUNTIME ===\n${systemPrompt}`;
    }

    this.messages = [
      { role: 'system', content: systemPrompt },
      ...(cfg.contextMessages || []),
      { role: 'user', content: cfg.task },
    ];

    let turn = 0;
    let finalContent = '';
    let finalNote: string | undefined;
    let hitTurnLimit = false;
    let paused = false;

    while (turn < maxTurns) {
      turn++;
      this.emit({ type: 'turn_start', turn });
      if (cfg.signal?.aborted) {
        finalNote = 'Stopped by user.';
        break;
      }
      // User-requested pause: stop at this safe boundary (between turns, all
      // tool results and messages already recorded). Resumable via
      // "Continue task" with full context.
      if (this.pauseRequested) {
        this.pauseRequested = false;
        paused = true;
        finalNote = `Paused at a safe boundary after turn ${turn} (requested by the user) — all progress is preserved. Press "Continue task" to resume.`;
        this.emit({ type: 'paused', turn, reason: 'requested by user' });
        break;
      }

      // Problem A: drain user steering FIRST — applied promptly, never lost
      // behind retries or blocks.
      if (this.steeringQueue.length) {
        const notes = this.steeringQueue.splice(0, this.steeringQueue.length);
        this.messages.push({
          role: 'user',
          content: `[USER STEERING — HIGHEST PRIORITY, applies immediately]\n${notes.map((n) => `- ${n}`).join('\n')}\nAcknowledge briefly and follow it now; it overrides earlier instructions and the current approach.`,
        });
        this.emit({ type: 'steering_applied', message: `User steering applied: ${notes.map((n) => n.slice(0, 80)).join(' | ')}` });
      }

      let streamedText = '';
      let endChunk: any = null;
      let usedNative = this.protocol !== 'text';

      // model-server resilience: transient connection errors are retried
      let res: Awaited<ReturnType<CompanionClient['chat']>> | null = null;
      let lastErr: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await cfg.companion.chat({
            provider: cfg.provider,
            model: cfg.model,
            messages: this.toWire() as any,
            tools: usedNative ? (this.wireTools() as any) : undefined,
            params: cfg.params,
            signal: cfg.signal,
            onChunk: (c) => {
              if (c.t === 'text' && c.v) {
                if (attempt === 1) {
                  streamedText += c.v;
                  this.emit({ type: 'text_delta', v: c.v });
                }
              }
            },
          });
          lastErr = null;
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e);
          const transient = /Cannot reach|network|ECONNREFUSED|fetch failed|socket/i.test(msg) && !cfg.signal?.aborted;
          if (transient && attempt < 3) {
            this.emit({ type: 'notice', message: `Model server unreachable (attempt ${attempt}) — retrying…` });
            await new Promise((r) => setTimeout(r, attempt * 2500));
            continue;
          }
          break;
        }
      }
      if (lastErr) {
        const e = lastErr;
        const msg = String(e?.message || e);
        // Server/model rejected native tool calling. In 'auto' mode fall back
        // to the text protocol ONCE and record why; in 'native' mode report
        // the failure instead of silently downgrading (spec §3.2).
        if (usedNative && /tool/i.test(msg)) {
          if (this.protocol === 'auto') {
            const from = this.protocol;
            this.fellBack = true;
            this.protocol = 'text';
            this.emit({ type: 'mode_change', from, to: this.protocol, reason: `Server rejected native tool calling: ${msg.slice(0, 200)}` });
            turn--; // retry this turn under the text protocol
            continue;
          }
          this.emit({ type: 'model_error', message: `Native tool calling failed and the mode is forced to native (no fallback per your setting): ${msg.slice(0, 300)}` });
          finalContent = streamedText;
          finalNote = `Native tool calling is not supported by this model/server. Switch the tool protocol mode to Automatic or Text (Settings → Agent), or pick a model with native tool support.`;
          break;
        }
        this.emit({ type: 'model_error', message: msg });
        finalContent = streamedText;
        finalNote = `Model error: ${msg.slice(0, 300)}`;
        break;
      } else {
        endChunk = res!.end;
        streamedText = res!.text || streamedText;
      }

      this.emit({ type: 'text_final', v: streamedText });
      if (endChunk?.usage) this.emit({ type: 'usage', usage: endChunk.usage });

      const nativeCalls = endChunk?.toolCalls?.length ? endChunk.toolCalls : [];

      if (usedNative && nativeCalls.length) {
        // native tool path (cap parallel calls per turn as a guardrail)
        const calls = nativeCalls.slice(0, MAX_CALLS_PER_TURN);
        if (nativeCalls.length > MAX_CALLS_PER_TURN) {
          this.emit({ type: 'notice', message: `Model emitted ${nativeCalls.length} tool calls in one turn — executing the first ${MAX_CALLS_PER_TURN}.` });
        }
        this.messages.push({ role: 'assistant', content: streamedText, toolCalls: calls });
        this.noteDialect('native');
        let stop = false;
        for (const call of calls) {
          const r = await this.runOneCall({ id: call.id, name: call.name, args: call.args }, 'wire');
          if (r.finished) {
            const gate = await this.handleFinish(r);
            if (gate.accepted) { finalContent = r.finalContent; if (gate.note) finalNote = gate.note; stop = true; break; }
            // refused by the gate → remaining calls still execute; the loop
            // continues so the model can address the missing evidence
          }
        }
        if (stop) break;
        continue;
      }

      // text protocol path (or plain final answer) — Part 2: the dialect
      // ladder accepts json, tagged (<tool_call>…), and pythonic call syntax;
      // conversational prose without tool intent stays prose.
      const action = detectToolDialect(streamedText);
      if (action) this.noteDialect(action.dialect);
      if (!usedNative && action) {
        this.messages.push({ role: 'assistant', content: streamedText });
        const r = await this.runOneCall({ id: `fb_${turn}`, name: action.action.tool, args: action.action.args }, null);
        if (r.finished) {
          const gate = await this.handleFinish(r);
          if (gate.accepted) { finalContent = r.finalContent; finalNote = gate.note; break; }
          continue;
        }
        continue;
      }

      // No tool action at all
      if (!usedNative && !action) {
        // one nudge, then accept the text as final
        if (!this._nudged) {
          this._nudged = true;
          this.emit({ type: 'notice', message: 'Model replied without a JSON tool call — nudging it back to protocol format.' });
          this.messages.push({ role: 'assistant', content: streamedText });
          this.messages.push({ role: 'user', content: FALLBACK_NUDGE });
          continue;
        }
        finalContent = streamedText;
        finalNote = 'Model stopped following the text tool protocol.';
        break;
      }

      // native mode, no tool calls → final answer — unless the model emitted
      // its tool call as TEXT (small models do this even on tool-capable
      // servers); if so, execute it and keep the loop going. Dialect ladder
      // applies here too (tagged/pythonic text is executed, prose is not).
      const textAction = detectToolDialect(streamedText);
      if (textAction) {
        this.noteDialect(textAction.dialect);
        this.emit({ type: 'notice', message: `Model emitted its tool call as text (${textAction.dialect} dialect) — executing ${canonicalToolName(textAction.action.tool)}.` });
        this.messages.push({ role: 'assistant', content: streamedText });
        const r = await this.runOneCall({ id: `nt_${turn}`, name: textAction.action.tool, args: textAction.action.args }, null);
        if (r.finished) {
          const gate = await this.handleFinish(r);
          if (gate.accepted) { finalContent = r.finalContent; finalNote = gate.note; break; }
          continue;
        }
        continue;
      }
      // plain text without a tool intent: in text-mode task runs nudge once
      // (the helper), but NEVER in pure native mode (Test C interference).
      if (this.cfg.allowNudgeOnText && !this._nudged && this.helperAllowed()) {
        this._nudged = true;
        this.emit({ type: 'notice', message: 'Model stopped without calling finish — nudging it to continue with the tool protocol.' });
        this.messages.push({ role: 'assistant', content: streamedText });
        this.messages.push({ role: 'user', content: `${FALLBACK_NUDGE}\nAlso: if any part of the task is not yet verified (e.g. tests not run), continue working with tool calls instead of stopping.` });
        continue;
      }
      finalContent = streamedText;
      break;
    }

    if (turn >= maxTurns && !finalContent) {
      hitTurnLimit = true;
      paused = true;
      finalNote = `Paused after ${maxTurns} turns (configurable turn limit) — all progress is preserved. Press "Continue task" to resume, or raise the limit in Settings → Agent.`;
    }

    // Problem C: the contract records how the run ended (pause/stop), so a
    // resume — with any model — knows the exact interruption point.
    if (cfg.contract && cfg.contract.status !== 'COMPLETE' && (hitTurnLimit || finalContent || finalNote)) {
      cfg.contract.progress.push({ text: hitTurnLimit ? `Paused at turn limit (${maxTurns}) — conversation, tool results and modified files preserved.` : `Run ended: ${(finalContent || finalNote || '').slice(0, 200)}`, at: Date.now(), by: `runner:${cfg.model}` });
      bumpInPlace(cfg.contract);
      this.cfg.onContractUpdate?.(cfg.contract);
    }

    this.emit({ type: 'final', content: finalContent, turns: turn, note: finalNote, canContinue: hitTurnLimit || paused, completion: this.lastCompletion });
    return { content: finalContent, turns: turn, note: finalNote, messages: this.messages, hitTurnLimit, paused, completion: this.lastCompletion, filesChanged: [...this.filesWritten], usage: this.usageTotal };
  }

  // finish handling with the completion gate (Problem D). Returns accepted +
  // a note for the transcript; a refused finish keeps the loop running with
  // the missing evidence fed back as an actionable coordinator message.
  private async handleFinish(r: { finished: boolean; finalContent: string; entry: ToolLogEntry; name: string }): Promise<{ accepted: boolean; note?: string }> {
    const contract = this.cfg.contract;
    if (!contract) return { accepted: true };
    const summary = r.finalContent;
    const { accepted, result } = await this.runCompletionGate(summary);
    this.lastCompletion = result;
    if (accepted) {
      contract.progress.push({ text: `Task completed. ${summary.slice(0, 300)}`, at: Date.now(), by: `finish-gate:${this.cfg.model}` });
      contract.status = 'COMPLETE';
      contract.statusNote = 'Verified by the completion gate.';
      bumpInPlace(contract);
      this.cfg.onContractUpdate?.(contract);
      this.emit({ type: 'completion_gate', status: result.status, missing: [], detail: 'All acceptance criteria verified with captured evidence.' });
      return { accepted: true };
    }
    this.gateRefusals++;
    contract.progress.push({ text: `finish refused by completion gate (${result.status}); missing: ${result.missingCriteria.slice(0, 3).join('; ').slice(0, 200)}`, at: Date.now(), by: `gate:${this.cfg.model}` });
    bumpInPlace(contract);
    this.cfg.onContractUpdate?.(contract);
    this.emit({
      type: 'completion_gate',
      status: result.status,
      missing: result.missingCriteria,
      detail: result.reasons.join(' '),
    });
    // hard bound: twice refused → accept the stop but report the gate result
    if (this.gateRefusals >= 2) {
      contract.status = result.status;
      contract.statusNote = 'Run ended; completion gate verdict recorded (model summary accepted, status NOT verified as COMPLETE).';
      this.cfg.onContractUpdate?.(contract);
      return { accepted: true, note: `Completion gate verdict: ${result.status}. ${result.reasons.join(' ').slice(0, 400)}` };
    }
    this.messages.push({ role: 'user', content: [
      `[COMPLETION GATE — finish refused]`,
      `You called finish, but the coordinator's evidence gate does not allow marking this task COMPLETE.`,
      `Verdict: ${result.status}`,
      result.reasons.length ? `Why:\n${result.reasons.map((x) => `- ${x}`).join('\n')}` : '',
      result.missingCriteria.length ? `Missing evidence:\n${result.missingCriteria.map((x) => `- ${x}`).join('\n')}` : '',
      `Do the remaining work now: satisfy the missing requirements, run the verification commands, and only call finish again when they genuinely pass. Do not re-describe what you already did as if it were verification.`,
    ].filter(Boolean).join('\n') });
    return { accepted: false };
  }

  private noteDialect(d: ToolDialect) {
    this.cfg.onDialectLearned?.(d, this.cfg.model);
    this.emit({ type: 'dialect_learned', dialect: d, model: this.cfg.model });
  }
}

function capOutput(s: string) {
  return s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + '\n...[truncated]' : s;
}

// Deterministic signature for the repetition guard: sorted keys, so
// {path,find} and {find,path} are the same call.
function stableArgs(args: Record<string, any>): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(args));
}

// Problem A: classify a successful result. "EMPTY/MISSING/No matches" outputs
// are successful results that carry no new information — the journal records
// them as ok-empty so recovery guidance can say so explicitly.
function classifyEmpty(tool: string, output: string): 'ok-empty' | 'ok-nonempty' {
  if (READ_TOOLS.has(tool) || tool === 'run_tests') {
    if (/^\(empty directory|^EMPTY:|^MISSING:|^No matches|^No detached processes|^No entries returned|No test command could be auto-detected|^No dependency manifest/.test(output.trim())) {
      return 'ok-empty';
    }
  }
  return 'ok-nonempty';
}

function exitFromOutput(output: string): number | null {
  const m = output.match(/^exit code: (-?\d+|null)/m);
  if (!m) return null;
  return m[1] === 'null' ? null : Number(m[1]);
}

// Recovery alternatives tailored to the stalled call (Problem A).
function suggestAlternatives(tool: string, args: Record<string, any>, outcome: JournalEntry['outcome']): string[] {
  const p = canonRelPath(args.path ?? '');
  if (tool === 'list_dir' && outcome === 'ok-empty') {
    return [
      `Call workspace_info to re-anchor on the canonical workspace root and machine.`,
      `List the workspace root: list_dir(".") — the folder you expected may be nested (e.g. after an archive extraction) or differently named.`,
      `If the directory is genuinely where the task's files should be, CREATE them: write_file for each file the task needs, then verify.`,
    ];
  }
  if (tool === 'list_dir') {
    return [`Call workspace_info, then list_dir(".") to see what actually exists at the root.`];
  }
  if (tool === 'read_file') {
    return [`List the parent directory (list_dir) to find the correct file name; paths are case- and spelling-sensitive.`];
  }
  if (tool === 'run_command' || tool === 'run_tests' || tool === 'run_build') {
    return [
      `Read the actual error output above and change ONE thing (code edit, different command, different flags) before retrying.`,
      `Inspect the relevant files with read_file to understand the failure instead of re-running blind.`,
    ];
  }
  if (tool === 'search_project') {
    return [`Try a different query term or a broader glob; or list the directories you care about directly.`];
  }
  return [
    `Change approach: inspect the workspace (workspace_info, list_dir("."))
 before retrying anything.`,
    `Take a concrete step toward the remaining requirements (write/edit a file, run a verification command).`,
  ];
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  const first = keys.includes('path') ? String(args.path) : keys.includes('command') ? String(args.command).slice(0, 60) : keys[0] ? String(args[keys[0]]).slice(0, 40) : '';
  return `${keys.slice(0, 2).join(',')}=${first}`.slice(0, 80);
}

function summarizeCall(def: ToolDef, args: Record<string, any>): string {
  if (def.name === 'delete_path') return `Delete ${args.path}`;
  if (def.name === 'run_command' || def.name === 'run_tests' || def.name === 'run_build' || def.name === 'install_dependencies') {
    return `Run command: ${args.command ?? '(auto-detect script)'}`;
  }
  return `${def.name} ${summarizeArgs(args)}`;
}
