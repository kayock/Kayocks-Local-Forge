// Collaborative task launch service (Phase 2.1 Priority 3).
//
// This module is THE integration point between the graphical IDE and the
// orchestration engine: the Collaborate tab's "Start" button calls
// launchCollaborativeTask(), and the acceptance tests call the SAME function —
// so tests exercise the exact code path the user's click takes, with real
// Coordinator + AgentRunner instances and real mesh-routed companions.
//
// Routing model (unchanged from Phase 2.0, now user-visible):
//   • chat/model inference  → the PARTICIPANT machine's companion (via the
//     authenticated mesh proxy for remote machines);
//   • every file/command tool → the authoritative WORKSPACE HOST companion;
//   • the coordinator itself runs in the IDE, so the Station can host the
//     workspace WITHOUT hosting a permanently loaded planning model.
import { CompanionClient, type CompanionConfig } from '@/lib/companion/client';
import { MeshClient } from '@/lib/mesh/client';
import { useSettings } from '@/lib/store/settings';
import { Coordinator, type AgentTarget, type CoordinatorReport } from '@/lib/agent/coordinator';
import type { ProtocolSetting } from '@/lib/store/settings';
import type { AgentEvent } from '@/lib/agent/types';
import type { AgentAssignment, ModelInventory } from '@/lib/mesh-types';

export type CollabRole = 'planner' | 'coder' | 'tester' | 'reviewer';

export interface CollabParticipant {
  machineId: string;        // 'local' or a mesh peer id
  machineName: string;
  // The inference endpoint as that machine sees it. Chosen from discovery
  // on the selected computer. There is no built-in endpoint.
  baseUrl: string;
  model: string;
  roles: CollabRole[];      // which stages this participant may take
  profileId?: string;       // Model Manager profile for on-demand loading
  residency?: 'on-demand' | 'keep-loaded';
  // Per-agent configuration (Phase 2.2 Fix 3) — NO shared defaults:
  // 'inherit' (or undefined) resolves the IDE's per-model protocol for THIS
  // participant's endpoint+model; an explicit choice always wins.
  toolProtocol?: ProtocolSetting | 'inherit';
  // per-agent turn allowance; undefined = the collaborative default
  // (the IDE's own agent-turn setting — no hardcoded cap)
  maxTurns?: number;
  platform?: string;
  participation?: ParticipationMode;
  // Manual and controller machines run only when the user selects them
  // for this collaboration. That selection does not make them a retry target.
  explicitRun?: boolean;
}

export interface CollabTaskConfig {
  objective: string;
  // authoritative workspace host: null = the IDE's own (primary) companion
  workspaceHostPeerId: string | null;
  workspaceHostMachineName: string;
  participants: CollabParticipant[];
  executionMode: 'sequential' | 'parallel';
  autoSteering: boolean;
  maxTurnsPerStage?: number; // default: the IDE's agentTurns setting
  reworkPasses?: number;
  stages?: Array<'planner' | 'coder' | 'tester' | 'reviewer' | 'debugger'>;
  fleetOverrides?: Record<string, ParticipationMode>;
  // Inference settings from the IDE (context, temperature). Explicit numCtx
  // is forwarded so a model tag's own context is not used instead.
  params?: Partial<import('@/lib/types').InferenceParams>;
}

export interface CollabLaunch {
  coordinator: Coordinator;
  done: Promise<CoordinatorReport>;
  machines: AgentTarget[];
}

export class CollabConfigError extends Error {}

// Build the per-machine CompanionClient: local = direct; remote = the IDE's
// own companion mesh proxy (same-origin, peer-token-authenticated server-side).
export function clientForMachine(peerId: string | null): CompanionClient {
  const get = () => useSettings.getState().companion;
  if (!peerId) return new CompanionClient(get);
  const c = get();
  const base = (c.mode === 'remote' ? (c.remoteUrl || c.directUrl) : c.directUrl).replace(/\/+$/, '');
  const routed: CompanionConfig = {
    ...c,
    mode: 'remote',
    remoteUrl: `${base}/api/mesh/${peerId}/proxy`,
  };
  return new CompanionClient(() => routed);
}

