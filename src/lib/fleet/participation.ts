// Fleet participation. Discovery and a mesh connection do not grant the
// right to run work. Scheduling reads these modes; the Control Center is
// only the editor.
//
//   controller — orchestrates. Not an automatic worker.
//   enabled    — preferred worker. Eligible for assignment and retry.
//   manual     — visible and connected. Runs only when this run explicitly
//                selects it, and never receives another machine's retry.

export type ParticipationMode = 'controller' | 'enabled' | 'manual';

export interface FleetIdentity {
  machineId: string;
  name?: string;
  machineName?: string;
  platform?: string;
}

function identityName(machine: FleetIdentity): string {
  return machine.name || machine.machineName || '';
}

export interface FleetParticipant extends FleetIdentity {
  baseUrl?: string;
  explicitRun?: boolean;
  participation?: ParticipationMode;
}

const WINDOWS_LLAMA_PORT = '8080';

export function defaultParticipation(machine: FleetIdentity): ParticipationMode {
  if (machine.machineId === 'local') return 'controller';
  const name = identityName(machine).toLowerCase();
  const platform = (machine.platform || '').toLowerCase();
  if (platform === 'win32' || name.includes('windows')) return 'manual';
  if (name.includes('portable')) return 'enabled';
  // Any other discovered computer stays manual until the user enables it.
  return 'manual';
}

export function resolveParticipation(machine: FleetParticipant, overrides?: Record<string, ParticipationMode>): ParticipationMode {
  const saved = overrides?.[machine.machineId];
  if (saved === 'controller' || saved === 'enabled' || saved === 'manual') return saved;
  if (machine.participation) return machine.participation;
  return defaultParticipation(machine);
}

export function isExcludedWindowsLlama(baseUrl: string, machine: FleetIdentity): boolean {
  const win = (machine.platform || '').toLowerCase() === 'win32' || /windows/i.test(identityName(machine));
  if (!win) return false;
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return loopback && port === WINDOWS_LLAMA_PORT;
  } catch {
    return /127\.0\.0\.1:8080|localhost:8080/i.test(baseUrl);
  }
}

/** The old Collaborate default. It is not a user-selected endpoint. */
export function isPlaceholderEndpoint(baseUrl?: string, model?: string): boolean {
  const url = (baseUrl || '').replace(/\/+$/, '');
  const m = model || '';
  return url === 'http://127.0.0.1:8080/v1' && (m === '' || m === 'qwen3-coder-30b-a3b-instruct');
}

export function allowAutomatic(mode: ParticipationMode, _explicitRun?: boolean): boolean {
  // Explicit inclusion of a manual machine assigns that machine's own tasks.
  // It does not make the machine a retry target for someone else's failure.
  return mode === 'enabled';
}

export function assertFleetParticipants<T extends FleetParticipant>(participants: T[], overrides?: Record<string, ParticipationMode>): T[] {
  const problems: string[] = [];
  const allowed: T[] = [];
  for (const p of participants) {
    const mode = resolveParticipation(p, overrides);
    const label = identityName(p) || p.machineId;
    if (isPlaceholderEndpoint(p.baseUrl, (p as { model?: string }).model)) {
      problems.push(`${label}: choose an inference endpoint discovered on that machine`);
      continue;
    }
    if (!p.baseUrl?.trim()) {
      problems.push(`${label}: select an inference endpoint before starting`);
      continue;
    }
    if (isExcludedWindowsLlama(p.baseUrl, p)) {
      problems.push(`${label}: 127.0.0.1:8080 is excluded from LocalForge routing`);
      continue;
    }
    if (mode === 'enabled' || p.explicitRun) allowed.push({ ...p, participation: mode });
    else problems.push(`${label} is ${mode === 'controller' ? 'the controller' : 'manual-only'} and was not explicitly selected for this run`);
  }
  if (problems.length) {
    const err = new Error(problems.join('; '));
    err.name = 'CollabConfigError';
    throw err;
  }
  if (!allowed.length) {
    const err = new Error('No worker is permitted to run this collaboration.');
    err.name = 'CollabConfigError';
    throw err;
  }
  return allowed;
}
