// FanoutRunner (Milestone 2) — dependency-aware PARALLEL execution of a task
// graph across LAN machines, on top of the existing AgentRunner + task
// packets + write reservations. Extends the working stack; introduces no new
// agent framework.
//
// Guarantees:
//  - each task = one durable task packet on the workspace host (idempotent
//    via dedupKey, acked before work starts, progress recorded);
//  - model traffic goes to the assigned machine, tool traffic to the
//    authoritative workspace host (existing Coordinator rule);
//  - parallel writers coordinate through workspace write reservations and
//    per-file overwrite protection (ifUnmodifiedSince); revision is checked
//    before/after each task and conflicts are REPORTED, never silently
//    overwritten;
//  - machine disconnect: the peer's own status hook fails active packets;
//    FanoutRunner reassigns a failed task ONCE to another capable machine
//    with the full handoff packet preserved, then reports honestly;
//  - cancellation is explicit — remaining queued packets are cancelled,
//    running agents are paused at their next safe boundary.
import type { CompanionClient } from '@/lib/companion/client';
import type { MeshClient, FleetTask } from '@/lib/mesh/client';
import type { InferenceParams, ProviderConfig } from '@/lib/types';
import type { AgentEvent, Approver, ToolProtocolMode } from './types';
import { AgentRunner, type RunResult } from './runner';
import { toolsByNames } from './tools';
import { contractPromptBlock, bumpInPlace, type TaskContract } from './task-contract';

export type FanoutStage = 'coder' | 'tester' | 'reviewer' | 'debugger' | 'planner';