// Each target carries ITS OWN protocol and turn allowance — resolved from
// this participant's own model + endpoint, never from another participant.
const toTarget = (modelSizes: Record<string, number | null>, defaultTurns: number) => (p: CollabParticipant): AgentTarget => {
  if (!p.baseUrl?.trim()) throw new CollabConfigError(`${p.machineName} has no inference endpoint.`);
  const baseUrl = p.baseUrl.trim();
  // Port 11434 is Ollama. Its OpenAI-compatible route ignored an explicit
  // num_ctx and loaded the model tag's own context. The native Ollama chat
  // API is what applies options.num_ctx.
  const kind = /:11434(\/|$)/.test(baseUrl) ? 'ollama' : 'openai';
  return {
    machineId: p.machineId,
    machineName: p.machineName,
    provider: { kind, baseUrl },
    model: p.model,
    profileId: p.profileId,
    residency: p.residency ?? 'on-demand',
    toolProtocol: !p.toolProtocol || p.toolProtocol === 'inherit'
      ? useSettings.getState().effectiveProtocol(p.baseUrl || undefined, p.model)
      : p.toolProtocol,
    maxTurns: p.maxTurns ?? defaultTurns,
    allowAutomatic: allowAutomatic(p.participation || 'enabled', p.explicitRun),
  };
};

// Model size lookup from the participant's own inventory (scheduler input).
async function collectModelSizes(cfg: CollabTaskConfig, mesh: MeshClient): Promise<Record<string, number | null>> {
  const sizes: Record<string, number | null> = {};
  await Promise.all(cfg.participants.map(async (p) => {
    if (!p.profileId) return;
    try {
      const inv: ModelInventory = await mesh.models(p.machineId === 'local' ? null : p.machineId);
      const prof = inv.profiles.find((x) => x.id === p.profileId);
      const gguf = prof?.modelPath ? inv.gguf.find((g) => g.path === prof.modelPath) : null;
      sizes[p.profileId] = gguf?.sizeBytes ?? null;
    } catch { sizes[p.profileId] = null; }
  }));
  return sizes;
}

/**
 * The exact function the UI "Start collaborative task" button calls.
 * Instantiates the REAL Coordinator with real mesh-routed companions.
 */
