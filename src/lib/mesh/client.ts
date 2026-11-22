// MeshClient — the IDE's control-plane access to the LOCAL companion's mesh,
// Model Manager and agent-memory APIs (Phase 2.0). Remote companions are
// reached THROUGH the local companion's authenticated proxy route
// (/api/mesh/<peerId>/proxy/...), which solves mixed-origin browser
// constraints and keeps every request inside the user's LAN.
import type { CompanionConfig } from '@/lib/companion/client';
import type {
  AgentAssignment,
  DiscoveredPeer,
  LoadResult,
  MeshPeer,
  ModelInventory,
  NotebookEntry,
  PeerStatus,
  Scratchpad,
  StartupDiagnostics,
} from '@/lib/mesh-types';

export class MeshError extends Error {
  constructor(message: string, public status?: number, public payload?: unknown) {
    super(message);
  }
}

type CfgGetter = () => CompanionConfig;

export class MeshClient {
  constructor(private getCfg: CfgGetter) {}

  private url(path: string, query?: Record<string, string>): string {
    const c = this.getCfg();
    if (c.mode === 'gateway') {
      if (c.gatewayPath) {
        const qs = query ? '?' + new URLSearchParams(query).toString() : '';
        return `${c.gatewayPath}${path}${qs}`;
      }
      const qs = new URLSearchParams({ XTransformPort: String(c.gatewayPort), ...(query || {}) });
      return `${path}?${qs}`;
    }
    const base = (c.mode === 'remote' ? (c.remoteUrl || c.directUrl) : c.directUrl).replace(/\/+$/, '');
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return `${base}${path}${qs}`;
  }

