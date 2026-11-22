// Persistent client settings: companion connection, providers, model,
// inference parameters and execution policy. Stored in browser localStorage —
// API keys for remote endpoints stay in the browser, never on our servers.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CompanionConfig } from '@/lib/companion/client';
import type { InferenceParams, ProviderConfig, PolicyMode } from '@/lib/types';
import type { ToolProtocolMode } from '@/lib/agent/types';

export interface SavedProvider extends ProviderConfig {
  id: string;
  models?: import('@/lib/types').ModelInfo[];
  // 0.4.4 discovery/auth state (kept honest per provider card)
  authRequired?: boolean;
  authOk?: boolean;
  authSource?: import('@/lib/types').DiscoveredProvider['authSource'];
  status?: import('@/lib/types').ProviderStatus;
  serverType?: string;
  machineLabel?: string;
  lastDiscoveredAt?: number;
}

export type ProtocolSetting = ToolProtocolMode | 'auto-native' | 'force-text';

interface SettingsState {
  companion: CompanionConfig;
  providers: SavedProvider[];
  activeProviderId: string | null;
  model: string;
  inference: InferenceParams;
  policy: PolicyMode;
  toolProtocol: ProtocolSetting;
  // agent turn budget per run (spec §3.8: configurable, not a hard wall —
  // "Continue task" resumes past it with full context preserved)
  agentTurns: number;
  // Cline-style Plan/Act working mode (persisted)
  agentDevMode: 'plan' | 'act';
  // learned protocol per provider/model profile (spec §3.2): e.g. when an
  // auto-mode run falls back, the reason is recorded and the effective mode
  // persists for that model instead of re-probing every run.
  modelProtocols: Record<string, { mode: ToolProtocolMode; reason: string; at: number }>;
  // Forge upgrade — Part 2: learned tool-call dialect per provider/model
  // (json | tagged | py | native). The harness leads with the dialect that
  // worked last time, ALS-style.
  modelDialects: Record<string, { dialect: 'native' | 'json' | 'tagged' | 'py'; at: number; successes: number }>;
  // per-stage model overrides for the pipeline
  pipelineModels: Partial<Record<'planner' | 'coder' | 'tester' | 'reviewer', string>>;
  // Forge upgrade — Problem A/E: when a run stalls, offer/perform escalation
  // to the first other configured model
  autoEscalate: boolean;
  // Forge upgrade — Fleet Map: human label of the machine this IDE talks to
  machineLabel: string;
  // Collaborate tab: persisted participant presets (machine, endpoint, roles)
  collabParticipants: Array<Record<string, unknown>>;

  setCompanion: (patch: Partial<CompanionConfig>) => void;
  setToken: (token: string | null) => void;
  addProvider: (p: Omit<SavedProvider, 'id'>) => SavedProvider;
  updateProvider: (id: string, patch: Partial<SavedProvider>) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;
  setModel: (m: string) => void;
  setInference: (patch: Partial<InferenceParams>) => void;
  setPolicy: (p: PolicyMode) => void;
  setToolProtocol: (p: ProtocolSetting) => void;
  setAgentTurns: (n: number) => void;
  setAgentDevMode: (m: 'plan' | 'act') => void;
  recordModelProtocol: (providerBaseUrl: string, model: string, mode: ToolProtocolMode, reason: string) => void;
  effectiveProtocol: (providerBaseUrl: string | undefined, model: string) => ProtocolSetting;
  recordModelDialect: (providerBaseUrl: string, model: string, dialect: 'native' | 'json' | 'tagged' | 'py') => void;
  setPipelineModel: (stage: string, model: string) => void;
  setAutoEscalate: (v: boolean) => void;
  setMachineLabel: (l: string) => void;
  setCollabParticipants: (ps: Array<Record<string, unknown>>) => void;
}

const genId = () => `p_${Math.random().toString(36).slice(2, 10)}`;

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      companion: {
        // Default connects to the user's own machine. In sandboxed demo
        // deployments the IDE flips this to gateway mode via ?companion=gateway.
        mode: 'direct',
        directUrl: 'http://127.0.0.1:7337',
        remoteUrl: '',
        gatewayPort: 7337,
        token: null,
      },
      providers: [],
      activeProviderId: null,
      model: '',
      inference: { temperature: 0.2, topP: 0.9, maxTokens: 2048, numCtx: 8192 },
      policy: 'confirm-commands',
      toolProtocol: 'auto',
      agentTurns: 40,
    agentDevMode: 'act',
      modelProtocols: {},
      modelDialects: {},
      pipelineModels: {},
      autoEscalate: false,
      machineLabel: 'This computer',
      collabParticipants: [],

      setCompanion: (patch) => set((s) => ({ companion: { ...s.companion, ...patch } })),
      setToken: (token) => set((s) => ({ companion: { ...s.companion, token } })),
      addProvider: (p) => {
        const id = genId();
        set((s) => ({ providers: [...s.providers, { ...p, id }], activeProviderId: s.activeProviderId ?? id, model: s.model || (p as any).models?.[0]?.id || '' }));
        return { ...p, id };
      },
      updateProvider: (id, patch) => set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removeProvider: (id) =>
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
        })),
      setActiveProvider: (id) => set({ activeProviderId: id }),
      setModel: (m) => set({ model: m }),
      setInference: (patch) => set((s) => ({ inference: { ...s.inference, ...patch } })),
      setPolicy: (p) => set({ policy: p }),
      setToolProtocol: (p) => set({ toolProtocol: p }),
      setAgentDevMode: (m) => set({ agentDevMode: m }),
      setAgentTurns: (n) => set({ agentTurns: Math.max(5, Math.min(500, Math.round(Number(n) || 40))) }),
      recordModelProtocol: (baseUrl, model, mode, reason) =>
        set((s) => {
          const key = `${String(baseUrl || '').replace(/\/+$/, '')}::${model}`;
          // never silently downgrade a working native protocol to text:
          // only record the FIRST decision for a model profile
          if (s.modelProtocols[key]) return s;
          return { modelProtocols: { ...s.modelProtocols, [key]: { mode, reason, at: Date.now() } } };
        }),
      effectiveProtocol: (baseUrl, model) => {
        const key = `${String(baseUrl || '').replace(/\/+$/, '')}::${model}`;
        const s = get();
        const learned = s.modelProtocols[key];
        // explicit user choice always wins; otherwise the learned per-model mode
        return learned ? (s.toolProtocol === 'auto' ? learned.mode : s.toolProtocol) : s.toolProtocol;
      },
      setPipelineModel: (stage, model) => set((s) => ({ pipelineModels: { ...s.pipelineModels, [stage]: model } })),
      recordModelDialect: (baseUrl, model, dialect) =>
        set((s) => {
          const key = `${String(baseUrl || '').replace(/\/+$/, '')}::${model}`;
          const prev = s.modelDialects[key];
          // the first observed dialect leads from then on; repeated successes
          // reinforce it. Only a markedly different success pattern (recorded
          // by the drills) should overwrite it — kept simple here.
          if (prev) return { modelDialects: { ...s.modelDialects, [key]: { dialect: prev.dialect, at: Date.now(), successes: prev.successes + 1 } } };
          return { modelDialects: { ...s.modelDialects, [key]: { dialect, at: Date.now(), successes: 1 } } };
        }),
      setAutoEscalate: (v) => set({ autoEscalate: v }),
      setMachineLabel: (l) => set({ machineLabel: l }),
      setCollabParticipants: (ps) => set({ collabParticipants: ps }),
    }),
    { name: 'localforge-settings-v1' }
  )
);
