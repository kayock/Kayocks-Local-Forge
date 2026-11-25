// Coordinator (Phase 2.0 Checkpoint 4, spec §6): assigns development work to
// agents running on DIFFERENT machines and inference providers, while every
// agent's tools act on ONE authoritative workspace (its selected host) through
// that host's authorized companion.
//
// Design (extends — never replaces — the working AgentRunner):
//  - each agent = one AgentRunner; `companion` = the agent's MACHINE companion
//    (model inference + local process tools), `toolCompanion` = the workspace
//    host companion (fs/exec on the authoritative project).
//  - assignments are persisted on the workspace host (/api/agents/<ws>/...),
//    private scratchpads per agent, append-only shared notebook.
//  - conflict detection: the coordinator snapshots the workspace revision
//    before/after each agent; concurrent overlapping writes are flagged,
//    both changes preserved, and the coordinator reconciles (re-test/review).
//  - escalation: an agent that cannot progress (repeated recovery) is
//    reassigned or reported to the user — never silently dropped.
import type { CompanionClient } from '@/lib/companion/client';
import type { MeshClient } from '@/lib/mesh/client';
import type { InferenceParams, ProviderConfig } from '@/lib/types';
import type { AgentEvent, AgentMessage, Approver, ToolProtocolMode } from './types';
import type { AgentAssignment, ModelProfile } from '@/lib/mesh-types';
import { AgentRunner, type RunResult } from './runner';
import { toolsByNames } from './tools';
import { rankCandidates, type AgentRole, type SchedulerCandidate, type SchedulerMachine } from './scheduler';
import { plannerPrompt, coderPrompt, testerPrompt, reviewerPrompt, debuggerPrompt, type WorkspaceContext } from './prompts';
import { genAssignmentId } from '@/lib/store/mesh';
import { collaborationRequiresExecution, evaluateObjectiveAcceptance, type ObjectiveAcceptance, type TestEvidence } from './acceptance';
import { paramsWithThinking, type ThinkingMode } from './thinking';
import {
  checkAcceptanceCommands,
  extractAcceptanceCommands,
  assessReviewEvidence,
  parseReviewerVerdict,
  plannerRetryTask,
  planningDeliverable,
  requiredReviewPaths,
  reviewFollowup,
  reviewReads,
  type PlanningStatus,
  type CollaborationCompletion,
  type ReviewerVerdict,
} from './collab-policy';

export type StageId = 'planner' | 'coder' | 'tester' | 'reviewer' | 'debugger';