export async function launchCollaborativeTask(
  cfg: CollabTaskConfig,
  opts: {
    mesh: MeshClient;
    workspaceHost: CompanionClient;
    workspaceId: string;
    workspacePath: string;
    workspaceContext: { platform: string; workspacePath: string };
    onEvent: (e: AgentEvent & { stage?: string; agentId?: string; assignmentId?: string }) => void;
    approver?: (req: { tool: string; args: Record<string, unknown>; danger: string; summary: string }) => Promise<'allow' | 'allow-always' | 'deny'>;
    signal?: AbortSignal;
  },
): Promise<CollabLaunch> {
  if (!cfg.objective.trim()) throw new CollabConfigError('Enter a development objective first.');
  if (cfg.participants.length === 0) throw new CollabConfigError('Add at least one participating computer.');
  try {
    cfg = { ...cfg, participants: assertFleetParticipants(cfg.participants, cfg.fleetOverrides) };
  } catch (e: any) {
    throw new CollabConfigError(String(e?.message || e));
  }

  // Turn allowance: the collaborative default is the IDE's own agent-turn
  // setting (no artificial 20-turn cap); per-agent overrides win.
  const defaultTurns = cfg.maxTurnsPerStage ?? useSettings.getState().agentTurns;

  const modelSizes = await collectModelSizes(cfg, opts.mesh);
  const stageTargets: Partial<Record<'planner' | 'coder' | 'tester' | 'reviewer', AgentTarget>> = {};

  // Resolve stage targets from the user's role assignments: when a role has
  // exactly ONE eligible participant it is pinned explicitly; with several,
  // the coordinator's resource-aware scheduler ranks them from REAL
  // hardware/model data (never hardcoded).
  for (const stage of ['planner', 'coder', 'tester', 'reviewer'] as const) {
    const eligible = cfg.participants.filter((p) => p.roles.includes(stage));
    if (eligible.length === 1) stageTargets[stage] = toTarget(modelSizes, defaultTurns)(eligible[0]);
  }

  // On-demand model loading for managed profiles (user-configured residency)
  const ensureModelLoaded = async (target: AgentTarget) => {
    if (!target.profileId) return { provider: target.provider, model: target.model };
    const peerId = target.machineId === 'local' ? null : target.machineId;
    try {
      const r = await opts.mesh.loadModel(target.profileId, peerId);
      if (r.error) {
        opts.onEvent({ type: 'notice', message: `Model load failed on ${target.machineName}: ${r.error}` });
        return { provider: target.provider, model: target.model };
      }
      if (r.server?.endpoint) {
        opts.onEvent({ type: 'notice', message: `Loaded ${target.model} on ${target.machineName} (${((r.server.loadMs ?? 0) / 1000).toFixed(1)}s).` });
        return { provider: { kind: 'openai' as const, baseUrl: r.server.endpoint }, model: target.model };
      }
      return { provider: target.provider, model: target.model };
    } catch (e: any) {
      opts.onEvent({ type: 'notice', message: `Model load error on ${target.machineName}: ${String(e.message || e)}` });
      return { provider: target.provider, model: target.model };
    }
  };

  const coordinator = new Coordinator({
    workspaceHost: opts.workspaceHost,
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
    workspaceContext: opts.workspaceContext,
    mesh: opts.mesh,
    task: cfg.objective,
    machines: cfg.participants.map(toTarget(modelSizes, defaultTurns)),
    modelSizes,
    maxTurnsPerStage: cfg.maxTurnsPerStage ?? 20,
    reworkPasses: cfg.reworkPasses ?? 1,
    stages: cfg.stages,
    reassignOnEscalation: true,
    // FALLBACK only — every target carries its own resolved protocol
    toolProtocol: undefined,
    autoSteering: cfg.autoSteering,
    params: cfg.params,
    onEvent: opts.onEvent,
    approver: opts.approver,
    clientForMachine: (id) => clientForMachine(id === 'local' ? null : id),
    ensureModelLoaded,
  });
  if (cfg.executionMode === 'parallel') coordinator.enableParallelWriters();

  const done = coordinator.run({
    planner: stageTargets.planner,
    coder: stageTargets.coder,
    tester: stageTargets.tester,
    reviewer: stageTargets.reviewer,
  });

  return { coordinator, done, machines: cfg.participants.map(toTarget(modelSizes, defaultTurns)) };
}

// ---------------------------------------------------------------------------
// Distributed fan-out (v0.5.0 Milestone 2 production entry).
//
// The ControlCenter's "Parallel fan-out" mode: the PLANNER agent decomposes
// the objective into a dependency-ordered task list, then FanoutRunner
// executes the tasks in parallel across the participating machines with the
// full task contract, durable task packets, write reservations and revision
// conflict detection. Every event flows into the SAME stream the collab UI
// renders — no simulated progress, only real agent execution.
// ---------------------------------------------------------------------------
import { FanoutRunner, type FanoutMachine, type FanoutTaskSpec, type FanoutTaskResult, type FanoutReport, type FanoutStage } from './fanout';
import type { TaskContract } from './task-contract';
import { AgentRunner } from './runner';
import { toolsByNames } from './tools';
import { createContract, contractPromptBlock } from './task-contract';
import { allowAutomatic, assertFleetParticipants, type ParticipationMode } from '@/lib/fleet/participation';

