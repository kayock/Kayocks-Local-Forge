// Mesh store (Phase 2.0): connected computers, model inventories, agent
// registry, shared notebook — the state behind the Control Center panels.
import { create } from 'zustand';
import type { CompanionConfig } from '@/lib/companion/client';
import { MeshClient } from '@/lib/mesh/client';
import { useSettings } from '@/lib/store/settings';
import type {
  AgentAssignment,
  DiscoveredPeer,
  MeshPeer,
  ModelInventory,
  NotebookEntry,
  PeerStatus,
} from '@/lib/mesh-types';

export interface AgentView {
  agentId: string;
  role: string;
  machine: string;
  machineId: string | null;
  model: string;
  state: 'idle' | 'working' | 'waiting' | 'error' | 'done';
  currentTask: string | null;
  currentTool: string | null;
  turns: number;
  lastEventAt: number;
}

interface MeshState {
  peers: MeshPeer[];
  discovered: DiscoveredPeer[];
  peerStatus: Record<string, PeerStatus>;
  models: ModelInventory | null;
  primaryHardware: import('@/lib/mesh-types').HardwareInventory | null;
  agents: Record<string, AgentView>;
  assignments: AgentAssignment[];
  notebook: NotebookEntry[];
  loading: boolean;
  lastError: string | null;

  client: () => MeshClient;
  refreshMesh: () => Promise<void>;
  refreshModels: () => Promise<void>;
  refreshAssignments: (workspaceId: string) => Promise<void>;
  refreshNotebook: (workspaceId: string, since?: number) => Promise<void>;
  connectPeer: (url: string, opts: { name?: string; code?: string }) => Promise<{ ok: boolean; error?: string }>;
  removePeer: (id: string) => Promise<void>;
  upsertAgent: (a: Partial<AgentView> & { agentId: string }) => void;
  setAgentState: (agentId: string, patch: Partial<AgentView>) => void;
  clearAgents: () => void;
}

let mid = 0;

export const useMesh = create<MeshState>()((set, get) => ({
  peers: [],
  discovered: [],
  peerStatus: {},
  models: null,
  primaryHardware: null,
  agents: {},
  assignments: [],
  notebook: [],
  loading: false,
  lastError: null,

  client: () => new MeshClient(() => useSettings.getState().companion),

  refreshMesh: async () => {
    set({ loading: true });
    try {
      const c = get().client();
      const [status, hw] = await Promise.all([c.meshStatus(), c.hardware().catch(() => null)]);
      set({ peers: status.peers, discovered: status.discovered, primaryHardware: hw, lastError: null });
      // refresh per-peer status lazily (bounded: 8 peers max per pass)
      for (const p of status.peers.slice(0, 8)) {
        get().client().peerStatus(p.id)
          .then((ps) => set((s) => ({ peerStatus: { ...s.peerStatus, [p.id]: ps } })))
          .catch(() => set((s) => ({ peerStatus: { ...s.peerStatus, [p.id]: { peer: p, reachable: false, health: null, hardware: null } } })));
      }
    } catch (e: any) {
      set({ lastError: String(e.message || e) });
    } finally {
      set({ loading: false });
    }
  },

  refreshModels: async () => {
    try {
      const inv = await get().client().models();
      set({ models: inv });
    } catch (e: any) {
      set({ lastError: String(e.message || e) });
    }
  },

  refreshAssignments: async (workspaceId) => {
    try {
      const r = await get().client().listAssignments(workspaceId);
      set({ assignments: r.assignments });
    } catch { /* not paired yet */ }
  },

  refreshNotebook: async (workspaceId, since) => {
    try {
      const r = await get().client().notebookList(workspaceId, { since });
      set((s) => ({ notebook: since !== undefined ? [...s.notebook, ...r.entries] : r.entries }));
    } catch { /* not paired yet */ }
  },

  connectPeer: async (url, opts) => {
    try {
      const r = await get().client().connectPeer(url, opts);
      await get().refreshMesh();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) };
    }
  },

  removePeer: async (id) => {
    try { await get().client().removePeer(id); } catch { /* ignore */ }
    await get().refreshMesh();
  },

  upsertAgent: (a) =>
    set((s) => {
      const cur = s.agents[a.agentId];
      return { agents: { ...s.agents, [a.agentId]: { ...cur, ...a } as AgentView } };
    }),

  setAgentState: (agentId, patch) =>
    set((s) => {
      const cur = s.agents[agentId];
      if (!cur) return {};
      return { agents: { ...s.agents, [agentId]: { ...cur, ...patch, lastEventAt: Date.now() } } };
    }),

  clearAgents: () => set({ agents: {} }),
}));

export const genAssignmentId = () => `asg_${Date.now().toString(36)}_${++mid}`;
