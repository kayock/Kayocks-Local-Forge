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
  // the inference endpoint AS THE PARTICIPANT MACHINE SEES IT (e.g. FOXAI on
  // the Windows Dell: http://127.0.0.1:8080/v1). For a managed profile the
  // loaded server's own endpoint is used automatically.
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
const toTarget = (modelSizes: Record<string, number | null>, defaultTurns: number) => (p: CollabParticipant): AgentTarget => ({
  machineId: p.machineId,
  machineName: p.machineName,
  provider: { kind: 'openai', baseUrl: p.baseUrl || 'http://127.0.0.1:8080/v1' },
  model: p.model,
  profileId: p.profileId,
  residency: p.residency ?? 'on-demand',
  toolProtocol: !p.toolProtocol || p.toolProtocol === 'inherit'
    ? useSettings.getState().effectiveProtocol(p.baseUrl || undefined, p.model)
    : p.toolProtocol,
  maxTurns: p.maxTurns ?? defaultTurns,
});

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
    reworkPasses: 1,
    reassignOnEscalation: true,
    // FALLBACK only — every target carries its own resolved protocol
    toolProtocol: undefined,
    autoSteering: cfg.autoSteering,
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