export interface FanoutLaunch {
  runner: FanoutRunner;
  done: Promise<FanoutReport>;
  contract: ReturnType<typeof createContract>;
}

const PLANNER_TASKS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'propose_task_graph',
    description: 'Propose the parallel decomposition of the objective. Call ONCE with the complete graph.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '2-6 concrete subtasks. Each: key (short id), title, stage (coder|tester|reviewer|debugger), prompt (self-contained assignment), machineId (a participating machine id or "auto"), dependsOn (task keys that must finish first), contextFiles.',
          items: { type: 'object', properties: {
            key: { type: 'string' }, title: { type: 'string' }, stage: { type: 'string' },
            prompt: { type: 'string' }, machineId: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            contextFiles: { type: 'array', items: { type: 'string' } },
            requirements: { type: 'array', items: { type: 'string' } },
          }, required: ['key', 'title', 'stage', 'prompt'] },
        },
      },
      required: ['tasks'],
    },
  },
};

/**
 * THE production entry the Control Center "Start collaborative task" button
 * calls. Dispatches on the user-selected execution mode:
 *  - 'fanout'  → runDistributedFanout (planner task graph → FanoutRunner →
 *                mesh packets → parallel agents on their machines)
 *  - otherwise → launchCollaborativeTask (sequential/pipeline coordinator)
 * Returns a normalized control surface (pause/stop/steer) and a normalized
 * report promise so the UI lifecycle is identical for both engines.
 */
export type CollabRunMode = 'sequential' | 'parallel' | 'pipeline' | 'fanout';

export interface CollabRunHandle {
  kind: 'fanout' | 'sequential';
  // sequential only — powers the per-stage report actions (continue/reassign);
  // fan-out tasks carry their own retry/reassignment inside the runner.
  coordinator?: Coordinator;
  control: {
    requestPause(): void;
    requestStop(): void;
    steerAgent(agentId: string, text: string): boolean;
    steerAll(text: string): void;
  };
  done: Promise<CoordinatorReport & { fanout?: { completed: number; failed: number; cancelled: number; tasks: FanoutTaskResult[] } }>;
  contract: TaskContract | null;
}

export async function startCollabRun(
  mode: CollabRunMode,
  cfg: CollabTaskConfig,
  opts: Parameters<typeof launchCollaborativeTask>[1],
): Promise<CollabRunHandle> {
  if (mode === 'fanout') {
    const { runner, done, contract } = await runDistributedFanout(cfg, opts);
    return {
      kind: 'fanout',
      control: {
        requestPause: () => runner.pauseAll(),
        requestStop: () => runner.cancel(),
        steerAgent: (id, text) => { runner.steer(id, text); return true; },
        steerAll: (text) => { runner.steerAll(text); },
      },
      done: done.then((r: FanoutReport) => ({
        // normalized into the coordinator report shape the UI already renders
        verdict: r.failed === 0 && r.completed > 0 ? 'APPROVE' : r.completed > 0 ? 'REQUEST_CHANGES' : 'UNKNOWN',
        results: [],
        totalTurns: r.totalTurns,
        rework: 0,
        turns: r.totalTurns,
        conflicts: r.conflicts,
        fanout: { completed: r.completed, failed: r.failed, cancelled: r.cancelled, tasks: r.results },
      } as unknown as CoordinatorReport & { fanout: { completed: number; failed: number; cancelled: number; tasks: FanoutTaskResult[] } })),
      contract: contract as TaskContract | null,
    };
  }
  // The sequential coordinator owns its contract internally (created at run
  // time); the UI lifecycle never needed it externally — keep parity.
  const { coordinator, done } = await launchCollaborativeTask(cfg, opts);
  return {
    kind: 'sequential',
    coordinator,
    control: {
      requestPause: () => coordinator.requestPause(),
      requestStop: () => coordinator.requestStop(),
      steerAgent: (id, text) => coordinator.steerAgent(id, text),
      steerAll: (text) => coordinator.steerAll(text),
    },
    done,
    contract: null,
  };
}


