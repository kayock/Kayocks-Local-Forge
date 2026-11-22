// Projects Hub store (Forge upgrade — Part 3): Forge projects — a level
// above the companion's workspace registry. A project binds a workspace
// (host + directory), its participating agents/models, the persistent task
// contract, run history and status. Projects reference workspaces; source
// files are never duplicated.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TaskContract } from '@/lib/agent/task-contract';

export interface ForgeProject {
  id: string;
  name: string;
  description: string;
  // workspace binding
  workspaceId: string | null;
  workspacePath: string;
  hostLabel: string;         // "This computer" | "Station" | "Portable" | "Windows Dell" | custom
  // participation
  model: string;             // primary model id
  stageModels: Partial<Record<'planner' | 'coder' | 'tester' | 'reviewer', string>>;
  // state
  status: 'NEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED';
  contract: TaskContract | null;
  runIds: string[];
  artifacts: { name: string; kind: 'file' | 'screenshot' | 'test'; detail: string; at: number }[];
  lastSummary?: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
}

interface ProjectsState {
  projects: ForgeProject[];
  activeForgeProjectId: string | null;
  createProject: (p: Pick<ForgeProject, 'name' | 'description' | 'workspacePath' | 'hostLabel'> & Partial<ForgeProject>) => ForgeProject;
  updateProject: (id: string, patch: Partial<ForgeProject>) => void;
  setActiveProject: (id: string | null) => void;
  removeProject: (id: string) => void;
  attachRun: (id: string, runId: string) => void;
  addArtifact: (id: string, a: ForgeProject['artifacts'][number]) => void;
  saveContract: (id: string, contract: TaskContract) => void;
  touch: (id: string) => void;
}

const genId = () => `fp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const useProjects = create<ProjectsState>()(
  persist(
    (set) => ({
      projects: [],
      activeForgeProjectId: null,
      createProject: (p) => {
        const proj: ForgeProject = {
          id: genId(),
          name: p.name,
          description: p.description ?? '',
          workspaceId: p.workspaceId ?? null,
          workspacePath: p.workspacePath ?? '',
          hostLabel: p.hostLabel ?? 'This computer',
          model: p.model ?? '',
          stageModels: p.stageModels ?? {},
          status: p.status ?? 'NEW',
          contract: p.contract ?? null,
          runIds: [],
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          openedAt: Date.now(),
        };
        set((s) => ({ projects: [...s.projects, proj], activeForgeProjectId: proj.id }));
        return proj;
      },
      updateProject: (id, patch) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)),
        })),
      setActiveProject: (id) => set({ activeForgeProjectId: id }),
      removeProject: (id) =>
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          activeForgeProjectId: s.activeForgeProjectId === id ? null : s.activeForgeProjectId,
        })),
      attachRun: (id, runId) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, runIds: [...p.runIds.slice(-19), runId], updatedAt: Date.now() } : p)),
        })),
      addArtifact: (id, a) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, artifacts: [...p.artifacts.slice(-29), a], updatedAt: Date.now() } : p)),
        })),
      saveContract: (id, contract) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, contract: { ...contract }, status: contract.status === 'ACTIVE' ? p.status === 'NEW' ? 'ACTIVE' : p.status : (contract.status as ForgeProject['status']), updatedAt: Date.now() } : p)),
        })),
      touch: (id) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, openedAt: Date.now() } : p)) })),
    }),
    { name: 'localforge-forge-projects-v1' }
  )
);