export const STAGE_TOOLS: Record<StageId, string[]> = {
  planner: ['memory_search', 'memory_write', 'notebook_search', 'notebook_append', 'finish'],
  coder: ['list_dir', 'read_file', 'write_file', 'append_file', 'edit_file', 'create_dir', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_build', 'run_tests', 'memory_search', 'memory_write', 'notebook_append', 'notebook_search', 'read_scratchpad', 'write_scratchpad', 'finish'],
  tester: ['list_dir', 'read_file', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_tests', 'run_build', 'memory_search', 'notebook_search', 'finish'],
  reviewer: ['list_dir', 'read_file', 'search_project', 'memory_search', 'notebook_search', 'finish'],
  debugger: ['list_dir', 'read_file', 'edit_file', 'append_file', 'search_project', 'run_command', 'run_tests', 'run_build', 'process_status', 'stop_process', 'memory_search', 'memory_write', 'notebook_append', 'finish'],
};

export interface AgentTarget {
  // where the agent's MODEL runs
  machineId: string;        // 'local' or mesh peer id
  machineName: string;
  provider: ProviderConfig;
  model: string;
  // optional explicit profile (Model Manager) whose load is managed on demand
  profileId?: string;
  residency?: 'on-demand' | 'keep-loaded';
  // Per-agent configuration (Phase 2.2 Fix 3): each agent runs with its OWN
  // protocol and turn allowance — a reassigned replacement brings its own.
  toolProtocol?: ToolProtocolMode | 'auto-native' | 'force-text';
  maxTurns?: number;
  // false: eligible for an explicit stage assignment, not for automatic
  // ranking or failure fallback.
  allowAutomatic?: boolean;
  // Omitted or 'auto' leaves the provider default. This does not change
  // another participant's setting.
  thinking?: ThinkingMode;
  // Allocated context measured from the running server. This does not resize it.
  liveContextTokens?: number | null;
}

export interface CoordinatorConfig {
  // authoritative workspace host
  workspaceHost: CompanionClient;
  workspaceId: string;
  workspacePath: string;
  workspaceContext: WorkspaceContext;
  mesh: MeshClient;
  params?: Partial<InferenceParams>;
  task: string;
  // candidate machines with their model profiles (from the Model Manager)
  machines: AgentTarget[];
  // per-stage model size hints (bytes) for the scheduler — from inventory
  modelSizes?: Record<string, number | null>; // profileId or `${machineId}:${model}` → bytes
  maxTurnsPerStage?: number;
  reworkPasses?: number;
  // When set, stages not listed are not run. The default pipeline is unchanged.
  stages?: StageId[];
  reassignOnEscalation?: boolean;
  toolProtocol?: ToolProtocolMode | 'auto-native' | 'force-text';
  autoSteering?: boolean;
  // Exact commands that must pass from the workspace root. When omitted,
  // commands named in the task as acceptance commands are used.
  acceptanceCommands?: string[];
  onEvent: (e: AgentEvent & { stage?: string; agentId?: string; assignmentId?: string }) => void;
  approver?: Approver;
  allowedPatterns?: Set<string>;
  signal?: AbortSignal;
  // factory so the coordinator can build routed clients for remote machines
  // (IDE passes one built over the mesh proxy; tests pass fakes)
  clientForMachine: (machineId: string) => CompanionClient;
  // load a model on a machine on demand (Model Manager); returns endpoint or null
  ensureModelLoaded?: (target: AgentTarget) => Promise<{ provider: ProviderConfig; model: string } | null>;
}

export interface CoordinatorReport {
  plan: string;
  results: { stage: StageId; assignmentId: string; agentId: string; machine: string; model: string; summary: string; turns: number; conflict?: string | null; escalated?: boolean; hitTurnLimit?: boolean }[];
  verdict: ReviewerVerdict;
  completion: CollaborationCompletion;
  planning: PlanningStatus;
  reworkPassesUsed: number;
  totalTurns: number;
  conflicts: string[];
  objectiveAcceptance: ObjectiveAcceptance;
}

const ROLE_OF_STAGE: Record<StageId, AgentRole> = {
  planner: 'planner',
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
  debugger: 'debugger',
};

function stagePrompt(stage: StageId, ctx: WorkspaceContext): string {
  switch (stage) {
    case 'planner': return plannerPrompt(ctx);
    case 'coder': return coderPrompt(ctx);
    case 'tester': return testerPrompt(ctx);
    case 'reviewer': return reviewerPrompt(ctx);
    case 'debugger': return debuggerPrompt(ctx);
  }
}

export class Coordinator {
  private machineStates = new Map<string, SchedulerMachine>();

  constructor(private cfg: CoordinatorConfig) {}

  /** Build scheduler candidates from REAL machine + inventory data. */
  async gatherCandidates(): Promise<{ machines: SchedulerMachine[]; candidates: SchedulerCandidate[] }> {
    const machines: SchedulerMachine[] = [];
    const candidates: SchedulerCandidate[] = [];
    for (const t of this.cfg.machines) {
      let hw: SchedulerMachine['hardware'] = null;
      let reachable = false;
      let loadedModels: string[] = [];
      let busyPorts: number[] = [];
      try {
        if (t.machineId === 'local') {
          const inv = await this.cfg.mesh.models();
          hw = {
            cpuCores: inv.hardware.cpuCores,
            ramAvailableBytes: inv.hardware.ramAvailableBytes,
            ramTotalBytes: inv.hardware.ramTotalBytes,
            gpus: inv.hardware.gpus,
            npu: inv.hardware.npu,
          };
          reachable = true;
          loadedModels = inv.servers.filter((s) => s.status === 'ready').map((s) => s.profileName);
          busyPorts = inv.servers.filter((s) => s.status === 'ready' || s.status === 'loading').map((s) => s.port ?? -1);
        } else {
          const ps = await this.cfg.mesh.peerStatus(t.machineId);
          reachable = ps.reachable && !!ps.hardware;
          if (ps.hardware) {
            hw = {
              cpuCores: ps.hardware.cpuCores,
              ramAvailableBytes: ps.hardware.ramAvailableBytes,
              ramTotalBytes: ps.hardware.ramTotalBytes,
              gpus: ps.hardware.gpus,
              npu: ps.hardware.npu,
            };
          }
          // peer model inventory via the mesh proxy
          const peerInv = await this.cfg.mesh.peerModels(t.machineId);
          loadedModels = peerInv?.servers.filter((s) => s.status === 'ready').map((s) => s.profileName) ?? [];
          busyPorts = peerInv?.servers.filter((s) => s.status === 'ready' || s.status === 'loading').map((s) => s.port ?? -1) ?? [];
        }
      } catch { reachable = false; }
      const m: SchedulerMachine = { id: t.machineId, name: t.machineName, hardware: hw, reachable, loadedModels, busyPorts };
      machines.push(m);
      this.machineStates.set(t.machineId, m);
      candidates.push({
        machine: m,
        profile: {
          id: t.profileId || `${t.machineId}:${t.model}`,
          name: t.model,
          backend: t.profileId ? 'llamacpp' : 'external',
          residency: t.residency,
          endpoint: t.provider.baseUrl,
          port: null,
        },
        modelSizeBytes: this.cfg.modelSizes?.[t.profileId || `${t.machineId}:${t.model}`] ?? null,
        alreadyLoaded: loadedModels.some((n) => t.model.includes(n) || n.includes(t.model)),
      });
    }
    return { machines, candidates };
  }

  /**
   * Assign a stage to the best machine/model for the role (manual override
   * via explicit per-stage targets always wins — see cfg.stageTargets).
   */
  async assignStage(stage: StageId, explicit?: AgentTarget): Promise<{ target: AgentTarget; reasons: string[] }> {
    if (explicit) return { target: explicit, reasons: ['manually assigned by the user'] };
    const automatic = this.cfg.machines.filter((m) => m.allowAutomatic !== false);
    // Enabled workers win. If this run selected only manual or controller
    // machines, those selections are eligible. A manual machine is not added
    // while an enabled worker exists.
    const pool = automatic.length ? automatic : this.cfg.machines;
    if (!pool.length) throw new Error(`No automatic worker is allowed to take the ${stage} stage.`);
    const { candidates } = await this.gatherCandidates();
    const ids = new Set(pool.map((m) => m.machineId));
    const ranked = rankCandidates(candidates.filter((c) => ids.has(c.machine.id)), ROLE_OF_STAGE[stage], { largestModelBytes: null });
    const best = ranked.find((r) => !r.hardBlocked) ?? ranked[0];
    const t = pool.find((m) => best && m.machineId === best.candidate.machine.id && m.model === best.candidate.profile.name) ?? pool[0];
    return { target: t, reasons: best?.reasons ?? ['only automatic workers are eligible'] };
  }

  private agentIdFor(stage: StageId, attempt: number): string {
    return `${stage}-${attempt}`;
  }

  private async persistAssignment(a: AgentAssignment) {
    try { await this.cfg.mesh.saveAssignment(this.cfg.workspaceId, a); } catch { /* host unreachable: keep in-memory */ }
  }

  private acceptanceCommands(): string[] {
    if (this.cfg.acceptanceCommands?.length) return this.cfg.acceptanceCommands;
    return extractAcceptanceCommands(this.cfg.task);
  }

  private acceptanceBlock(): string {
    const commands = this.acceptanceCommands();
    if (!commands.length) return '';
    return [
      'MANDATORY ACCEPTANCE COMMANDS (run from the workspace root, exactly as written):',
      ...commands.map((command) => `- ${command}`),
      'A different command, including one that changes directory first, does not satisfy these commands.',
    ].join('\n');
  }

  private stageTask(stage: StageId, plan: string, prior: { coder?: string; test?: string; review?: string; issue?: string; reviewFiles?: string[] }): string {
    const task = this.cfg.task;
    const acceptance = this.acceptanceBlock();
    switch (stage) {
      case 'planner': return [`Plan this task:\n\n${task}`, acceptance, 'Use only your planner tools. The workspace summary in your instructions is already available.'].filter(Boolean).join('\n\n');
      case 'coder': return [`Implement this plan in the shared workspace (your tools operate on the authoritative project — other agents may be editing other files; do not revert their work).\n\nTASK:\n${task}\n\nPLAN:\n${plan}`, acceptance].filter(Boolean).join('\n\n');
      case 'tester': return [`Verify the implementation of this task by executing the tests yourself. The coder summary is a claim, not evidence.\n${task}\n\nPlan that was implemented:\n${plan}\n\nCoder summary:\n${prior.coder ?? ''}`, acceptance].filter(Boolean).join('\n\n');
      case 'reviewer': {
        const files = prior.reviewFiles?.length
          ? `Before VERDICT: APPROVE, call read_file on each of these files: ${prior.reviewFiles.join(', ')}. list_dir alone is not inspection.`
          : 'Before VERDICT: APPROVE, call read_file on the implementation and its test. list_dir alone is not inspection.';
        return `Review this implementation:\n\nTASK:\n${task}\n\nCoder summary:\n${prior.coder ?? ''}\n\nTester report:\n${prior.test ?? ''}\n\n${files}\n\nYour finish summary must end with VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, or VERDICT: BLOCKED.`;
      }
      case 'debugger': return [`Diagnose and FIX the reported failure, then re-run the same acceptance command:\n\n${prior.issue}\n\nOriginal task:\n${task}`, acceptance].filter(Boolean).join('\n\n');
    }
  }

  /** Run one agent (one stage) on its assigned machine against the shared workspace. */
  async runAgent(stage: StageId, target: AgentTarget, task: string, contextMessages: AgentMessage[]): Promise<{ r: RunResult; assignment: AgentAssignment; conflict: string | null }> {
    const agentId = this.agentIdFor(stage, this.agentSeq++);
    const assignment: AgentAssignment = {
      id: genAssignmentId(),
      agentId,
      role: stage,
      machine: target.machineName,
      machineId: target.machineId,
      model: target.model,
      task,
      status: 'in-progress',
      startedAt: Date.now(),
    };
    await this.persistAssignment(assignment);
    this.cfg.onEvent({ type: 'stage', stage, agentId, assignmentId: assignment.id });

    // on-demand model load (spec §4 "Automatic model loading") when the
    // profile is managed and not currently ready
    let provider = target.provider;
    let model = target.model;
    if (this.cfg.ensureModelLoaded && target.profileId) {
      const loaded = await this.cfg.ensureModelLoaded(target);
      if (loaded) {
        provider = loaded.provider;
        model = loaded.model;
      }
    }

    // workspace revision BEFORE (conflict detection, spec §6)
    let revBefore: string | null = null;
    try { revBefore = (await this.cfg.mesh.workspaceRevision(this.cfg.workspaceId)).revision; } catch { /* ignore */ }
    if (this.stopRequested) {
      assignment.status = 'cancelled';
      await this.persistAssignment(assignment);
      return { r: { content: '', turns: 0, messages: [], hitTurnLimit: false, paused: true, note: 'Stopped by user before start.', filesChanged: [] } as RunResult, assignment, conflict: null };
    }
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      // MODEL on the agent's machine; TOOLS on the authoritative workspace host
      companion: this.cfg.clientForMachine(target.machineId),
      toolCompanion: this.cfg.workspaceHost,
      workspaceId: this.cfg.workspaceId,
      provider,
      model,
      params: {
        ...paramsWithThinking(this.cfg.params, target.thinking),
        ...(typeof target.liveContextTokens === 'number' ? { liveNumCtx: target.liveContextTokens } : {}),
      },
      liveContextTokens: target.liveContextTokens,
      systemPrompt: stagePrompt(stage, this.cfg.workspaceContext),
      workspaceMeta: {
        id: this.cfg.workspaceId,
        rootPath: this.cfg.workspacePath,
        machineLabel: this.cfg.workspaceContext.machineLabel || 'workspace host',
        platform: this.cfg.workspaceContext.platform,
        projectName: this.cfg.workspaceContext.projectName,
        knownTree: this.cfg.workspaceContext.tree,
      },
      task,
      contextMessages,
      tools: toolsByNames(STAGE_TOOLS[stage]),
      // the agent's OWN protocol/limit if configured; cfg values are fallbacks
      toolProtocol: target.toolProtocol ?? this.cfg.toolProtocol,
      maxTurns: target.maxTurns ?? this.cfg.maxTurnsPerStage ?? 25,
      allowNudgeOnText: true,
      initialSteering: this.pendingSteeringByStage.get(stage) ?? [],
      onEvent: (e) => {
        events.push(e);
        this.cfg.onEvent({ ...e, stage, agentId, assignmentId: assignment.id });
        // private scratchpad: real progress state (bounded, targeted retrieval)
        if (e.type === 'tool_end') {
          this.cfg.mesh.writeScratchpad(this.cfg.workspaceId, agentId, {
            progress: 'working',
            toolResults: [`${e.entry.tool}: ${(e.entry.output || '').slice(0, 200)}`],
          }).catch(() => {});
        }
        if (e.type === 'auto_steering') {
          this.cfg.mesh.writeScratchpad(this.cfg.workspaceId, agentId, {
            errors: [`auto-steer(${e.trigger}): ${e.text.slice(0, 200)}`],
          }).catch(() => {});
        }
      },
      approver: this.cfg.approver,
      allowedPatterns: this.cfg.allowedPatterns,
      signal: this.cfg.signal,
      onEscalation: (esc) => {
        this.escalations.push({ stage, agentId, assignment, esc });
      },
    });
    this.pendingSteeringByStage.delete(stage); // consumed by initialSteering
    this.active.set(agentId, runner);

    const r = await runner.run();
    this.active.delete(agentId);

    // revision AFTER → detect concurrent modifications
    let conflict: string | null = null;
    try {
      const revAfter = (await this.cfg.mesh.workspaceRevision(this.cfg.workspaceId)).revision;
      if (revBefore && revAfter && revBefore !== revAfter) {
        // The workspace changed during this agent's run. That is EXPECTED when
        // this agent edited files; a conflict is when OTHER agents also wrote.
        // Overlap is detected via the shared notebook handoffs recorded by the
        // coordinator between stages (single-writer per stage by default; a
        // conflict marker is set when the user ran parallel coders).
        if (this.parallelWriters) {
          conflict = `Workspace revision changed during ${agentId}'s run while parallel writers were active (${revBefore.slice(0, 8)} → ${revAfter.slice(0, 8)}). Both change sets are preserved; the coordinator will re-run tests and review before merging conclusions.`;
          assignment.status = 'conflict';
        }
      }
    } catch { /* ignore */ }

    assignment.turns = r.turns;
    assignment.endedAt = Date.now();
    assignment.resultSummary = (r.content || r.note || '').slice(0, 500);
    if (!conflict) assignment.status = r.paused ? 'pending' : 'done';
    await this.persistAssignment(assignment);

    // shared notebook: verified handoff (never overwritten, append-only)
    await this.cfg.mesh.notebookAppend(this.cfg.workspaceId, {
      agentId,
      kind: 'handoff',
      content: `[${stage} on ${target.machineName}/${model}] ${assignment.resultSummary.slice(0, 400)}`,
      refs: assignment.id,
    }).catch(() => {});

    // private scratchpad final state
    await this.cfg.mesh.writeScratchpad(this.cfg.workspaceId, agentId, {
      progress: r.paused ? 'paused' : 'done',
      plan: [`objective: ${task.slice(0, 200)}`],
      pending: r.paused ? ['paused by user — resumable'] : [],
    }).catch(() => {});

    if (stage === 'tester') {
      let revision: string | null = null;
      try { revision = (await this.cfg.mesh.workspaceRevision(this.cfg.workspaceId)).revision; } catch { /* evidence stays unscoped when revision is unavailable */ }
      for (const test of r.testsRun || []) {
        this.testEvidence.push({
          command: test.command,
          exitCode: test.exitCode,
          output: test.output || test.summary || '',
          files: r.filesChanged,
          at: test.at,
          machine: test.machine || target.machineName,
          runId: this.runId,
          revision: test.revision || revision,
          tool: test.tool,
        });
      }
    }

    return { r, assignment, conflict };
  }

  private agentSeq = 0;
  private escalations: { stage: StageId; agentId: string; assignment: AgentAssignment; esc: { kind: string; message: string; tool?: string } }[] = [];
  private parallelWriters = false;
  // live control (Phase 2.1 Priority 3): the UI drives these
  private active = new Map<string, AgentRunner>();
  private pendingSteeringByStage = new Map<string, string[]>();
  private stopRequested = false;
  private runId = '';
  private testEvidence: TestEvidence[] = [];
  private planning: PlanningStatus = 'MISSING';
  private reviewEvidenceMissing = false;
  lastRunResults: CoordinatorReport['results'] = [];

  /** Allow parallel coder agents (spec §6). Overlapping writes are detected via revisions. */
  enableParallelWriters() { this.parallelWriters = true; }

  // ---- live control API (used by the graphical IDE) ----

  /** Steer ONE running agent (or queue if it has not started yet). */
  steerAgent(agentId: string, text: string): boolean {
    if (!text.trim()) return false;
    const runner = this.active.get(agentId);
    if (runner) { runner.steer(text); return true; }
    // queue for the next run of that stage (agent ids start with the stage name)
    const stage = agentId.split('-')[0];
    const q = this.pendingSteeringByStage.get(stage) ?? [];
    q.push(text);
    this.pendingSteeringByStage.set(stage, q);
    return false;
  }

  /** Coordinator-level steering: delivered to EVERY active agent and queued for future stages. */
  steerAll(text: string): void {
    if (!text.trim()) return;
    for (const r of this.active.values()) r.steer(text);
    for (const stage of ['planner', 'coder', 'tester', 'reviewer', 'debugger']) {
      const q = this.pendingSteeringByStage.get(stage) ?? [];
      q.push(text);
      this.pendingSteeringByStage.set(stage, q);
    }
  }

  /** Pause every active agent at its next safe boundary. */
  requestPause(): void {
    for (const r of this.active.values()) r.requestPause();
  }

  /** Stop the whole collaborative task (agents pause at safe boundaries and
   * no further stages start). In-flight model calls use the run's AbortSignal
   * supplied by the caller. */
  requestStop(): void {
    this.stopRequested = true;
    for (const r of this.active.values()) r.requestPause();
  }

  /**
   * Continue a stage whose agent reached its turn limit: re-runs THAT stage
   * on the SAME machine/model with its own protocol and a fresh allowance,
   * seeded with the prior summary so completed work is not redone.
   */
  async continueStage(stage: StageId, currentResults?: CoordinatorReport['results']): Promise<{ summary: string; turns: number; assignment: AgentAssignment } | null> {
    const pool = currentResults && currentResults.length ? currentResults : this.lastRunResults;
    const prior = pool.find((r) => r.stage === stage);
    if (!prior) return null;
    const target = this.cfg.machines.find((m) => m.machineName === prior.machine && m.model === prior.model)
      ?? this.cfg.machines[0];
    const task = [
      `CONTINUATION of the ${stage} stage — the previous agent reached its turn limit.`,
      ``,
      `ORIGINAL OBJECTIVE:`,
      this.cfg.task,
      ``,
      prior.summary ? `PRIOR PROGRESS (present in the shared workspace — verify before changing):` : '',
      prior.summary ? prior.summary.slice(0, 1200) : '',
      ``,
      `Continue from the current workspace state. Do not redo verified work.`,
    ].filter(Boolean).join('\n');
    // Continuation preserves the ORIGINAL stage target (same machine, model,
    // tool protocol) — the debugger-role remap is only for repair reassignment.
    const { r, assignment } = await this.runAgent(stage, target, task, []);
    return { summary: r.content || r.note || '(no summary returned)', turns: r.turns, assignment };
  }

  pendingSteeringFor(stage: string): string[] {
    return this.pendingSteeringByStage.get(stage) ?? [];
  }

  /**
   * Reassign a failed/escalated agent's task to a DIFFERENT machine: runs a
   * debugger agent there with the original task, the failure explanation and
   * the failed run's summary — preserving files already modified and tool
   * results (they live in the authoritative workspace).
   */
  async reassign(stage: StageId, target: AgentTarget, failureExplanation: string): Promise<{ summary: string; turns: number; assignment: AgentAssignment }> {
    const prior = this.lastRunResults.find((r) => r.stage === stage);
    const task = [
      `A previous ${stage} agent could not complete this assignment and it has been REASSIGNED to you.`,
      ``,
      `ORIGINAL OBJECTIVE:`,
      this.cfg.task,
      ``,
      prior ? `PRIOR PROGRESS (already present in the shared workspace — do not redo it):` : '',
      prior ? prior.summary.slice(0, 1200) : '',
      ``,
      `FAILURE EXPLANATION:`,
      failureExplanation,
      ``,
      `Continue from the current workspace state. Verify what exists before changing it.`,
    ].filter(Boolean).join('\n');
    // Reassignment remaps a failed coder to the DEBUGGER role (repair
    // semantics) with the replacement's own target/protocol/turns.
    const { r, assignment } = await this.runAgent(stage === 'coder' ? 'debugger' : stage, target, task, []);
    return { summary: r.content || r.note || '(no summary returned)', turns: r.turns, assignment };
  }

  async run(explicitTargets?: Partial<Record<StageId, AgentTarget>>): Promise<CoordinatorReport> {
    this.runId = `collab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.testEvidence = [];
    this.planning = 'MISSING';
    this.reviewEvidenceMissing = false;
    const reworkLimit = this.cfg.reworkPasses ?? 1;
    let reworkUsed = 0;
    let totalTurns = 0;
    const results: CoordinatorReport['results'] = [];
    const conflicts: string[] = [];

    // 1. PLANNER
    const planAssign = await this.assignStage('planner', explicitTargets?.planner);
    const planRun = await this.runAgent('planner', planAssign.target, this.stageTask('planner', '', {}), []);
    totalTurns += planRun.r.turns;
    results.push({ stage: 'planner', assignmentId: planRun.assignment.id, agentId: planRun.assignment.agentId, machine: planAssign.target.machineName, model: planAssign.target.model, summary: planRun.r.content || planRun.r.note || '(no summary returned)', turns: planRun.r.turns, conflict: planRun.conflict, escalated: false, hitTurnLimit: planRun.r.hitTurnLimit });
    if (planRun.conflict) conflicts.push(planRun.conflict);
    if (planRun.r.paused) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');
    let deliverable = planningDeliverable(planRun.r.content || '', planRun.r.messages || []);
    if (deliverable.status === 'MISSING') {
      this.cfg.onEvent({ type: 'notice', message: 'Planner omitted the PLAN: section. Asking once. A rejected tool call did not create a file, and this is not a completed plan.' });
      const planRetry = await this.runAgent('planner', planAssign.target, plannerRetryTask(this.cfg.task), []);
      totalTurns += planRetry.r.turns;
      results.push({ stage: 'planner', assignmentId: planRetry.assignment.id, agentId: planRetry.assignment.agentId, machine: planAssign.target.machineName, model: planAssign.target.model, summary: planRetry.r.content || planRetry.r.note || '(no summary returned)', turns: planRetry.r.turns, conflict: planRetry.conflict, escalated: false, hitTurnLimit: planRetry.r.hitTurnLimit });
      if (planRetry.conflict) conflicts.push(planRetry.conflict);
      if (planRetry.r.paused && !planRetry.r.hitTurnLimit) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');
      deliverable = planningDeliverable(planRetry.r.content || '', [...(planRun.r.messages || []), ...(planRetry.r.messages || [])]);
    }
    this.planning = deliverable.status;
    const plan = deliverable.plan;

    // 2. CODER (+ optional rework/debugger loops)
    let coderSummary = '';
    let coderFiles: string[] = [];
    let testReport = '';
    let review = '';
    let verdict: CoordinatorReport['verdict'] = 'UNKNOWN';

    for (let pass = 0; pass <= reworkLimit; pass++) {
      const coderAssign = await this.assignStage('coder', explicitTargets?.coder);
      const coderRun = await this.runAgent('coder', coderAssign.target, this.stageTask('coder', plan, { issue: pass > 0 ? review : undefined }), []);
      totalTurns += coderRun.r.turns;
      coderSummary = coderRun.r.content || coderRun.r.note || '(no summary returned)';
      coderFiles = [...coderFiles, ...(coderRun.r.filesChanged || [])];
      results.push({ stage: 'coder', assignmentId: coderRun.assignment.id, agentId: coderRun.assignment.agentId, machine: coderAssign.target.machineName, model: coderAssign.target.model, summary: coderSummary, turns: coderRun.r.turns, conflict: coderRun.conflict, escalated: false, hitTurnLimit: coderRun.r.hitTurnLimit });
      if (coderRun.conflict) conflicts.push(coderRun.conflict);
      // Turn limit ≠ user pause: the pipeline still proceeds to verification
      // with the partial progress recorded honestly (the user can resume the
      // stage explicitly via continueStage — the recorded summary explains
      // exactly where it stopped). A user pause (no hitTurnLimit) stops the run.
      if (coderRun.r.paused && !coderRun.r.hitTurnLimit) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');

      const stageOn = (stage: StageId) => !this.cfg.stages || this.cfg.stages.includes(stage);
      if (!stageOn('tester') && !stageOn('reviewer')) break;

      // 3. TESTER (may run on a different machine — e.g. the GPU worker)
      if (!stageOn('tester')) {
        // A run that names its stages does not invent tester work.
      } else {
      const testerAssign = await this.assignStage('tester', explicitTargets?.tester);
      const runTester = async (extra: string) => {
        const testerRun = await this.runAgent('tester', testerAssign.target, `${this.stageTask('tester', plan, { coder: coderSummary })}${extra}`, []);
        totalTurns += testerRun.r.turns;
        testReport = testerRun.r.content || testerRun.r.note || '(no summary returned)';
        results.push({ stage: 'tester', assignmentId: testerRun.assignment.id, agentId: testerRun.assignment.agentId, machine: testerAssign.target.machineName, model: testerAssign.target.model, summary: testReport, turns: testerRun.r.turns, conflict: testerRun.conflict, escalated: false, hitTurnLimit: testerRun.r.hitTurnLimit });
        if (testerRun.conflict) conflicts.push(testerRun.conflict);
        return testerRun;
      };
      const firstTester = await runTester('');
      if (firstTester.r.paused && !firstTester.r.hitTurnLimit) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');
      const required = this.acceptanceCommands();
      const evidenceNow = () => this.testEvidence.filter((item) => item.runId === this.runId);
      let check = checkAcceptanceCommands(evidenceNow(), required);
      if (check.missing.length > 0) {
        this.cfg.onEvent({ type: 'notice', message: `Tester did not execute the required acceptance command (${check.missing.join('; ')}). Running the tester once more.` });
        const testerRetry = await runTester('\n\nThe previous tester pass did not execute the mandatory command. Run that exact command now with run_command. Do not report PASS from the coder summary.');
        if (testerRetry.r.paused && !testerRetry.r.hitTurnLimit) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');
        check = checkAcceptanceCommands(evidenceNow(), required);
      }

      // 4. REVIEWER. A missing verdict gets one formatting retry and is never
      // treated as a request for changes.
      const reviewerAssign = await this.assignStage('reviewer', explicitTargets?.reviewer);
      const runReviewer = async (taskText: string) => {
        const reviewerRun = await this.runAgent('reviewer', reviewerAssign.target, taskText, []);
        totalTurns += reviewerRun.r.turns;
        review = reviewerRun.r.content || reviewerRun.r.note || '(no summary returned)';
        results.push({ stage: 'reviewer', assignmentId: reviewerRun.assignment.id, agentId: reviewerRun.assignment.agentId, machine: reviewerAssign.target.machineName, model: reviewerAssign.target.model, summary: review, turns: reviewerRun.r.turns, conflict: reviewerRun.conflict, escalated: false, hitTurnLimit: reviewerRun.r.hitTurnLimit });
        if (reviewerRun.conflict) conflicts.push(reviewerRun.conflict);
        return reviewerRun;
      };
      const reviewPaths = requiredReviewPaths({ changedFiles: coderFiles, task: this.cfg.task, plan });
      const reviewerMessages: AgentMessage[] = [];
      const firstReview = await runReviewer(this.stageTask('reviewer', plan, { coder: coderSummary, test: testReport, reviewFiles: reviewPaths }));
      reviewerMessages.push(...(firstReview.r.messages || []));
      if (firstReview.r.paused) return this.report(results, 'UNKNOWN', reworkUsed, totalTurns, conflicts, 'paused');
      verdict = parseReviewerVerdict(review);
      let verdictRetries = 0;
      let evidenceRetries = 0;
      if (verdict === 'UNKNOWN') {
        verdictRetries = 1;
        const files = reviewPaths.length ? reviewPaths.join(', ') : 'the implementation and its test';
        this.cfg.onEvent({ type: 'notice', message: 'Reviewer omitted the verdict line. Asking once for a file read and VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, or VERDICT: BLOCKED. This is not a request for changes.' });
        const reviewerRetry = await runReviewer(`Your previous review omitted the required verdict line. Do not turn that omission into a request for changes. Call read_file on: ${files}. Then call finish. End the summary with exactly one line: VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, or VERDICT: BLOCKED.`);
        reviewerMessages.push(...(reviewerRetry.r.messages || []));
        if (reviewerRetry.r.paused) return this.report(results, verdict, reworkUsed, totalTurns, conflicts, 'paused');
        verdict = parseReviewerVerdict(review);
      }
      let evidence = assessReviewEvidence(reviewReads(reviewerMessages), reviewPaths);
      if (verdict === 'APPROVE' && !evidence.sufficient && evidenceRetries < 1 && verdictRetries === 0) {
        evidenceRetries = 1;
        this.cfg.onEvent({ type: 'notice', message: `Reviewer approved without reading ${evidence.missing.join(', ') || 'the implementation'}. Asking once for that inspection. This is not a request for changes.` });
        const reviewerRetry = await runReviewer(`Your approval did not include a successful read_file of the implementation, so it is not accepted. This is not a request for changes. Call read_file on: ${evidence.missing.join(', ') || 'the implementation and its test'}. Then call finish. End with exactly one line: VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, or VERDICT: BLOCKED.`);
        reviewerMessages.push(...(reviewerRetry.r.messages || []));
        if (reviewerRetry.r.paused) return this.report(results, verdict, reworkUsed, totalTurns, conflicts, 'paused');
        verdict = parseReviewerVerdict(review);
        evidence = assessReviewEvidence(reviewReads(reviewerMessages), reviewPaths);
      }
      this.reviewEvidenceMissing = verdict === 'APPROVE' && !evidence.sufficient;

      const follow = reviewFollowup({
        verdict,
        verdictRetriesUsed: verdictRetries > 0 ? 1 : 0,
        requiredMissing: check.missing.length > 0,
        requiredFailed: check.failed.length > 0,
        testerRetriesUsed: 1,
        reworkUsed,
        reworkLimit,
        testerProducedEvidence: evidenceNow().length > 0,
        evidenceMissing: this.reviewEvidenceMissing,
        evidenceRetriesUsed: evidenceRetries,
      });
      if (follow.action === 'stop') break;
      if (follow.action !== 'debugger') break;

      reworkUsed++;
      const notice = follow.reason === 'request-changes'
        ? `Reviewer requested changes — rework pass ${reworkUsed} (debugger may run on a different machine).`
        : `Acceptance command failed — rework pass ${reworkUsed}. The missing or absent reviewer format is not the reason for this debugger pass.`;
      this.cfg.onEvent({ type: 'notice', message: notice });
      const issue = [
        follow.reason === 'request-changes' ? review : '',
        check.failed.map((item) => `FAILED ACCEPTANCE COMMAND: ${item.command}\nexit ${item.exitCode ?? 'unknown'}\n${item.output}`).join('\n\n'),
        check.substitutes.length ? `These other commands passed and do not replace the mandatory command: ${check.substitutes.join('; ')}` : '',
        verdict === 'UNKNOWN' ? 'The reviewer verdict was missing. That formatting gap is not the defect to fix.' : '',
      ].filter(Boolean).join('\n\n');
      // escalation-aware: if the coder escalated, try a DIFFERENT machine for the debugger
      const escalated = this.escalations.some((e) => e.stage === 'coder');
      const debugTarget = escalated
        ? await this.alternativeMachine('debugger', coderAssign.target.machineId, explicitTargets?.debugger)
        : explicitTargets?.debugger;
      const dbgAssign = await this.assignStage('debugger', debugTarget ?? explicitTargets?.debugger);
      const dbgRun = await this.runAgent('debugger', dbgAssign.target, this.stageTask('debugger', plan, { issue }), []);
      totalTurns += dbgRun.r.turns;
      coderSummary += `\n\n[Rework pass ${reworkUsed} — debugger on ${dbgAssign.target.machineName}] ${dbgRun.r.content}`;
      coderFiles = [...coderFiles, ...(dbgRun.r.filesChanged || [])];
      results.push({ stage: 'debugger', assignmentId: dbgRun.assignment.id, agentId: dbgRun.assignment.agentId, machine: dbgAssign.target.machineName, model: dbgAssign.target.model, summary: dbgRun.r.content || dbgRun.r.note || '(no summary returned)', turns: dbgRun.r.turns, conflict: dbgRun.conflict, escalated, hitTurnLimit: dbgRun.r.hitTurnLimit });
      if (dbgRun.conflict) conflicts.push(dbgRun.conflict);
      if (dbgRun.r.paused) return this.report(results, verdict, reworkUsed, totalTurns, conflicts, 'paused');
      this.escalations = this.escalations.filter((e) => e.stage !== 'coder');
      }
    }

    return this.report(results, verdict, reworkUsed, totalTurns, conflicts);
  }

  // pick a DIFFERENT machine than the one that escalated (spec §7 step 6)
  private async alternativeMachine(stage: StageId, failedMachineId: string, explicit?: AgentTarget): Promise<AgentTarget | undefined> {
    if (explicit && explicit.allowAutomatic !== false) return explicit;
    if (explicit?.allowAutomatic === false) return undefined;
    const automaticIds = new Set(this.cfg.machines.filter((m) => m.allowAutomatic !== false && m.machineId !== failedMachineId).map((m) => m.machineId));
    const { candidates } = await this.gatherCandidates();
    const ranked = rankCandidates(candidates.filter((c) => automaticIds.has(c.machine.id)), ROLE_OF_STAGE[stage], { largestModelBytes: null });
    const best = ranked.find((r) => !r.hardBlocked);
    if (!best) return undefined;
    return this.cfg.machines.find((m) => m.machineId === best.candidate.machine.id);
  }

  private report(results: CoordinatorReport['results'], verdict: CoordinatorReport['verdict'], rework: number, turns: number, conflicts: string[], state?: string): CoordinatorReport {
    this.lastRunResults = results;
    const revision = [...this.testEvidence].reverse().find((item) => item.runId === this.runId)?.revision ?? null;
    const objectiveAcceptance = evaluateObjectiveAcceptance({
      applicable: collaborationRequiresExecution(this.cfg.stages),
      reviewerVerdict: verdict,
      evidence: this.testEvidence,
      runId: this.runId,
      revision,
      requiredCommands: this.acceptanceCommands(),
    });
    const completion: CollaborationCompletion = state === 'paused'
      ? 'PAUSED'
      : objectiveAcceptance.status === 'FAIL'
        ? 'TESTS_FAILED'
        : objectiveAcceptance.status === 'NOT TESTED'
          ? 'NOT_TESTED'
          : verdict === 'UNKNOWN'
            ? 'VERDICT_MISSING'
            : verdict === 'APPROVE' && this.reviewEvidenceMissing
              ? 'REVIEW_EVIDENCE_MISSING'
              : verdict === 'REQUEST_CHANGES'
                ? 'CHANGES_REQUESTED'
                : verdict === 'BLOCKED'
                  ? 'BLOCKED'
                  : verdict === 'APPROVE' && objectiveAcceptance.status === 'PASS' && !this.reviewEvidenceMissing
                    ? 'ACCEPTED'
                    : 'INCOMPLETE';
    const verdictNotice = `Planning: ${this.planning}. Reviewer verdict: ${verdict}. Completion: ${completion}. Objective acceptance: ${objectiveAcceptance.status}. ${objectiveAcceptance.reason}${this.reviewEvidenceMissing ? ' Review inspection evidence is missing, so this approval is not accepted.' : ''}`;
    if (state === 'paused') {
      this.cfg.onEvent({ type: 'paused', turn: turns, note: 'Coordinator paused — all agent assignments and scratchpads are persisted on the workspace host.' });
    } else {
      this.cfg.onEvent({ type: 'notice', message: `Coordinator complete — ${verdictNotice}${conflicts.length ? `, ${conflicts.length} conflict(s) detected` : ''}.` });
    }
    this.cfg.mesh.notebookAppend(this.cfg.workspaceId, {
      agentId: 'coordinator',
      kind: 'handoff',
      content: `[objective ${objectiveAcceptance.status} run ${this.runId}] ${objectiveAcceptance.reason} Evidence: ${objectiveAcceptance.evidence.map((item) => `${item.command} exit ${item.exitCode} @ ${new Date(item.at).toISOString()} on ${item.machine}`).join('; ') || 'none'}`,
      refs: this.runId,
    }).catch(() => {});
    return {
      plan: results.find((r) => r.stage === 'planner')?.summary ?? '',
      results,
      verdict,
      completion,
      planning: this.planning,
      reworkPassesUsed: rework,
      totalTurns: turns,
      conflicts,
      objectiveAcceptance,
    };
  }
}

// Re-export for UI convenience.
export type { ModelProfile };