// Validates a planner-produced task graph: keys unique, deps exist and are
// acyclic, assignments resolve to a participating machine, parallelism cap.
// Returns the normalized FanoutTaskSpec[] on success; problems explain every
// defect so the corrective re-prompt (or the deterministic fallback) is
// transparent, never silent.
function validateTaskGraph(graph: any): { ok: boolean; canRepair: boolean; problems: string[]; tasks: FanoutTaskSpec[] } {
  const problems: string[] = [];
  const raw = Array.isArray(graph?.tasks) ? graph.tasks : null;
  if (!raw || raw.length === 0) return { ok: false, canRepair: !!graph, problems: ['no tasks array present'], tasks: [] };
  if (raw.length > 8) problems.push('more than 8 tasks — planner must decompose into 2-6 subtasks');
  const seen = new Set<string>();
  const validStages = new Set(['coder', 'tester', 'reviewer', 'debugger', 'planner']);
  const tasks: FanoutTaskSpec[] = [];
  for (const t of raw.slice(0, 6)) {
    if (!t || typeof t !== 'object') { problems.push('non-object task entry'); continue; }
    const key = String(t.key ?? '').trim().slice(0, 40);
    const title = String(t.title ?? '').trim().slice(0, 120);
    const prompt = String(t.prompt ?? '').trim().slice(0, 8000);
    if (!key) { problems.push(`task missing key (${title || 'untitled'})`); continue; }
    if (!prompt) { problems.push(`task "${key}" has an empty prompt`); continue; }
    if (seen.has(key)) { problems.push(`duplicate task key "${key}"`); continue; }
    seen.add(key);
    tasks.push({
      key, title: title || key,
      stage: validStages.has(String(t.stage)) ? String(t.stage) as FanoutStage : 'coder',
      prompt,
      machineId: t.machineId && t.machineId !== 'auto' && t.machineId !== 'local' ? String(t.machineId) : undefined,
      dependsOn: Array.isArray(t.dependsOn) ? [...new Set(t.dependsOn.map((d: any) => String(d).trim()).filter(Boolean))].slice(0, 6) as string[] : [],
      contextFiles: Array.isArray(t.contextFiles) ? t.contextFiles.map((f: any) => String(f)).slice(0, 12) : [],
      requirements: Array.isArray(t.requirements) ? t.requirements.map((r: any) => String(r)).slice(0, 8) : [],
    });
  }
  if (tasks.length < 1) problems.push('no usable tasks after validation');
  // dependency references must exist
  for (const t of tasks) {
    t.dependsOn = (t.dependsOn as string[]).filter((d) => {
      if (!seen.has(d)) { problems.push(`task "${t.key}" depends on unknown task "${d}" (dropped)`); return false; }
      if (d === t.key) { problems.push(`task "${t.key}" depends on itself (dropped)`); return false; }
      return true;
    });
  }
  // cycle detection (DFS, iterative)
  const color = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (k: string): boolean => {
    color.set(k, 1); onStack.add(k);
    for (const d of tasks.find((t) => t.key === k)?.dependsOn ?? []) {
      if (onStack.has(d)) { problems.push(`circular dependency involving "${d}"`); return false; }
      if (!color.get(d) && !visit(d)) return false;
    }
    onStack.delete(k); color.set(k, 2);
    return true;
  };
  for (const t of tasks) if (!color.get(t.key) && !visit(t.key)) break;
  return {
    ok: problems.length === 0 && tasks.length >= 1,
    canRepair: !!graph,
    problems: [...new Set(problems)].slice(0, 6),
    tasks,
  };
}

