// Workspace store: project metadata, file tree, open tabs, terminal cwd.
// Project metadata lives in localStorage and optionally syncs to the hosted
// backend (metadata only — never file contents).
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProjectMeta } from '@/lib/types';

export interface OpenTab {
  path: string;
  content: string;      // last loaded/saved content
  draft: string;        // current editor content
  language?: string;
  loadedAt: number;
}

export interface TreeNode {
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

interface WorkspaceState {
  projects: ProjectMeta[];
  activeProjectId: string | null;
  workspaceId: string | null;
  workspacePath: string;
  tree: TreeNode[];
  tabs: OpenTab[];
  activeTab: string | null;
  terminalCwd: string;
  previewDir: string;
  treeDirty: boolean;

  upsertProject: (p: ProjectMeta) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  setWorkspace: (id: string | null, path: string) => void;
  setTree: (nodes: TreeNode[]) => void;
  markTreeDirty: () => void;
  openTab: (tab: OpenTab) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string | null) => void;
  updateTabDraft: (path: string, draft: string) => void;
  updateTabContent: (path: string, content: string) => void;
  setTerminalCwd: (cwd: string) => void;
  setPreviewDir: (dir: string) => void;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      projects: [],
      activeProjectId: null,
      workspaceId: null,
      workspacePath: '',
      tree: [],
      tabs: [],
      activeTab: null,
      terminalCwd: '.',
      previewDir: '.',
      treeDirty: false,

      upsertProject: (p) =>
        set((s) => {
          const existing = s.projects.find((x) => x.id === p.id);
          return {
            projects: existing
              ? s.projects.map((x) => (x.id === p.id ? { ...x, ...p } : x))
              : [...s.projects, p],
            activeProjectId: p.id,
          };
        }),
      removeProject: (id) =>
        set((s) => ({
          projects: s.projects.filter((x) => x.id !== id),
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
          workspaceId: s.activeProjectId === id ? null : s.workspaceId,
          tabs: s.activeProjectId === id ? [] : s.tabs,
          activeTab: s.activeProjectId === id ? null : s.activeTab,
        })),
      setActiveProject: (id) => set({ activeProjectId: id }),
      setWorkspace: (id, path) => set({ workspaceId: id, workspacePath: path, tree: [], tabs: [], activeTab: null }),
      setTree: (nodes) => set({ tree: nodes, treeDirty: false }),
      markTreeDirty: () => set({ treeDirty: true }),
      openTab: (tab) =>
        set((s) => {
          const exists = s.tabs.find((t) => t.path === tab.path);
          return {
            tabs: exists ? s.tabs.map((t) => (t.path === tab.path ? tab : t)) : [...s.tabs, tab],
            activeTab: tab.path,
          };
        }),
      closeTab: (path) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.path !== path);
          const activeTab = s.activeTab === path ? tabs[tabs.length - 1]?.path ?? null : s.activeTab;
          return { tabs, activeTab };
        }),
      setActiveTab: (path) => set({ activeTab: path }),
      updateTabDraft: (path, draft) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, draft } : t)) })),
      updateTabContent: (path, content) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, draft: content } : t)) })),
      setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
      setPreviewDir: (dir) => set({ previewDir: dir }),
    }),
    { name: 'localforge-workspace-v1' }
  )
);
