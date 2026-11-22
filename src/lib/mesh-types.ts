// Shared types for the LocalForge mesh / Model Manager / agents (Phase 2.0).
// Mirrors the companion's REST payloads (companion/src/platform.js,
// modelmgr.js, mesh.js, agentmem.js).

export interface GpuInfo {
  kind: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' | null;
  name: string | null;
  vramBytes: number | null;
  driver: string | null;
}

export interface HardwareInventory {
  platform: string;
  platformVersion: string;
  arch: string;
  hostname: string;
  cpuModel: string | null;
  cpuCores: number;
  ramTotalBytes: number | null;
  ramAvailableBytes: number | null;
  gpus: GpuInfo[];
  npu: { detected: boolean; runtime: string | null; detail: string | null };
  inferenceRuntimes: string[];
  measuredAt: number;
}

export interface GgufModel {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  dir: string;
  estimatedRamBytes: number; // ESTIMATE (file size + ~20%), never a promise
}

export interface ModelProfile {
  id: string;
  name: string;
  backend: 'llamacpp' | 'ollama' | 'external' | 'foxai' | 'openvino';
  modelPath?: string | null;
  serverExe?: string | null;
  modelId?: string | null;
  endpoint?: string | null;
  host?: string;
  port?: number | null;
  ctx?: number;
  nPredict?: number | null; // max generated tokens — DISTINCT from ctx
  threads?: number | null;
  ngl?: number | null;
  parallel?: number | null;
  extraArgs?: string | string[] | null;
  timeoutMs?: number;
  toolProtocol?: string;
  residency?: 'on-demand' | 'keep-loaded';
  ollamaUrl?: string;
  enabled?: boolean;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelServerRecord {
  id: string;
  profileId: string;
  profileName: string;
  backend: string;
  host: string;
  port?: number | null;
  endpoint: string;
  ownership: 'localforge-managed' | 'ollama' | 'foxai' | 'external';
  status: 'loading' | 'ready' | 'stopped' | 'failed' | 'exited' | 'unknown';
  pid?: number | null;
  startedAt: number;
  readyAt?: number | null;
  loadMs?: number;
  exitCode?: number | null;
  lastError?: string | null;
  hasDiagnostics?: boolean;
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quant: string | null;
  state: 'installed' | 'loaded';
}

export interface ExternalEndpointInfo {
  id: string;
  name: string;
  endpoint: string;
  addedAt: string;
  reachable?: boolean;
  models?: { id: string }[];
  state?: 'ready' | 'unreachable';
}

export interface ModelInventory {
  hardware: HardwareInventory;
  dirs: string[];
  gguf: GgufModel[];
  ollama: { reachable: boolean; url: string | null; models: OllamaModelInfo[] };
  external: ExternalEndpointInfo[];
  profiles: ModelProfile[];
  servers: ModelServerRecord[];
}

export interface StartupDiagnostics {
  profileId: string;
  name: string;
  backend: string;
  startedAt: string;
  command: string | null;
  env: Record<string, string | null>;
  healthAttempts: number;
  healthTimeline: { at: number; status: number; body: string }[];
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  portBusy: boolean;
  fileMissing: boolean;
  suggestions: string[];
}

// ---- mesh peers ----
export interface MeshPeer {
  id: string;
  name: string;
  url: string;
  platform?: string;
  version?: string;
  buildId?: string;
  addedAt: string;
  lastSeenAt?: number;
  lastStatus?: string;
  paired?: boolean;
}

export interface DiscoveredPeer {
  id: string;
  name: string;
  version: string;
  buildId?: string;
  platform: string;
  address: string;
  httpPort: number;
  url: string;
  lastSeenAt: number;
  staleMs: number;
}

export interface PeerStatus {
  peer: MeshPeer;
  reachable: boolean;
  health: { version: string; buildId: string; platform: string } | null;
  hardware: HardwareInventory | null;
}

// ---- agent memory ----
export interface Scratchpad {
  agentId: string;
  workspaceId: string;
  objective: string | null;
  plan: string[];
  findings: string[];
  toolResults: string[];
  errors: string[];
  pending: string[];
  capabilities: string[];
  progress: string;
  updatedAt: string | null;
}

export interface NotebookEntry {
  seq: number;
  id: string;
  at: number;
  agentId: string;
  kind: 'finding' | 'handoff' | 'decision' | 'issue';
  content: string;
  refs?: string | null;
}

export interface AgentAssignment {
  id: string;
  agentId: string;
  role: string;
  machine: string;
  machineId?: string | null; // mesh peer id or 'local'
  model: string;
  task: string;
  status: 'pending' | 'in-progress' | 'done' | 'error' | 'cancelled' | 'conflict';
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  resultSummary?: string;
  conflict?: string | null;
  updatedAt?: string;
}

// ---- control-plane request shapes ----
export interface LoadResult {
  error?: string;
  unsupported?: boolean;
  attachable?: boolean;
  existingServerId?: string | null;
  server?: ModelServerRecord;
  diagnostics?: StartupDiagnostics;
  status?: number;
}