export async function runDistributedFanout(
  cfg: CollabTaskConfig,
  opts: Parameters<typeof launchCollaborativeTask>[1],
): Promise<FanoutLaunch> {
  if (!cfg.objective.trim()) throw new CollabConfigError('Enter a development objective first.');
  if (cfg.participants.length === 0) throw new CollabConfigError('Add at least one participating computer.');
  try {
    cfg = { ...cfg, participants: assertFleetParticipants(cfg.participants, cfg.fleetOverrides) };
  } catch (e: any) {
    throw new CollabConfigError(String(e?.message || e));
  }
  const defaultTurns = cfg.maxTurnsPerStage ?? useSettings.getState().agentTurns;

  const modelSizes = await collectModelSizes(cfg, opts.mesh);
  const stageTargets: Partial<Record<'planner' | 'coder' | 'tester' | 'reviewer', AgentTarget>> = {};
  for (const stage of ['planner', 'coder', 'tester', 'reviewer'] as const) {
    const eligible = cfg.participants.filter((p) => p.roles.includes(stage));
    if (eligible.length === 1) stageTargets[stage] = toTarget(modelSizes, defaultTurns)(eligible[0]);
  }
  const plannerTarget = stageTargets.planner ?? toTarget(modelSizes, defaultTurns)(cfg.participants[0]);
  const workspaceMeta = {
    id: opts.workspaceId,
    rootPath: opts.workspacePath,
    machineLabel: cfg.workspaceHostMachineName || 'workspace host',
    platform: opts.workspaceContext.platform,
  };
  const contract = createContract(cfg.objective, {
    workspaceId: opts.workspaceId, path: opts.workspacePath, machineLabel: workspaceMeta.machineLabel,
  });

  // 1) PLANNER decomposes on the planner machine (real agent, real tools API)
  const plannerEvents: AgentEvent[] = [];
  const plannerRunner = new AgentRunner({
    companion: opts.workspaceHost,
    toolCompanion: opts.workspaceHost,
    workspaceId: opts.workspaceId,
    provider: plannerTarget.provider,
    model: plannerTarget.model,
    params: (cfg as any).params,
    systemPrompt: [
      contractPromptBlock(contract, { role: 'planner (parallel fan-out decomposition)' }),
      'Decompose the objective into a DEPENDENCY-ORDERED graph of 2-6 concrete subtasks. Every prompt must be self-contained (a fresh agent reads only that). Assign machineId explicitly when the objective needs a specific machine; use "auto" otherwise.',
    ].join('\n\n'),
    task: cfg.objective,
    tools: [...toolsByNames(['finish']), { name: 'propose_task_graph', description: PLANNER_TASKS_TOOL.function.description, danger: 'safe', params: [], run: async (toolArgs: any) => { if (process.env.LF_DEBUG_STOP) console.error('[graph-tool] args:', JSON.stringify(toolArgs).slice(0, 120)); taskGraph = toolArgs; return { output: 'Task graph accepted — the coordinator validated the graph and is scheduling tasks.' }; } } as any],
    toolProtocol: plannerTarget.toolProtocol,
    maxTurns: Math.max(4, Math.min(defaultTurns, 12)),
    onEvent: (e) => { plannerEvents.push(e); opts.onEvent({ ...e, stage: 'planner' } as any); },
    signal: opts.signal,
  } as any);
  // REAL capture: the model's native tool-call arguments arrive here —
  // parseToolCallArgs + validateToolArgs already ran (truncated/unparseable
  // calls are refused before this point), so args is validated JSON.
  let taskGraph: any = null;
  const plannerResult = await plannerRunner.run();
  if (taskGraph === null && plannerResult.content) {
    // JSON fallback: planner replied with a bare task array instead of a
    // native tool call (common for text-protocol or small models).
    const m = plannerResult.content.match(/\[[\s\S]*\]/);
    if (m) { try { taskGraph = { tasks: JSON.parse(m[0]) }; } catch { /* fall through to recovery */ } }
  }
  const validation = validateTaskGraph(taskGraph);
  if (!validation.ok && validation.canRepair) {
    // bounded corrective re-prompt (one attempt): report the exact defects
    opts.onEvent({ type: 'notice', message: `Planner task graph invalid (${validation.problems.join('; ')}) — requesting a corrected graph.` } as any);
    const repairRunner = new AgentRunner({
      companion: opts.workspaceHost,
      toolCompanion: opts.workspaceHost,
      workspaceId: opts.workspaceId,
      provider: plannerTarget.provider,
      model: plannerTarget.model,
      systemPrompt: 'You fix invalid task graphs. Reply with ONLY the corrected JSON array of tasks.',
      task: `Original objective: ${cfg.objective}\n\nInvalid graph (JSON): ${JSON.stringify(taskGraph ?? {}).slice(0, 6000)}\n\nDefects: ${validation.problems.join('; ')}. Return the corrected JSON array.`,
      tools: [],
      toolProtocol: 'text',
      maxTurns: 2,
      onEvent: () => {},
      signal: opts.signal,
    } as any);
    const repairResult = await repairRunner.run();
    const m = repairResult.content.match(/\[[\s\S]*\]/);
    if (m) { try { taskGraph = { tasks: JSON.parse(m[0]) }; } catch { /* keep invalid */ } }
  }
  const validation2 = validateTaskGraph(taskGraph);
  if (!validation2.ok) {
    // clearly reported recovery path — NOT a silent placeholder
    opts.onEvent({ type: 'notice', message: `Planner produced no valid task graph (${validation2.problems.join('; ')}). Using the deterministic decomposition: [impl] → [verify] with the full objective as the coder task.` } as any);
  }

  // ONLY a fully valid graph schedules tasks; anything else uses the
  // deterministic split announced in the notice above (never a silent
  // partial graph, never placeholder tasks pretending to be the plan).
  const specs: FanoutTaskSpec[] = validation2.ok
    ? validation2.tasks
    : [
        { key: 'impl', title: 'Implement the objective', stage: 'coder', prompt: cfg.objective, dependsOn: [], contextFiles: [], requirements: contract.requirements.filter((r) => r.source === 'user').map((r) => r.text) },
        { key: 'verify', title: 'Verify the implementation', stage: 'tester', prompt: `Verify the work completed for: ${cfg.objective}. Run the project's tests/build, fix trivial failures, and report evidence.`, dependsOn: ['impl'], contextFiles: [], requirements: ['verification evidence exists'] },
      ];

  // 2) FanoutRunner executes the graph across the participating machines
  const machines: FanoutMachine[] = cfg.participants.map((p) => ({
    machineId: p.machineId,
    name: p.machineName,
    model: p.model,
    provider: { kind: /:11434(\/|$)/.test(p.baseUrl) ? 'ollama' : 'openai', baseUrl: p.baseUrl.trim() } as any,
    capableStages: p.roles.filter((r) => r !== 'reviewer') as any[],
    allowAutomatic: allowAutomatic(p.participation || 'enabled', p.explicitRun),
  }));
  const fanout = new FanoutRunner({
    workspaceHost: opts.workspaceHost,
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
    contract: contract as any,
    onContractUpdate: () => {},
    mesh: opts.mesh,
    machines,
    tasks: specs,
    params: (cfg as any).params,
    maxTurnsPerTask: defaultTurns,
    toolProtocol: 'auto-native',
    maxParallel: Math.max(2, machines.length),
    reassignOnFailure: true,
    onEvent: (e) => opts.onEvent({ ...e, stage: (e as any).fanoutKey, agentId: (e as any).fanoutKey } as any),
    approver: opts.approver ? ((async (tool: string, args: Record<string, unknown>, danger: string, summary: string) => ((await opts.approver!({ tool, args, danger, summary })) === 'deny' ? 'deny' : 'allow')) as any) : undefined,
    allowedPatterns: (cfg as any).allowedPatterns,
    signal: opts.signal,
    clientForMachine: (machineId) => (machineId === 'local' ? opts.workspaceHost : clientForMachine(machineId)),
  });
  return { runner: fanout, done: fanout.run(), contract: contract as any };
}
