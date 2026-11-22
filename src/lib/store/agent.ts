// Agent store: conversation state, tool execution log, pending approvals.
import { create } from 'zustand';
import type { AgentMessage, ToolLogEntry, CompletionResult } from '@/lib/agent/types';
import type { TaskContract } from '@/lib/agent/task-contract';

export interface ToolMeta {
  tool: string;
  status: 'running' | 'pending' | 'ok' | 'error' | 'denied';
  output?: string;
  durMs?: number;
  summary?: string;
  argsPreview?: string;
  // Milestone 1: structured write/edit results (UI display only)
  diff?: string;
  diffPath?: string;
  changedFile?: string;
  workspaceRevision?: string;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  streaming?: boolean;
  toolCallId?: string;
  toolMeta?: ToolMeta;
  stage?: string;
  ts: number;
}

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  danger: string;
  summary: string;
  resolve: (d: 'allow' | 'allow-always' | 'deny') => void;
}

interface AgentState {
  messages: ChatMessageView[];
  toolLog: ToolLogEntry[];
  pendingApproval: PendingApproval | null;
  running: boolean;
  currentStage: string | null;
  lastError: string | null;
  usageTotals: { promptTokens: number; completionTokens: number };
  // resumable sessions: when a run stops at its turn limit (or is paused),
  // the full internal message history is kept here so "Continue task" can
  // resume with complete context instead of losing progress.
  lastSession: { note?: string; turns: number; at: number } | null;
  // Forge upgrade — Problem C: the coordinator-owned contract of the active
  // task, mirrored into the store for the UI (contract card, steering list).
  contract: TaskContract | null;
  // Forge upgrade — Problem D: the coordinator's completion verdict of the
  // last finished run (NOT the model's claim).
  lastCompletion: (CompletionResult & { canOverride?: boolean }) | null;
  // Forge upgrade — Part 5: control bus so the Live Runs view can steer /
  // stop / continue the active run (registered by IdeView while a run lives).
  controls: { steer?: (t: string) => boolean; stop?: () => void; continue?: () => void } | null;
  setControls: (c: { steer?: (t: string) => boolean; stop?: () => void; continue?: () => void } | null) => void;

  resetSession: () => void;
  addMessage: (m: Omit<ChatMessageView, 'id' | 'ts'>) => string;
  appendToMessage: (id: string, chunk: string) => void;
  finalizeMessage: (id: string, content?: string) => void;
  setStage: (stage: string | null) => void;
  setRunning: (r: boolean) => void;
  pushToolLog: (entry: ToolLogEntry) => void;
  upsertToolLog: (entry: ToolLogEntry) => void;
  setPendingApproval: (p: PendingApproval | null) => void;
  setLastError: (e: string | null) => void;
  addUsage: (u: { promptTokens: number | null; completionTokens: number | null }) => void;
  setLastSession: (s: { note?: string; turns: number } | null) => void;
  setContract: (c: TaskContract | null) => void;
  setLastCompletion: (c: (CompletionResult & { canOverride?: boolean }) | null) => void;
}

let mid = 0;
const genId = () => `m_${Date.now()}_${++mid}`;

export const useAgent = create<AgentState>()((set) => ({
  messages: [],
  toolLog: [],
  pendingApproval: null,
  running: false,
  currentStage: null,
  lastError: null,
  usageTotals: { promptTokens: 0, completionTokens: 0 },
  lastSession: null,
  contract: null,
  lastCompletion: null,

  resetSession: () => set({ messages: [], toolLog: [], pendingApproval: null, running: false, currentStage: null, lastError: null, lastSession: null, lastCompletion: null }),
  addMessage: (m) => {
    const id = genId();
    set((s) => ({ messages: [...s.messages, { ...m, id, ts: Date.now() }] }));
    return id;
  },
  appendToMessage: (id, chunk) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)) })),
  finalizeMessage: (id, content) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false, content: content ?? m.content } : m)) })),
  setStage: (stage) => set({ currentStage: stage }),
  setRunning: (r) => set({ running: r }),
  pushToolLog: (entry) => set((s) => ({ toolLog: [...s.toolLog, entry] })),
  upsertToolLog: (entry) =>
    set((s) => {
      const idx = s.toolLog.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        const copy = [...s.toolLog];
        copy[idx] = entry;
        return { toolLog: copy };
      }
      return { toolLog: [...s.toolLog, entry] };
    }),
  setPendingApproval: (p) => set({ pendingApproval: p }),
  setLastError: (e) => set({ lastError: e }),
  addUsage: (u) =>
    set((s) => ({
      usageTotals: {
        promptTokens: s.usageTotals.promptTokens + (u.promptTokens ?? 0),
        completionTokens: s.usageTotals.completionTokens + (u.completionTokens ?? 0),
      },
    })),
  setLastSession: (s) => set({ lastSession: s ? { ...s, at: Date.now() } : null }),
  setContract: (c) => set({ contract: c }),
  setLastCompletion: (c) => set({ lastCompletion: c }),
  controls: null,
  setControls: (c) => set({ controls: c }),
}));
