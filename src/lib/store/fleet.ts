// Fleet Map store (Forge upgrade — Part 4): the LocalForge machine network —
// Station, Portable, Windows Dell and any additional paired machines. States
// are distinguished honestly: unreachable → discovered → paired →
// inference-ready. Refresh is on-demand / event-driven; no polling loops, no
// continuous animation (older hardware).
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type MachineState = 'unreachable' | 'discovered' | 'paired' | 'inference-ready';

export interface FleetMachine {
  id: string;
  label: string;                  // "Station", "Portable", "Windows Dell", …
  role: string;                   // user-maintained description
  // connection
  url: string;                    // companion base URL (direct/remote)
  hasToken: boolean;
  state: MachineState;
  lastCheckedAt?: number;
  error?: string;
  // companion facts (from /health)
  companionVersion?: string;
  platform?: string;
  hostname?: string;
  workspaces?: { id: string; name: string; path: string }[];
  resources?: { cpus: number; load1: number; memTotal: number; memFree: number; uptimeSec: number };
  // inference
  modelCount?: number;            // discovered providers/models (from last probe)
  // live activity (filled from the runs store by the UI)
  activeRunId?: string | null;
  activeTask?: string;
}

interface FleetState {
  machines: FleetMachine[];
  addMachine: (m: Pick<FleetMachine, 'label' | 'url' | 'role'> & Partial<FleetMachine>) => FleetMachine;
  updateMachine: (id: string, patch: Partial<FleetMachine>) => void;
  removeMachine: (id: string) => void;
  setState: (id: string, state: MachineState, extra?: Partial<FleetMachine>) => void;
}

const genId = () => `fm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const useFleet = create<FleetState>()(
  persist(
    (set) => ({
      machines: [],
      addMachine: (m) => {
        const machine: FleetMachine = {
          id: genId(),
          label: m.label,
          role: m.role ?? '',
          url: m.url,
          hasToken: m.hasToken ?? false,
          state: m.state ?? 'discovered',
        };
        set((s) => ({ machines: [...s.machines, machine] }));
        return machine;
      },
      updateMachine: (id, patch) =>
        set((s) => ({ machines: s.machines.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
      removeMachine: (id) => set((s) => ({ machines: s.machines.filter((m) => m.id !== id) })),
      setState: (id, state, extra) =>
        set((s) => ({ machines: s.machines.map((m) => (m.id === id ? { ...m, state, lastCheckedAt: Date.now(), ...extra } : m)) })),
    }),
    { name: 'localforge-fleet-v1' }
  )
);
