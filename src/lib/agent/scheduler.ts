// Resource-aware agent/model scheduler (Phase 2.0 spec §8).
//
// Pure, deterministic scoring over REAL inventory data (hardware + model
// profiles reported by companions). Heuristics are explicit and inspectable —
// the user can always override any decision manually (spec §8 "User control").
//
// Scoring inputs per candidate (machine × model profile):
//  - RAM fit: estimated model RAM demand vs available RAM (hard filter)
//  - GPU fit: VRAM estimate vs model size when a GPU is present (bonus)
//  - residency: already-loaded models get a strong bonus (avoid reload cost)
//  - backend support: llamacpp/ollama managed or attached endpoints only
//  - role affinity: small, fast models for routine roles (tester/reviewer);
//    larger models for planning/coding — driven by profile name/notes hints
//    and model size, never by hardcoded GGUF names (spec §6)
//  - occupancy: machines already running a managed server on the target port
//    are avoided for NEW loads (port conflicts are reported, not guessed)
//  - NPU: only a tie-breaker signal; never assumed to run GGUF models

export interface SchedulerMachine {
  id: string;                 // mesh peer id or 'local'
  name: string;
  hardware: {
    cpuCores: number;
    ramAvailableBytes: number | null;
    ramTotalBytes: number | null;
    gpus: { kind: string | null; name: string | null; vramBytes: number | null }[];
    npu: { detected: boolean };
  } | null;                   // null when the machine is unreachable
  reachable: boolean;
  loadedModels: string[];     // profile names with a ready server on that machine
  busyPorts: number[];
}

export interface SchedulerCandidate {
  machine: SchedulerMachine;
  profile: {
    id: string;
    name: string;
    backend: string;
    residency?: string;
    modelPath?: string | null;
    modelId?: string | null;
    endpoint?: string | null;
    port?: number | null;
    notes?: string | null;
  };
  modelSizeBytes: number | null; // from GGUF scan / ollama size when known
  alreadyLoaded: boolean;
  // set by rankCandidates: this model's size / largest available size (0..1)
  relativeSize?: number;
}

export interface ScoredCandidate {
  candidate: SchedulerCandidate;
  score: number;
  reasons: string[];
  hardBlocked?: string;
}

export type AgentRole = 'planner' | 'coder' | 'tester' | 'reviewer' | 'debugger' | 'researcher' | 'custom';

// Rough per-role preference for model heft (fraction of the LARGEST available
// model on the mesh). Small capable models handle routine roles (spec §8).
const ROLE_PREFERENCE: Record<AgentRole, number> = {
  planner: 1.0,
  coder: 1.0,
  debugger: 0.9,
  researcher: 0.7,
  reviewer: 0.6,
  tester: 0.5,
  custom: 0.8,
};

export function scoreCandidate(c: SchedulerCandidate, role: AgentRole): ScoredCandidate {
  const reasons: string[] = [];
  let score = 50;

  if (!c.machine.reachable || !c.machine.hardware) {
    return { candidate: c, score: -1000, reasons: ['machine unreachable'], hardBlocked: 'unreachable' };
  }
  const hw = c.machine.hardware;

  // RAM fit (hard): estimate = model file size * 1.2 (context not included)
  if (c.modelSizeBytes != null && hw.ramAvailableBytes != null) {
    const demand = Math.round(c.modelSizeBytes * 1.2);
    if (demand > hw.ramAvailableBytes) {
      return {
        candidate: c,
        score: -900,
        reasons: [`model needs ~${fmtBytes(demand)} RAM but only ${fmtBytes(hw.ramAvailableBytes)} is available`],
        hardBlocked: 'ram',
      };
    }
    const ratio = demand / hw.ramAvailableBytes;
    if (ratio < 0.4) { score += 12; reasons.push(`model fits comfortably (~${fmtBytes(demand)} of ${fmtBytes(hw.ramAvailableBytes)} free)`); }
    else if (ratio < 0.75) { score += 6; reasons.push(`model fits with headroom (~${Math.round(ratio * 100)}% of free RAM)`); }
    else { score += 1; reasons.push(`model fits but is tight (~${Math.round(ratio * 100)}% of free RAM)`); }

    // GPU bonus: whole-model offload plausible when VRAM covers the weights
    const gpu = hw.gpus.find((g) => g.vramBytes != null && g.vramBytes > 0);
    if (gpu && gpu.vramBytes! >= c.modelSizeBytes) {
      score += 14;
      reasons.push(`GPU ${gpu.name} has ${fmtBytes(gpu.vramBytes!)} VRAM ≥ model size (full offload plausible)`);
    } else if (gpu) {
      score += 4;
      reasons.push(`GPU present (${gpu.name}); partial offload only (VRAM ${fmtBytes(gpu.vramBytes ?? 0)})`);
    }
  } else if (c.modelSizeBytes == null) {
    score -= 3;
    reasons.push('model size unknown — fit cannot be verified');
  }

  // residency: loaded beats reload (spec §8 "Prefer existing loaded models")
  if (c.alreadyLoaded) {
    score += 25;
    reasons.push('model is already loaded on this machine (no load time)');
  } else if (c.profile.residency === 'on-demand') {
    score += 3;
    reasons.push('on-demand residency policy');
  } else if (c.profile.residency === 'keep-loaded') {
    score += 5;
    reasons.push('user configured keep-loaded residency');
  }

  // occupancy: avoid ports already busy on that machine for NEW loads
  if (!c.alreadyLoaded && c.profile.port != null && c.machine.busyPorts.includes(c.profile.port)) {
    score -= 40;
    reasons.push(`port ${c.profile.port} is already occupied on this machine`);
  }

  // role affinity: relative size preference (no hardcoded model names)
  if (c.modelSizeBytes != null) {
    const pref = ROLE_PREFERENCE[role] ?? 0.8;
    // compare against the largest known candidate size supplied by the caller
    const rel = c.relativeSize ?? 1; // 0..1 (this model's size / largest available)
    const diff = Math.abs(rel - pref);
    score -= Math.round(diff * 14);
    reasons.push(diff < 0.15
      ? `model size matches the ${role} role preference`
      : `model size ${rel < pref ? 'smaller' : 'larger'} than typical for ${role}`);
  }

  // NPU tie-breaker only (never a GGUF claim)
  if (hw.npu.detected) { score += 1; reasons.push('Intel NPU detected (informational — GGUF models are not assumed NPU-capable)'); }

  return { candidate: c, score, reasons };
}

export interface ScoreContext {
  largestModelBytes: number | null;
}

export function rankCandidates(
  candidates: SchedulerCandidate[],
  role: AgentRole,
  ctx: { largestModelBytes: number | null },
): ScoredCandidate[] {
  const ranked = candidates.map((c) => scoreCandidate({ ...c, relativeSize: c.modelSizeBytes != null && ctx.largestModelBytes ? c.modelSizeBytes / ctx.largestModelBytes : undefined }, role));
  return ranked.sort((a, b) => b.score - a.score);
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${n} B`;
}