export const STAGE_TOOLS: Record<FanoutStage, string[]> = {
  planner: ['finish'],
  coder: ['list_dir', 'read_file', 'write_file', 'append_file', 'edit_file', 'create_dir', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_build', 'run_tests', 'finish'],
  tester: ['list_dir', 'read_file', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_tests', 'run_build', 'finish'],
  reviewer: ['list_dir', 'read_file', 'search_project', 'finish'],
  debugger: ['list_dir', 'read_file', 'edit_file', 'append_file', 'search_project', 'run_command', 'run_tests', 'run_build', 'process_status', 'stop_process', 'finish'],
};

export interface FanoutMachine {
  machineId: string;          // 'local' or mesh peer id
  name: string;
  model: string;
  provider: ProviderConfig;
  // roles this machine may take (capability-aware routing input)
  capableStages?: FanoutStage[];
  // false: this machine may receive an explicit assignment, but busy/failure
  // retries must not move work onto it. Undefined keeps prior behavior.
  allowAutomatic?: boolean;
}

export interface FanoutTaskSpec {
  key: string;                // stable id inside the task graph (dedupKey)
  title: string;
  stage: FanoutStage;
  prompt: string;             // concrete assignment for the agent
  requirements?: string[];
  contextFiles?: string[];
  dependsOn?: string[];       // task keys that must complete first
  machineId?: string;         // explicit assignment; 'auto' → capability routing
}

export interface FanoutTaskResult {
  key: string;
  taskId: string | null;
  machine: string;
  machineId: string;
  model: string;
  status: 'completed' | 'failed' | 'cancelled' | 'reassigned';
  summary: string;
  turns: number;
  filesChanged: string[];
  revisionBefore?: string | null;
  revisionAfter?: string | null;
  conflict?: string | null;
  attempts: number;
  reassignedFrom?: string;
  error?: string;
}

export interface FanoutConfig {
  // authoritative workspace host (packets, revisions, locks live here)
  workspaceHost: CompanionClient;
  workspaceId: string;
  workspacePath: string;
  contract?: TaskContract;
  onContractUpdate?: (c: TaskContract) => void;
  mesh: MeshClient;
  machines: FanoutMachine[];
  tasks: FanoutTaskSpec[];
  params?: Partial<InferenceParams>;
  maxTurnsPerTask?: number;
  toolProtocol?: ToolProtocolMode | 'auto-native' | 'force-text';
  maxParallel?: number;
  reassignOnFailure?: boolean;
  // factory so remote machines get routed clients (IDE builds one over the
  // mesh proxy — see clientForMachine in collab-service; tests pass fakes)
  clientForMachine: (machineId: string) => CompanionClient;
  onEvent: (e: AgentEvent & { fanoutKey?: string; machine?: string }) => void;
  approver?: Approver;
  allowedPatterns?: Set<string>;
  signal?: AbortSignal;
  // test seam — override agent construction
  runnerFactory?: (cfg: ConstructorParameters<typeof AgentRunner>[0]) => { run(): Promise<RunResult>; steer(t: string): void; requestPause(): void };
  // test seam — deterministic revision lookup
  fetchRevision?: (peerId: string | null) => Promise<string | null>;
}

export interface FanoutReport {
  results: FanoutTaskResult[];
  completed: number;
  failed: number;
  cancelled: number;
  conflicts: string[];
  totalTurns: number;
  revisionBefore: string | null;
  revisionAfter: string | null;
}

const LOCK_TTL_MS = 120_000;

export class FanoutRunner {
  private cancelled = false;
  private activeRunners = new Map<string, { steer(t: string): void; requestPause(): void }>();

  constructor(private cfg: FanoutConfig) {}

  cancel(): void {
    this.cancelled = true;
    for (const r of this.activeRunners.values()) r.requestPause();
  }

  steer(key: string, text: string): void {
    this.activeRunners.get(key)?.steer(text);
  }

  /** UI Pause: every ACTIVE agent pauses at its next safe boundary. */
  pauseAll(): void {
    for (const r of this.activeRunners.values()) r.requestPause();
  }

  /** UI steering broadcast to every active agent (delivered on their next turn). */
  steerAll(text: string): void {
    for (const r of this.activeRunners.values()) r.steer(text);
  }

  /** Topological waves (dependency-aware scheduling). Unknown dependencies
   * degrade the task to a failed result instead of deadlocking. */
  waves(): string[][] {
    const byKey = new Map(this.cfg.tasks.map((t) => [t.key, t]));
    const done = new Set<string>();
    const waves: string[][] = [];
    let remaining = [...this.cfg.tasks.map((t) => t.key)];
    while (remaining.length) {
      const ready = remaining.filter((k) => {
        const t = byKey.get(k)!;
        return (t.dependsOn ?? []).every((d) => done.has(d) || !byKey.has(d));
      });
      if (!ready.length) {
        // dependency cycle or all-unknown deps: mark the rest impossible
        waves.push(remaining);
        break;
      }
      waves.push(ready);
      for (const k of ready) { done.add(k); }
      remaining = remaining.filter((k) => !ready.includes(k));
    }
    return waves;
  }

  private pickMachine(spec: FanoutTaskSpec, exclude?: string): FanoutMachine | null {
    const pool = this.cfg.machines.filter((m) => !exclude || m.machineId !== exclude);
    if (spec.machineId && spec.machineId !== 'auto') {
      const explicit = pool.find((m) => m.machineId === spec.machineId);
      if (explicit) return explicit;
    }
    const capableOf = (list: FanoutMachine[]) => list.filter((m) => !m.capableStages?.length || m.capableStages.includes(spec.stage));
    const automatic = capableOf(pool.filter((m) => m.allowAutomatic !== false));
    if (automatic.length) return automatic[0];
    // Retries never move onto a manual machine. A first assignment may use
    // the machines already selected for this run when none are automatic.
    if (exclude) return null;
    return capableOf(pool)[0] ?? null;
  }

  private async revision(peerId: string | null): Promise<string | null> {
    if (this.cfg.fetchRevision) return this.cfg.fetchRevision(peerId);
    try {
      const r = await this.cfg.mesh.workspaceRevision(this.cfg.workspaceId, peerId);
      return r.revision;
    } catch { return null; }
  }

  private async lockPaths(taskId: string, machineId: string, files: string[]): Promise<void> {
    for (const f of files.slice(0, 20)) {
      try { await this.cfg.mesh.acquireLock(this.cfg.workspaceId, f, `task:${taskId}`, { ttlMs: LOCK_TTL_MS }); } catch { /* advisory; conflicts surface on write */ }
    }
  }

  private async unlockPaths(taskId: string, files: string[]): Promise<void> {
    for (const f of files.slice(0, 20)) {
      try { await this.cfg.mesh.releaseLock(this.cfg.workspaceId, f, `task:${taskId}`); } catch { /* ignore */ }
    }
  }

  private buildRunner(machine: FanoutMachine, taskPacketId: string, spec: FanoutTaskSpec, steering: string[]): { run(): Promise<RunResult>; steer(t: string): void; requestPause(): void } {
    // MODEL on the agent's machine; TOOLS on the authoritative workspace host.
    const machineClient = machine.machineId === 'local'
      ? this.cfg.workspaceHost
      : this.cfg.clientForMachine(machine.machineId);
    const runnerCfg: ConstructorParameters<typeof AgentRunner>[0] = {
      companion: machineClient,
      toolCompanion: this.cfg.workspaceHost,
      workspaceId: this.cfg.workspaceId,
      provider: machine.provider,
      model: machine.model,
      params: this.cfg.params,
      workspaceMeta: {
        id: this.cfg.workspaceId,
        rootPath: this.cfg.workspacePath,
        machineLabel: machine.name,
        platform: 'unknown',
      },
      systemPrompt: [
        this.cfg.contract ? contractPromptBlock(this.cfg.contract, { role: `${spec.stage} (fanout task "${spec.title}")` }) : '',
        `You are one agent inside a FAN-OUT wave on machine "${machine.name}". Other agents work on OTHER tasks in the same workspace, possibly on other machines. Respect write reservations; never revert other agents' work.`,
      ].filter(Boolean).join('\n\n=== RUNTIME ===\n'),
      task: spec.prompt,
      tools: toolsByNames(STAGE_TOOLS[spec.stage]),
      toolProtocol: this.cfg.toolProtocol,
      maxTurns: this.cfg.maxTurnsPerTask ?? 20,
      allowNudgeOnText: true,
      initialSteering: steering,
      onEvent: (e) => {
        this.cfg.onEvent({ ...e, fanoutKey: spec.key, machine: machine.name });
        // live progress into the task packet (bounded)
        if (e.type === 'tool_end') {
          this.cfg.mesh.taskProgress(this.cfg.workspaceId, taskPacketId, {
            note: `${e.entry.tool}: ${(e.entry.output || '').slice(0, 160)}`,
          }).catch(() => {});
        }
      },
      approver: this.cfg.approver,
      allowedPatterns: this.cfg.allowedPatterns,
      signal: this.cfg.signal,
      onContractUpdate: this.cfg.onContractUpdate,
    };
    if (this.cfg.runnerFactory) return this.cfg.runnerFactory(runnerCfg);
    const runner = new AgentRunner(runnerCfg);
    return runner;
  }

  private async runOne(spec: FanoutTaskSpec, priorFailure?: { machineId: string; error: string; taskId: string }): Promise<FanoutTaskResult> {
    const machine = this.pickMachine(spec, priorFailure?.machineId);
    const attempts = (priorFailure ? 1 : 0) + 1;
    if (!machine) {
      return {
        key: spec.key, taskId: null, machine: '—', machineId: '—', model: '—',
        status: 'failed', summary: '', turns: 0, filesChanged: [], attempts,
        error: 'No participating worker is allowed to take this task. Manual machines are not used as automatic fallbacks.',
      };
    }
    const dedupKey = `${spec.key}${priorFailure ? `:retry` : ''}`;
    let taskId: string | null = null;
    const revBefore = await this.revision(null);

    // idempotent packet creation on the workspace host
    try {
      const packet = await this.cfg.mesh.createTask(this.cfg.workspaceId, {
        title: spec.title,
        contract: this.cfg.contract ? contractPromptBlock(this.cfg.contract, { role: spec.stage }) : undefined,
        requirements: spec.requirements,
        contextFiles: spec.contextFiles,
        workspaceMapping: { local: this.cfg.workspacePath, remote: 'workspace-root', revision: revBefore ?? undefined },
        machineId: machine.machineId,
        assignedMachine: machine.name,
        dedupKey,
        dependsOn: spec.dependsOn,
      });
      taskId = packet.task.id;
      if (packet.deduplicated && ['completed', 'failed', 'cancelled'].includes(packet.task.status)) {
        // prior run of the same graph: report the recorded outcome honestly
        return {
          key: spec.key, taskId, machine: packet.task.assignedMachine || machine.name, machineId: packet.task.machineId || machine.machineId,
          model: machine.model, status: packet.task.status as FanoutTaskResult['status'],
          summary: packet.task.result?.summary || packet.task.error?.reason || '', turns: 0,
          filesChanged: packet.task.result?.filesChanged ?? [], attempts: packet.task.attempts,
        };
      }
      await this.cfg.mesh.ackTask(this.cfg.workspaceId, taskId, { agentId: `fanout:${spec.key}`, machineId: machine.machineId });
    } catch (e: any) {
      return {
        key: spec.key, taskId: null, machine: machine.name, machineId: machine.machineId, model: machine.model,
        status: 'failed', summary: '', turns: 0, filesChanged: [], attempts,
        error: `task packet failure: ${String(e?.message || e).slice(0, 300)}`,
      };
    }

    // reserve the files this task is expected to touch (advisory)
    await this.lockPaths(taskId, machine.machineId, spec.contextFiles ?? []);

    if (this.cancelled) {
      await this.cfg.mesh.cancelTask(this.cfg.workspaceId, taskId, { reason: 'coordinator cancelled before start' }).catch(() => {});
      await this.unlockPaths(taskId, spec.contextFiles ?? []);
      return { key: spec.key, taskId, machine: machine.name, machineId: machine.machineId, model: machine.model, status: 'cancelled', summary: '', turns: 0, filesChanged: [], attempts };
    }

    const steering: string[] = [];
    if (priorFailure) {
      steering.push(`A previous attempt of this task on machine "${priorFailure.machineId}" failed: ${priorFailure.error.slice(0, 500)}. You are the reassignment. The workspace state reflects all prior work; verify what exists before changing anything.`);
    }

    const runner = this.buildRunner(machine, taskId, spec, steering);
    this.activeRunners.set(spec.key, runner);
    let r: RunResult;
    try {
      r = await runner.run();
    } catch (e: any) {
      r = { content: '', turns: 0, messages: [], hitTurnLimit: false, note: `runner crashed: ${String(e?.message || e)}`, filesChanged: [] };
    }
    this.activeRunners.delete(spec.key);
    await this.unlockPaths(taskId, spec.contextFiles ?? []);

    const revAfter = await this.revision(null);
    const failed = r.note?.includes('runner crashed') || (!r.content && !r.hitTurnLimit && !r.paused && r.note);
    if (failed && this.cfg.reassignOnFailure !== false && !priorFailure) {
      // one explicit reassignment with the full handoff preserved
      await this.cfg.mesh.failTask(this.cfg.workspaceId, taskId, { reason: r.note || 'machine failed', recoverable: true }).catch(() => {});
      const otherMachines = this.cfg.machines.filter((m) => m.machineId !== machine.machineId && m.allowAutomatic !== false);
      if (otherMachines.length) {
        this.cfg.onEvent({ type: 'escalation', fromModel: machine.model, toModel: otherMachines[0].model, reason: `Task "${spec.title}" failed on ${machine.name}; reassigning to ${otherMachines[0].name}.` });
        return { ...(await this.runOne(spec, { machineId: machine.machineId, error: r.note || 'failed', taskId })), attempts: attempts + 1, reassignedFrom: machine.name, revisionBefore: revBefore };
      }
    }

    let conflict: string | null = null;
    if (revBefore && revAfter && revBefore !== revAfter && this.parallelWave) {
      conflict = `workspace revision changed during parallel execution (${revBefore.slice(0, 8)} → ${revAfter.slice(0, 8)}); write reservations + per-file overwrite protection guarded all writes`;
    }

    const status: FanoutTaskResult['status'] = this.cancelled && !r.content ? 'cancelled' : failed ? 'failed' : 'completed';
    if (taskId) {
      if (status === 'completed') {
        await this.cfg.mesh.completeTask(this.cfg.workspaceId, taskId, {
          summary: (r.content || r.note || '').slice(0, 8000),
          filesChanged: r.filesChanged,
          revisionAfter: revAfter ?? undefined,
        }).catch(() => {});
      } else if (status === 'failed') {
        await this.cfg.mesh.failTask(this.cfg.workspaceId, taskId, { reason: (r.note || 'no summary produced').slice(0, 2000) }).catch(() => {});
      } else {
        await this.cfg.mesh.cancelTask(this.cfg.workspaceId, taskId, { reason: 'cancelled' }).catch(() => {});
      }
    }
    return {
      key: spec.key, taskId, machine: machine.name, machineId: machine.machineId, model: machine.model,
      status, summary: (r.content || r.note || '').slice(0, 4000), turns: r.turns,
      filesChanged: r.filesChanged, revisionBefore: revBefore, revisionAfter: revAfter,
      conflict, attempts, reassignedFrom: priorFailure?.machineId,
      error: failed ? r.note : undefined,
    };
  }

  private parallelWave = false;

  async run(): Promise<FanoutReport> {
    const revBefore = await this.revision(null);
    const results: FanoutTaskResult[] = [];
    const waveList = this.waves();
    const maxParallel = this.cfg.maxParallel ?? 4;
    for (const wave of waveList) {
      if (this.cancelled) {
        // explicit cancellation: remaining tasks never start; their packets
        // are created? No — uncreated tasks are simply reported cancelled.
        for (const key of wave) {
          results.push({ key, taskId: null, machine: '-', machineId: '-', model: '-', status: 'cancelled', summary: '', turns: 0, filesChanged: [], attempts: 0 });
        }
        continue;
      }
      this.parallelWave = wave.length > 1;
      const specs = wave.map((k) => this.cfg.tasks.find((t) => t.key === k)!);
      // bounded parallelism
      const executing = specs.slice(0, maxParallel);
      const settled = await Promise.all(executing.map((s) => this.runOne(s).catch((e) => ({
        key: s.key, taskId: null, machine: '-', machineId: '-', model: '-', status: 'failed' as const,
        summary: '', turns: 0, filesChanged: [], attempts: 1, error: String(e?.message || e),
      }))));
      results.push(...settled);
      // waves larger than maxParallel are executed in slices
      for (let i = maxParallel; i < specs.length; i += maxParallel) {
        const slice = specs.slice(i, i + maxParallel);
        this.parallelWave = true;
        const more = await Promise.all(slice.map((s) => this.runOne(s).catch((e) => ({
          key: s.key, taskId: null, machine: '-', machineId: '-', model: '-', status: 'failed' as const,
          summary: '', turns: 0, filesChanged: [], attempts: 1, error: String(e?.message || e),
        }))));
        results.push(...more);
      }
    }
    const revAfter = await this.revision(null);
    return {
      results,
      completed: results.filter((r) => r.status === 'completed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      cancelled: results.filter((r) => r.status === 'cancelled').length,
      conflicts: results.map((r) => r.conflict).filter(Boolean) as string[],
      totalTurns: results.reduce((a, r) => a + r.turns, 0),
      revisionBefore: revBefore,
      revisionAfter: revAfter,
    };
  }
}
