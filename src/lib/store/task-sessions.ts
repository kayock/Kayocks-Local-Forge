// RC3 — Durable task sessions (Cline-style persistent tasks).
//
// Every agent run becomes a session with its objective, contract state,
// message history (capped), files changed, evidence and checkpoints. The
// store persists to localStorage so tasks survive browser refreshes; resume
// feeds the recorded history back into continueAgent's handoff path.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TaskSession {
  id: string;
  workspaceId: string;
  objective: string;
  status: 'active' | 'paused' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  contract?: { status: string; statusNote?: string; requirements?: { text: string; met: boolean }[] } | null;
  messages: { role: string; content: string; at: number }[];
  filesChanged: string[];
  evidence: string[];
  modelsUsed: string[];
  turns: number;
  checkpoints: { id: string; hash: string; label: string; at: number }[];
}

interface TaskSessionState {
  sessions: TaskSession[];
  createSession: (wsId: string, objective: string) => TaskSession;
  updateSession: (id: string, patch: Partial<TaskSession>) => void;
  appendMessage: (id: string, role: string, content: string) => void;
  addCheckpoint: (id: string, cp: { id: string; hash: string; label: string; at: number }) => void;
  searchSessions: (wsId: string | null, query: string) => TaskSession[];
  clearSessions: () => void;
}

const MAX_MESSAGES = 200;
const MAX_SESSIONS = 60;

export const useTaskSessions = create<TaskSessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      createSession: (wsId, objective) => {
        const s: TaskSession = {
          id: `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          workspaceId: wsId, objective, status: 'active',
          createdAt: Date.now(), updatedAt: Date.now(),
          contract: null, messages: [], filesChanged: [], evidence: [], modelsUsed: [], turns: 0, checkpoints: [],
        };
        set({ sessions: [s, ...get().sessions].slice(0, MAX_SESSIONS) });
        return s;
      },
      updateSession: (id, patch) => set({
        sessions: get().sessions.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
      }),
      appendMessage: (id, role, content) => set({
        sessions: get().sessions.map((s) => (s.id === id
          ? { ...s, updatedAt: Date.now(), turns: s.turns + 1, messages: [...s.messages, { role, content: String(content).slice(0, 4000), at: Date.now() }].slice(-MAX_MESSAGES) }
          : s)),
      }),
      addCheckpoint: (id, cp) => set({
        sessions: get().sessions.map((s) => (s.id === id ? { ...s, updatedAt: Date.now(), checkpoints: [...s.checkpoints, cp].slice(-30) } : s)),
      }),
      searchSessions: (wsId, query) => {
        const q = query.trim().toLowerCase();
        return get().sessions
          .filter((s) => (wsId ? s.workspaceId === wsId : true))
          .filter((s) => (q ? s.objective.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q)) : true))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      },
      clearSessions: () => set({ sessions: [] }),
    }),
    { name: 'localforge-task-sessions-v1' },
  ),
);
