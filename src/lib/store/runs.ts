// Live Runs store (Forge upgrade — Part 5): the actual sequence of
// operations from each agent run — tool calls, notices, errors, recoveries,
// steering, gates, handoffs — persisted across app restarts where practical
// (localStorage, bounded). This is execution truth, not a generated summary.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RunOpKind = 'task' | 'stage' | 'tool' | 'notice' | 'error' | 'steering' | 'recovery' | 'gate' | 'handoff' | 'approval' | 'final';

export interface RunOp {
  id: string;
  ts: number;
  kind: RunOpKind;
  tool?: string;
  summary: string;
  status?: 'ok' | 'error' | 'denied' | 'running' | 'blocked';
  detail?: string;         // output / error text (truncated)
  durMs?: number;
  machine?: string;
  exitCode?: number | null;
}

export interface LiveRun {
  id: string;
  projectId: string | null;
  projectName?: string;
  startedAt: number;
  endedAt?: number;
  model: string;
  providerLabel?: string;
  mode: 'chat' | 'task' | 'pipeline';
  task: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  completion?: { status: string; missing: string[]; reasons: string[] };
  ops: RunOp[];
}

interface RunsState {
  runs: LiveRun[];
  startRun: (r: { projectId: string | null; projectName?: string; model: string; providerLabel?: string; mode: 'chat' | 'task' | 'pipeline'; task: string }) => string;
  endRun: (id: string, status: LiveRun['status'], completion?: LiveRun['completion']) => void;
  addOp: (runId: string, op: Omit<RunOp, 'id' | 'ts'> & { id?: string; ts?: number }) => void;
  updateOp: (runId: string, opId: string, patch: Partial<RunOp>) => void;
  clearRuns: () => void;
}

let opSeq = 0;
const genId = () => `op_${Date.now().toString(36)}_${++opSeq}`;
const MAX_RUNS = 40;
const MAX_OPS = 600;

export const useRuns = create<RunsState>()(
  persist(
    (set) => ({
      runs: [],
      startRun: (r) => {
        const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({
          runs: [
            { id, projectId: r.projectId, projectName: r.projectName, startedAt: Date.now(), model: r.model, providerLabel: r.providerLabel, mode: r.mode, task: r.task, status: 'running' as const, ops: [] },
            ...s.runs,
          ].slice(0, MAX_RUNS),
        }));
        return id;
      },
      endRun: (id, status, completion) =>
        set((s) => ({
          runs: s.runs.map((r) => (r.id === id ? { ...r, status, endedAt: Date.now(), completion: completion ?? r.completion } : r)),
        })),
      addOp: (runId, op) =>
        set((s) => ({
          runs: s.runs.map((r) => {
            if (r.id !== runId) return r;
            const entry: RunOp = { id: op.id ?? genId(), ts: op.ts ?? Date.now(), kind: op.kind, tool: op.tool, summary: op.summary, status: op.status, detail: op.detail, durMs: op.durMs, machine: op.machine, exitCode: op.exitCode };
            const ops = [...r.ops, entry].slice(-MAX_OPS);
            return { ...r, ops };
          }),
        })),
      updateOp: (runId, opId, patch) =>
        set((s) => ({
          runs: s.runs.map((r) => (r.id === runId ? { ...r, ops: r.ops.map((o) => (o.id === opId ? { ...o, ...patch } : o)) } : r)),
        })),
      clearRuns: () => set({ runs: [] }),
    }),
    { name: 'localforge-runs-v1' }
  )
);
