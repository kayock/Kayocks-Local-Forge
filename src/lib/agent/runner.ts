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
import { parseToolCallArgs } from './toolargs';
import { detectToolDialect, type ToolDialect } from './dialects';
import { evaluateCompletion } from './completion';
import { buildHandoffPacket, contractPromptBlock, bumpInPlace, type TaskContract } from './task-contract';
import { RecoveryCoordinator, canonicalSignature, type StallClass } from './recovery';

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
  // Milestone 4: evidence-triggered automatic steering (truncated edits,
  // stuck validation streaks). Default on; false disables entirely.
  autoSteering?: boolean;
  // regex-source strings; writes/edits/deletes to matching paths are refused
  protectedPaths?: string[];
  // ---- Forge upgrade (Problems A/C/D/E, Part 2) ----
  // canonical workspace identity surfaced to tools and tool feedback
  workspaceMeta?: { id: string; rootPath: string; machineLabel: string; platform: string; projectName?: string; knownTree?: string };
  // Cline-style Plan/Act: 'plan' strips mutating tools and switches the
  // system prompt to read-only investigation + planning.
  devMode?: 'plan' | 'act';
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
const REPEAT_EXEMPT = new Set(['finish']);
// Plan mode (Cline Plan/Act): mutating tools are removed from the run and
// hard-blocked at execution time (defense in depth).
const PLAN_BLOCKED = new Set(['write_file', 'edit_file', 'append_file', 'create_dir', 'delete_path', 'extract_archive', 'install_dependencies', 'launch_app', 'stop_process']);
// After the recovery ladder is exhausted, this many further NO-PROGRESS
// turns (blocked calls or pure activity) trigger the honest stop. A genuine
// write/edit resets the counter — the model keeps its finish window.
const STALL_STOP_AFTER_NO_PROGRESS = 4;
// Tools whose success changes workspace state (drives the workspace version
// used to distinguish pointless repetition from legitimate re-runs).
const FS_WRITERS = new Set(['write_file', 'edit_file', 'create_dir', 'delete_path', 'extract_archive']);
const FS_MAYBE_WRITERS = new Set(['run_command', 'launch_app', 'stop_process', 'install_dependencies', 'run_tests', 'run_build']);
const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_project', 'process_status', 'workspace_info', 'workspace_map']);

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
  // Milestone 4: true when the coordinator stopped the run honestly after
  // exhausting the recovery ladder (an actionable stopped state, not a hang)
  stalled?: boolean;
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
  // Milestone 4: outcome-aware recovery + honest stalled stop
  private recovery: RecoveryCoordinator;
  private stallStop: { tool: string; sig: string; stallClass: StallClass } | null = null;
  private lastStallClass: StallClass = 'repetition';
  // Milestone 4 (refined): after the ladder exhausts, the model still gets a
  // finish window — the honest stop fires only after repeated further blocks,
  // or at the turn limit without completion (stallPending).
  private exhaustedNotified = new Set<string>();
  private turnsAfterExhausted = 0;
  private stallPending = false;
  private lastBoundaryHadManual = false;
  private boundariesSinceManual = 99;
  private sentEnvelopes = new Set<string>();
  // Milestone 1: cumulative token usage for the run (from usage events)
  private usageTotal: { promptTokens: number | null; completionTokens: number | null } = { promptTokens: null, completionTokens: null };

  /** Plan mode removes mutating tools from the run entirely. */
  private toolsForRun(): ToolDef[] {
    if (this.cfg.devMode !== 'plan') return this.cfg.tools;
    return this.cfg.tools.filter((t) => !PLAN_BLOCKED.has(t.name));
  }

  constructor(private cfg: RunnerConfig) {
    this.protocol = normalizeProtocolMode(cfg.toolProtocol);
    if (cfg.initialSteering?.length) this.steeringQueue.push(...cfg.initialSteering);
    this.recovery = new RecoveryCoordinator({
      contract: cfg.contract,
      autoSteering: cfg.autoSteering,
      onEvent: (e) => {
        if (e.kind === 'auto_steering') {
          this.emit({ type: 'auto_steering', trigger: e.trigger!, text: e.message });
        } else if (e.kind === 'recovery_action') {
          this.emit({ type: 'recovery_action', action: e.action!, stallClass: e.stallClass!, step: e.step!, message: e.message });
        } else if (e.kind === 'stalled') {
          this.emit({ type: 'stalled', message: e.message });
        } else if (e.kind === 'streak_recovery') {
          this.emit({ type: 'loop_detected', tool: 'validation', count: 3, action: 'recovery', message: e.message });
        }
      },
      onEscalation: (e) => {
        this.cfg.onEscalation?.({ kind: e.kind, message: e.message });
        this.emit({ type: 'escalation', fromModel: this.cfg.model, reason: e.message });
      },
    });
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
      // Milestone 3: durable project memory + shared notebook/scratchpad over
      // the workspace host companion. Absent methods (mocks) → tools report
      // availability honestly.
      memory: this.buildMemoryHost(companion),
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

  // Milestone 3: memory host over the workspace-host companion. Every method
  // degrades with a clear error when the companion lacks the memory API.
  private buildMemoryHost(companion: CompanionClient): NonNullable<ToolContext['memory']> | undefined {
    const c = companion as any;
    if (typeof c.memorySearch !== 'function') return undefined;
    const wsId = this.cfg.workspaceId;
    const agentTag = this.cfg.workspaceMeta?.machineLabel ? `agent@${this.cfg.workspaceMeta.machineLabel}` : 'agent';
    return {
      search: (q, opts) => c.memorySearch(wsId, q, opts),
      read: (id) => c.memoryRead(wsId, id),
      write: (kind, content, opts) => c.memoryWrite(wsId, { kind, content, tags: opts?.tags, refs: opts?.refs, agentId: agentTag }),
      notebookAppend: (kind, content, opts) => c.notebookAppend(wsId, { agentId: agentTag, kind, content, refs: opts?.refs }),
      notebookSearch: (q, opts) => (async () => {
        const r = await c.notebookList(wsId, opts);
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        const results = (r.entries || []).filter((e: any) => {
          const hay = `${e.kind} ${e.agentId} ${e.content}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        }).slice(0, opts?.limit ?? 20);
        return { results };
      })(),
      readScratchpad: (agentId) => c.readScratchpad(wsId, agentId),
      writeScratchpad: (agentId, patch) => c.writeScratchpad(wsId, agentId, patch),
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
    const entry: ToolLogEntry = {
      id: `t_${++this.logId}`,
      tool: name,
      args: {},
      status: 'running',
      startedAt: Date.now(),
      machine: this.cfg.workspaceMeta?.machineLabel,
    };

    const finishArgs = () => { entry.endedAt = Date.now(); };

    // Milestone 4: TRUNCATED tool-call arguments are refused, not silently
    // repaired into broken writes. A call cut off mid-JSON (large write_file
    // payloads are the classic case) triggers automatic steering toward
    // small, targeted edits.
    if (typeof rawArgs === 'string') {
      const parsed = parseToolCallArgs(rawArgs);
      if (!parsed.ok || parsed.truncated) {
        entry.args = { _raw: parsed.rawPreview ?? '' };
        entry.argsTruncated = !!parsed.truncated;
        entry.argsError = parsed.error ?? 'truncated tool-call arguments';
        entry.status = 'error';
        entry.validation = parsed.truncated ? 'schema-invalid' : undefined;
        entry.parse = parsed.truncated ? 'truncated' : 'failed';
        entry.output = [
          `Error: tool-call arguments could not be parsed${parsed.truncated ? ' — the call looks TRUNCATED (cut off mid-JSON)' : ''}. The call was NOT executed. No files were changed by this call.`,
          parsed.error ? `Parse failure: ${parsed.error}` : '',
          parsed.rawPreview ? `Received (capped): ${parsed.rawPreview.slice(0, 400)}` : '',
          'Re-issue the COMPLETE call with valid JSON arguments. For very large files, build them with several append_file calls instead of one huge write_file, or use edit_file with SHORT find/replace snippets.',
        ].filter(Boolean).join('\n');
        // failure-pattern recovery guidance on the entry itself (spec §3):
        const guidance = this.recovery.noteInvalidCall(name, entry.argsError, { truncated: true });
        if (guidance) { entry.output += `\n${guidance}`; entry.recoveryIssued = true; }
        finishArgs();
        this.emit({ type: 'tool_end', call: { id: callId, name, args: entry.args }, entry });
        if (parsed.truncated && ['write_file', 'edit_file', 'append_file'].includes(name)) {
          this.recovery.queueAutoSteering('truncated-edit', [
            'Your last large file write was TRUNCATED (cut off mid-JSON) and was NOT applied to the workspace.',
            'Trigger: truncated-edit',
            'Prefer small, targeted edits: use edit_file for in-place changes and append_file to build large files in sections. Keep every single tool call small enough to finish.',
          ].join('\n'));
        }
        return { entry, args: entry.args, name };
      }
    }

    // clean/repaired string payloads: use the PARSED args (normalizeToolArgs
    // would otherwise fail its own JSON.parse on damaged-but-repairable args).
    let parseNote = '';
    let parseFrom: 'object' | 'clean' | 'repaired' | 'truncated' | 'failed' = 'object';
    let normalizedRaw: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      const parsed = parseToolCallArgs(rawArgs);
      parseFrom = parsed.from === 'raw' ? 'failed' : parsed.from;
      normalizedRaw = parsed.args ?? rawArgs;
      if (parsed.repairs?.length) {
        parseNote = `Note: arguments needed serialization repair (${parsed.repairs.slice(0, 3).join('; ')}) — the repaired payload was executed.`;
      }
    }
    const { args, aliasesApplied } = normalizeToolArgs(rawName, normalizedRaw);
    entry.args = args;
    entry.parse = parseFrom;
    if (parseNote) entry.output = parseNote;
    if (aliasesApplied && Object.keys(aliasesApplied).length) {
      entry.output = `${entry.output ? entry.output + '\n' : ''}Note: argument aliases normalized: ${Object.entries(aliasesApplied).map(([a, b]) => `${a} → ${b}`).join(', ')}.`;
    }

    // unknown tool → exact repair information
    const def = this.toolsForRun().find((t) => t.name === name);
    if (!def && this.cfg.devMode === 'plan' && PLAN_BLOCKED.has(name)) {
      entry.status = 'error';
      finishArgs();
      entry.output = `Plan mode: "${name}" is disabled — this run is read-only. Investigate and produce the plan; the user approves execution in Act mode.`;
      this.emit({ type: 'tool_end', call: { id: callId, name, args }, entry });
      return { entry, args, name };
    }
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
      entry.validation = 'schema-invalid';
      finishArgs();
      const guidance = this.recovery.noteInvalidCall(name, invalid);
      entry.output = guidance ? `${invalid}\n${guidance}` : invalid;
      if (guidance) entry.recoveryIssued = true;
      return { entry, args, name };
    }

    // repetition guard (spec §3.7 + Forge Problem A + Milestone 4): identical
    // calls are blocked only when the workspace has NOT changed since the
    // last attempt. Canonical signatures make equivalent spellings collide
    // (bare list_dir ≡ list_dir {path:'.'}). Blocks feed the recovery
    // ladder: refocus → strategy directive → honest stalled stop.
    const sig = canonicalSignature(name, args);
    const prev = this.recentCalls.get(sig);
    if (prev && !REPEAT_EXEMPT.has(name) && prev.workspaceVersion === this.workspaceVersion) {
      const reads = READ_TOOLS.has(name);
      const limit = prev.status === 'ok' ? (reads ? REPEAT_LIMIT_READS : REPEAT_LIMIT_DEFAULT) : REPEAT_LIMIT_FAILED;
      const emptyButOk = prev.outcome === 'ok-empty';
      // A successful COMMAND with empty output (exit 0, no stdout) is exempt
      // from repetition blocking: it cannot be "re-derived" for new info, the
      // per-agent turn limit remains the hard bound, and stage agents with
      // scripted no-op warmups must reach their OWN turn limits (Test E).
      // READ tools returning MISSING/EMPTY are NOT exempt — a discovery loop
      // on a missing path is exactly the repetition stall the guard exists for.
      if (prev.count >= limit && !(emptyButOk && FS_MAYBE_WRITERS.has(name))) {
        prev.blocked++;
        const changedHint = prev.status === 'ok'
          ? 'Repeating it cannot produce new information.'
          : 'Repeating the exact same failing call with identical arguments will fail identically.';
        entry.status = prev.status === 'ok' ? 'ok' : 'error';
        entry.outcome = 'blocked';
        entry.repeatBlocked = true;
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
        this.recentCalls.set(sig, {
          count: prev.count,
          blocked: prev.blocked,
          status: prev.status,
          outcome: prev.outcome,
          output: prev.output,
          workspaceVersion: this.workspaceVersion,
        });
        // Milestone 4: the two-step recovery ladder, then the honest stop.
        const stallClass: StallClass = this.recovery.classify() ?? (prev.status === 'error' ? 'verification' : 'repetition');
        this.lastStallClass = stallClass;
        const env = this.recovery.nextStep(sig, stallClass, {
          tool: name,
          lastResult: prev.output,
          alternatives: suggestAlternatives(name, args, prev.outcome),
          contract: this.cfg.contract,
        });
        if (env) {
          this.messages.push({ role: 'user', content: env.text });
          // compatibility: stall_detected keeps firing on the first step
          if (env.text.includes('ACTIVE RECOVERY 1/2')) {
            this.emit({
              type: 'stall_detected',
              tool: name,
              attempts: prev.count + prev.blocked,
              message: `No progress after ${prev.count + prev.blocked} attempts of ${name} — coordinator recovery envelope injected.`,
            });
          }
        } else {
          // ladder exhausted: give the model ONE final envelope per signature
          // and keep the run alive briefly so it can still call finish —
          // the honest stop fires after repeated further blocks.
          if (!this.exhaustedNotified.has(sig)) {
            this.exhaustedNotified.add(sig);
            this.stallPending = true;
            this.messages.push({ role: 'user', content: [
              `[COORDINATOR — RECOVERY EXHAUSTED]`,
              `The ${name} call was blocked again after two recovery steps (${this.lastStallClass} stall).`,
              `This is the final coordinator intervention: call finish now with an honest summary of what was completed, what remains open, and which requirements are unmet (status PARTIAL/BLOCKED). Do not repeat the blocked call.`,
            ].join('\n') });
          }
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
      this.recovery.noteValidCall();
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
          const p = canonRelPath(args.path ?? res.changedFile ?? '');
          if (p) {
            this.filesWritten.add(p);
            // Milestone 4: measurable progress recorded on the contract with
            // the actual file evidence (never just the model's claim).
            if (this.cfg.contract && entry.status === 'ok') {
              this.cfg.contract.progress.push({ text: `${name} succeeded: ${p}`, at: Date.now(), by: `runner:${this.cfg.model}`, filesTouched: [p] });
              bumpInPlace(this.cfg.contract);
              this.cfg.onContractUpdate?.(this.cfg.contract);
            }
          }
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

  // Milestone 4: the old per-block escalation was replaced by the recovery
  // coordinator (recovery.ts): a global two-step ladder (workspace_refocus →
  // strategy_directive) driven by real tool evidence, then an honest stalled
  // stop. Model escalation still happens when a replacement is configured —
  // see finalizeStalled().

  private lastSuccess(): string | null {
    let last: string | null = null;
    for (const [sig, e] of this.recentCalls) {
      if (e.status === 'ok') last = `${sig.split('::')[0]} → ${e.output.slice(0, 120)}`;
    }
    return last;
  }

  // Milestone 4: pure-activity backstop — even without an identical-call
  // block, turns of reads/retries with zero writes/verification trigger the
  // same two-step ladder and then the honest stop.
  private checkActivityStall(): boolean {
    const cls = this.recovery.classify();
    if (!cls || this.stallStop) return false;
    const sig = `activity-stall:${cls}`;
    const env = this.recovery.nextStep(sig, cls, {
      tool: 'turns without measurable progress',
      lastResult: this.lastSuccess() || 'no successful operations recorded',
      alternatives: [
        'Re-read the task contract requirements and take ONE concrete step toward the next open one (write/edit a file, run the verification command).',
        'Call finish with an honest PARTIAL/BLOCKED summary if the task genuinely cannot progress.',
      ],
      contract: this.cfg.contract,
    });
    if (env) {
      this.messages.push({ role: 'user', content: env.text });
      return false;
    }
    // Ladder consumed: count no-progress turns; the honest stop fires after a
    // bounded finish window (a real write resets it — see noteTurn).
    this.turnsAfterExhausted++;
    if (this.turnsAfterExhausted >= STALL_STOP_AFTER_NO_PROGRESS) {
      this.stallStop = { tool: 'no-progress turns after exhausted recovery', sig, stallClass: cls };
      return true;
    }
    this.stallPending = true;
    return false;
  }

  // Milestone 4: the honest stalled verdict. The run stops instead of
  // looping; contract records BLOCKED with open problems; the IDE can resume
  // ("Continue task"), steer, or switch models — full history is preserved.
  private finalizeStalled(): { content: string; note: string } {
    const contract = this.cfg.contract;
    const openReqs = (contract?.requirements ?? []).filter((r) => r.source === 'user' && r.status === 'open').map((r) => r.text);
    const note = [
      `STALLED — the coordinator stopped this run after repeated ${this.lastStallClass} stalls with no workspace progress.`,
      `Requirements still open: ${openReqs.length ? openReqs.slice(0, 5).join(' | ') : '(see task contract)'}`,
      `Next steps: press "Continue task" and steer the agent with concrete instructions, or switch models in Settings → Agent and continue from the preserved history.`,
      `All progress, tool results and the complete conversation are preserved — nothing was lost.`,
    ].join('\n');
    if (contract && contract.status === 'ACTIVE') {
      contract.status = 'BLOCKED';
      contract.statusNote = 'stalled-run verdict: the recovery ladder was exhausted without measurable workspace progress; blocked honestly rather than looping.';
      contract.openProblems.push(`Stalled: repeated ${this.lastStallClass} stalls on ${this.stallStop?.tool ?? 'repeated calls'} — recovery exhausted after two coordinator actions.`);
      bumpInPlace(contract);
      this.cfg.onContractUpdate?.(contract);
    }
    this.recovery.noteTurn(true, 0); // reset pressure for the resumed run
    this.recovery.postExhaustionProgress();
    this.exhaustedNotified.clear();
    this.emit({ type: 'stalled', message: note.split('\n')[0] });
    this.stallStop = null;
    return { content: '', note };
  }

  private async runOneCall(call: { id: string; name: string; args?: unknown }, messageId: string | null): Promise<{ finished: boolean; finalContent: string; entry: ToolLogEntry; name: string }> {
    this.emit({ type: 'tool_start', call: { id: call.id, name: canonicalToolName(call.name), args: normalizeToolArgs(call.name, call.args).args } });
    const { entry, args, name } = await this.executeCall(call.name, call.args, call.id);
    // Transport protection (spec §1): a huge/truncated raw payload must not be
    // re-sent to the model in every later turn — cap it in the HISTORY (the
    // tool entry keeps the diagnostic preview).
    if ((entry.parse === 'truncated' || entry.parse === 'failed') && typeof call.args === 'string' && call.args.length > 800) {
      call.args = { _raw: `${call.args.slice(0, 500)}…[${call.args.length} chars — capped in history; the call was NOT executed]` };
    }
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
    // Context protection + envelope dedup: each coordinator recovery envelope
    // is delivered to the model in EXACTLY ONE payload (the turn it was
    // injected for). Later payloads carry a short marker instead — the
    // guidance was already delivered; re-sending copies would bloat every
    // subsequent turn without adding information.
    const sentEnvelopes = this.sentEnvelopes;
    const wire = this.messages.map((m) => {
      if (m.role === 'user' && typeof m.content === 'string' && (m.content.startsWith('[COORDINATOR RECOVERY') || m.content.startsWith('[COORDINATOR — RECOVERY EXHAUSTED]'))) {
        if (sentEnvelopes.has(m.content)) {
          return { role: 'user', content: '[Coordinator recovery guidance was delivered earlier — follow it. Do not repeat the blocked call.]' };
        }
        sentEnvelopes.add(m.content);
      }
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
    return this.toolsForRun().map((t) => ({
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
    let stalledOut = false;

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
      this.lastBoundaryHadManual = false;
      this.boundariesSinceManual++;
      if (this.steeringQueue.length) {
        const notes = this.steeringQueue.splice(0, this.steeringQueue.length);
        this.lastBoundaryHadManual = true;
        this.boundariesSinceManual = 0;
        this.messages.push({
          role: 'user',
          content: `[USER STEERING]\n(Highest priority — applies immediately)\n${notes.map((n) => `- ${n}`).join('\n')}\nAcknowledge briefly and follow it now; it overrides earlier instructions and the current approach.`,
        });
        this.emit({ type: 'steering_applied', message: `User steering applied: ${notes.map((n) => n.slice(0, 80)).join(' | ')}` });
      }
      // Milestone 4: automatic steering arrives AFTER manual steering —
      // never interleaved in the same boundary, never discarded. Manual
      // delivery this turn defers the automatic queue to the next boundary.
      // Deliver automatic notes only at a boundary WITHOUT fresh manual
      // steering, or once they have waited at least one full boundary.
      this.recovery.tickAutoPending();
      // Automatic guidance waits for a clean boundary: it goes out only when
      // NO manual steering was delivered here and at least one boundary has
      // passed since the last manual delivery (manual always wins priority).
      const manualJustDelivered = this.lastBoundaryHadManual;
      this.lastBoundaryHadManual = false;
      if (!manualJustDelivered && this.boundariesSinceManual >= 2) {
        const autoNotes = this.recovery.drainAutoSteering();
        if (autoNotes.length) {
          for (const a of autoNotes) {
            this.messages.push({ role: 'user', content: `[AUTOMATIC STEERING]\n${a.text}\nAcknowledge briefly and adjust your approach now.` });
            this.emit({ type: 'steering_applied', message: `Automatic steering delivered (${a.trigger}).` });
          }
        }
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
      let turnProgress = false;

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
          const r = await this.runOneCall(call, 'wire');
          if (callProgressed(r.entry)) turnProgress = true;
          if (this.stallStop) break;
          if (r.finished) {
            const gate = await this.handleFinish(r);
            if (gate.accepted) { finalContent = r.finalContent; if (gate.note) finalNote = gate.note; stop = true; break; }
            // refused by the gate → remaining calls still execute; the loop
            // continues so the model can address the missing evidence
          }
        }
        if (stop) break;
        if (this.stallStop) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
        }
        this.recovery.noteTurn(turnProgress, turn);
        if (this.checkActivityStall()) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
        }
        continue;
      }

      // text protocol path (or plain final answer) — Part 2: the dialect
      // ladder accepts json, tagged (…), and pythonic call syntax;
      // conversational prose without tool intent stays prose.
      const action = detectToolDialect(streamedText);
      if (action) this.noteDialect(action.dialect);
      if (!usedNative && action) {
        this.messages.push({ role: 'assistant', content: streamedText });
        const r = await this.runOneCall({ id: `fb_${turn}`, name: action.action.tool, args: action.action.args }, null);
        if (callProgressed(r.entry)) turnProgress = true;
        if (this.stallStop) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
        }
        if (r.finished) {
          const gate = await this.handleFinish(r);
          if (gate.accepted) { finalContent = r.finalContent; finalNote = gate.note; break; }
          continue;
        }
        this.recovery.noteTurn(turnProgress, turn);
        if (this.checkActivityStall()) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
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
        if (callProgressed(r.entry)) turnProgress = true;
        if (this.stallStop) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
        }
        if (r.finished) {
          const gate = await this.handleFinish(r);
          if (gate.accepted) { finalContent = r.finalContent; finalNote = gate.note; break; }
          continue;
        }
        this.recovery.noteTurn(turnProgress, turn);
        if (this.checkActivityStall()) {
          const stalled = this.finalizeStalled();
          finalNote = stalled.note;
          stalledOut = true;
          break;
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
    return { content: finalContent, turns: turn, note: finalNote, messages: this.messages, hitTurnLimit, paused, completion: this.lastCompletion, filesChanged: [...this.filesWritten], usage: this.usageTotal, stalled: stalledOut };
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

// Milestone 4: what counts as MEASURABLE progress for stall classification —
// successful writes/edits, passing verification, real state changes. Reads
// and blocked calls are activity, never progress.
function callProgressed(entry: ToolLogEntry): boolean {
  if (entry.status !== 'ok' || entry.outcome === 'blocked') return false;
  // An exit-0 command with EMPTY output (e.g. `true`, `cd x`) is forward motion
  // for the stall clock only: the hard per-agent turn limit stays the safety
  // net, and the repetition guard below does not block it either. Discovery
  // loops (nonempty outputs, errors) still count as stalls (Phase 2 tests).
  if (entry.outcome === 'ok-empty' && FS_MAYBE_WRITERS.has(entry.tool)) return true;
  // Measurable progress = real state changes or PASSING verification. The
  // FS_MAYBE_WRITERS branch marks commands fsChanged=true for journaling, so
  // progress must classify by TOOL here: a bare `ls -la` success is activity
  // (otherwise a command cycle would reset the stall clock forever).
  if (entry.tool === 'run_tests' || entry.tool === 'run_build') {
    return exitFromOutput(entry.output || '') === 0;
  }
  if (entry.tool === 'install_dependencies') return true;
  if (FS_MAYBE_WRITERS.has(entry.tool)) return false;
  return entry.fsChanged === true;
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
  // Commands: exit 0 with NO stdout content is a genuinely empty success
  // (`true`, `cd x`) — distinct from a discovery command that returned data.
  if (tool === 'run_command' || tool === 'launch_app') {
    const exit = exitFromOutput(output);
    if (exit === 0) {
      const body = output
        .replace(/^exit code: .*$/gim, '')
        .replace(/^cwd: .*$/gim, '')
        .replace(/^duration: .*$/gim, '')
        .replace(/^\$ .*$/gim, '')
        .replace(/^\[Timed out[^\]]*\]$/gim, '')
        .trim();
      if (!body) return 'ok-empty';
    }
  }
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