  private headers(json = true): Record<string, string> {
    const c = this.getCfg();
    const h: Record<string, string> = {};
    if (c.token) h.Authorization = `Bearer ${c.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path, query), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new MeshError(json?.error || `Mesh request failed (${res.status})`, res.status, json);
    return json as T;
  }

  // ---- inventory ----
  // Every method takes an OPTIONAL peerId: null/undefined = the primary
  // companion; a peer id routes the SAME authenticated call through the mesh
  // proxy so the operation executes ON THAT MACHINE (Phase 2.1 Priority 2).
  private peerPath(peerId: string | null | undefined, path: string): string {
    return peerId ? `/api/mesh/${peerId}/proxy${path}` : path;
  }

  async hardware(peerId?: string | null): Promise<import('@/lib/mesh-types').HardwareInventory> {
    return this.req('GET', this.peerPath(peerId, '/api/hardware'));
  }

  async models(peerId?: string | null): Promise<ModelInventory> {
    return this.req('GET', this.peerPath(peerId, '/api/models'));
  }

  async modelStatus(serverId: string, peerId?: string | null): Promise<{ server: ModelInventory['servers'][number] }> {
    return this.req('GET', this.peerPath(peerId, `/api/models/status/${serverId}`));
  }

  async modelDiagnostics(serverId: string, peerId?: string | null): Promise<{ server: ModelInventory['servers'][number]; diagnostics: StartupDiagnostics | null }> {
    return this.req('GET', this.peerPath(peerId, `/api/models/diagnostics/${serverId}`));
  }

  async addModelDir(path: string, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, '/api/models/dirs'), { path });
  }

  async removeModelDir(path: string, peerId?: string | null) {
    return this.req('DELETE', this.peerPath(peerId, '/api/models/dirs'), { path });
  }

  async saveProfile(profile: Record<string, unknown>, peerId?: string | null): Promise<{ profile: ModelInventory['profiles'][number] }> {
    return this.req('POST', this.peerPath(peerId, '/api/models/profiles'), profile);
  }

  async deleteProfile(id: string, peerId?: string | null) {
    return this.req('DELETE', this.peerPath(peerId, `/api/models/profiles/${id}`));
  }

  async loadModel(profileId: string, peerId?: string | null): Promise<LoadResult> {
    return this.req('POST', this.peerPath(peerId, '/api/models/load'), { profileId });
  }

  async unloadModel(opts: { serverId?: string; profileId?: string }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, '/api/models/unload'), opts);
  }

  async addExternalEndpoint(name: string, endpoint: string, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, '/api/models/external'), { name, endpoint });
  }

  // Live server logs for a managed inference server (real stdout/stderr ring
  // buffer captured on the owning machine).
  async serverOutput(serverId: string, peerId?: string | null, since = 0): Promise<{ proc: { id: string; status: string; exitCode: number | null }; output: string; byteOffset: number }> {
    return this.req('GET', this.peerPath(peerId, `/api/models/output/${serverId}`), undefined, { since: String(since) });
  }

  // ---- mesh ----
  async meshStatus(): Promise<{ instanceId: string; peers: MeshPeer[]; discovered: DiscoveredPeer[] }> {
    return this.req('GET', '/api/mesh/status');
  }

  async connectPeer(url: string, opts: { name?: string; code?: string; deviceLabel?: string } = {}): Promise<{ peer: MeshPeer; paired: boolean; health: any }> {
    return this.req('POST', '/api/mesh/connect', { url, ...opts });
  }

  async peerStatus(peerId: string): Promise<PeerStatus> {
    return this.req('GET', `/api/mesh/peers/${peerId}`);
  }

  async removePeer(peerId: string) {
    return this.req('DELETE', `/api/mesh/peers/${peerId}`);
  }

  async pairPeer(peerId: string, code: string, deviceLabel?: string) {
    return this.req('POST', `/api/mesh/peers/${peerId}/pair`, { code, deviceLabel });
  }

  // ---- Companion networking configuration (Phase 2.2 Fix 1) ----
  // GET/POST /api/network with an OPTIONAL peerId: the same authenticated API
  // reaches the local companion directly or a paired peer through the mesh
  // proxy. This is what the Control Center's Companion Networking panel uses.
  async network(peerId?: string | null): Promise<{
    host: string; port: number; lanEnabled: boolean;
    active: { host: string; port: number };
    pendingRestart: boolean;
    lanAddresses: { name: string; address: string; url?: string }[];
    loopbackUrl: string;
    security: { pairingRequired: boolean; note: string };
    service: { systemdUnit: string; managementHint: string };
  }> {
    return this.req('GET', this.peerPath(peerId, '/api/network'));
  }

  async setNetwork(patch: { host?: string; lanEnabled?: boolean; port?: number }, peerId?: string | null): Promise<{ applied: boolean; host: string; port: number; lanEnabled: boolean; lanAddresses: { name: string; address: string }[] }> {
    return this.req('POST', this.peerPath(peerId, '/api/network'), patch);
  }

  async networkTest(url: string, peerId?: string | null): Promise<{ target: string; reachable: boolean; isLocalforgeCompanion: boolean; version: string | null; detail: string }> {
    return this.req('POST', this.peerPath(peerId, '/api/network/test'), { url });
  }

  async fleetParticipation(): Promise<{ participation: Record<string, 'controller' | 'enabled' | 'manual'> }> {
    return this.req('GET', '/api/fleet/participation');
  }

  async setFleetParticipation(machineId: string, mode: 'controller' | 'enabled' | 'manual'): Promise<{ participation: Record<string, 'controller' | 'enabled' | 'manual'> }> {
    return this.req('PUT', '/api/fleet/participation', { machineId, mode });
  }

  // A peer's Model Manager inventory (scheduler input for remote machines).
  async peerModels(peerId: string): Promise<ModelInventory | null> {
    try {
      return await this.models(peerId);
    } catch {
      return null;
    }
  }

  // ---- agent memory ----
  async readScratchpad(workspaceId: string, agentId: string): Promise<Scratchpad> {
    return this.req('GET', `/api/agents/${workspaceId}/scratchpad/${agentId}`);
  }

  async writeScratchpad(workspaceId: string, agentId: string, patch: Partial<Scratchpad>): Promise<Scratchpad> {
    return this.req('PUT', `/api/agents/${workspaceId}/scratchpad/${agentId}`, patch);
  }

  async notebookAppend(workspaceId: string, entry: { agentId: string; kind: NotebookEntry['kind']; content: string; refs?: string }): Promise<NotebookEntry> {
    return this.req('POST', `/api/agents/${workspaceId}/notebook`, entry);
  }

  async notebookList(workspaceId: string, opts: { since?: number; agent?: string; kind?: string } = {}): Promise<{ entries: NotebookEntry[] }> {
    const q: Record<string, string> = {};
    if (opts.since !== undefined) q.since = String(opts.since);
    if (opts.agent) q.agent = opts.agent;
    if (opts.kind) q.kind = opts.kind;
    return this.req('GET', `/api/agents/${workspaceId}/notebook`, undefined, q);
  }

  async saveAssignment(workspaceId: string, a: AgentAssignment): Promise<AgentAssignment> {
    return this.req('POST', `/api/agents/${workspaceId}/assignments`, a);
  }

  async listAssignments(workspaceId: string): Promise<{ assignments: AgentAssignment[] }> {
    return this.req('GET', `/api/agents/${workspaceId}/assignments`);
  }

  // Workspace revision: hash over the primary workspace tree (paths+sizes)
  // used for change detection / conflict detection between agents.
  async workspaceRevision(workspaceId: string, peerId?: string | null): Promise<{ revision: string; entries: number }> {
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/revision`));
  }

  // ---- RC3: task checkpoints (shadow git on the workspace host) ----
  async createCheckpoint(workspaceId: string, label: string, peerId?: string | null): Promise<{ available: boolean; checkpoint?: { id: string; hash: string; label: string; at: number }; error?: string }> {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/checkpoints`), { label });
  }
  async listCheckpoints(workspaceId: string, peerId?: string | null): Promise<{ available: boolean; checkpoints: { id: string; hash: string; label: string; at: number }[] }> {
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/checkpoints`));
  }
  async checkpointDiff(workspaceId: string, hash: string, peerId?: string | null): Promise<{ available: boolean; files?: string[]; stat?: string; error?: string }> {
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/checkpoints/${encodeURIComponent(hash)}/diff`));
  }
  async restoreCheckpoint(workspaceId: string, hash: string, peerId?: string | null): Promise<{ available: boolean; restored?: string; removedFiles?: string[]; safetyCheckpoint?: any; error?: string }> {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/checkpoints/${encodeURIComponent(hash)}/restore`), {});
  }

  // ---- Milestone 2: mDNS discovery (never pairs; explicit user action) ----
  async discover(): Promise<{
    available: boolean; enabled?: boolean; reason?: string; serviceType?: string;
    self?: { instanceId: string; name: string; port: number; host: string; advertising: boolean; lanAddresses: { iface: string; address: string }[] };
    discovered: { instanceId: string; name: string; host: string; port: number; url: string; version: string; platform: string; online: boolean; secondsSinceSeen: number; local: boolean }[];
  }> {
    return this.req('GET', '/api/mesh/discover');
  }

  // ---- Milestone 2: cross-machine task packets ----
  async createTask(workspaceId: string, task: {
    title: string; contract?: string; requirements?: string[]; contextFiles?: string[];
    workspaceMapping?: { local?: string; remote?: string; revision?: string };
    assignedMachine?: string; machineId?: string; agentId?: string; dedupKey?: string;
    dependsOn?: string[]; priority?: number;
  }): Promise<{ task: FleetTask; deduplicated: boolean }> {
    return this.req('POST', `/api/ws/${workspaceId}/tasks`, task);
  }

  async listTasks(workspaceId: string, opts: { status?: string; machineId?: string; since?: number } = {}, peerId?: string | null): Promise<{ tasks: FleetTask[]; serverTime: number }> {
    const q: Record<string, string> = {};
    if (opts.status) q.status = opts.status;
    if (opts.machineId) q.machineId = opts.machineId;
    if (opts.since !== undefined) q.since = String(opts.since);
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks`), undefined, q);
  }

  async getTask(workspaceId: string, taskId: string, peerId?: string | null): Promise<{ task: FleetTask }> {
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}`));
  }

  async ackTask(workspaceId: string, taskId: string, body: { agentId?: string; machineId?: string }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}/ack`), body);
  }

  async taskProgress(workspaceId: string, taskId: string, body: { note: string; status?: string }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}/progress`), body);
  }

  async completeTask(workspaceId: string, taskId: string, body: { summary: string; artifacts?: { path: string; bytes?: number }[]; filesChanged?: string[]; revisionAfter?: string; evidence?: { kind: string; detail: string }[] }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}/complete`), body);
  }

  async failTask(workspaceId: string, taskId: string, body: { reason: string; recoverable?: boolean }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}/fail`), body);
  }

  async cancelTask(workspaceId: string, taskId: string, body: { reason?: string }, peerId?: string | null) {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/tasks/${taskId}/cancel`), body);
  }

  // ---- Milestone 2: workspace write reservations ----
  async listLocks(workspaceId: string, peerId?: string | null): Promise<{ reservations: { path: string; owner: string; expiresAt: number; createdAt: number }[] }> {
    return this.req('GET', this.peerPath(peerId, `/api/ws/${workspaceId}/locks`));
  }

  async acquireLock(workspaceId: string, path: string, owner: string, opts?: { ttlMs?: number }, peerId?: string | null): Promise<{ locked: boolean; reservation?: { path: string; owner: string; expiresAt: number } }> {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/locks`), { path, owner, ttlMs: opts?.ttlMs });
  }

  async releaseLock(workspaceId: string, path: string, owner: string, peerId?: string | null): Promise<{ released: boolean }> {
    return this.req('POST', this.peerPath(peerId, `/api/ws/${workspaceId}/locks`), { path, owner, release: true });
  }
}

export interface FleetTask {
  id: string;
  wsId: string;
  title: string;
  contract?: string | null;
  requirements: string[];
  contextFiles: string[];
  workspaceMapping?: { local?: string | null; remote?: string | null; revision?: string | null } | null;
  assignedMachine?: string | null;
  machineId?: string | null;
  agentId?: string | null;
  dedupKey?: string | null;
  dependsOn: string[];
  priority: number;
  status: 'queued' | 'acknowledged' | 'in-progress' | 'completed' | 'failed' | 'cancelled';
  progress: { note: string; at: number }[];
  result?: { summary: string; artifacts: { path: string; bytes: number | null }[]; filesChanged: string[]; revisionAfter?: string | null } | null;
  error?: { reason: string; recoverable: boolean } | null;
  evidence: { kind: string; detail: string; at: number }[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt?: number | null;
  endedAt?: number | null;
}
