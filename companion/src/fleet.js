// Saved fleet participation overrides. Absent entries keep the IDE defaults
// (Station controller, Portable enabled, Windows manual). Discovery never
// writes this file.
import { getState, saveState } from './config.js';

const MODES = new Set(['controller', 'enabled', 'manual']);

export function getFleetParticipation() {
  const saved = getState().fleetParticipation;
  return { participation: saved && typeof saved === 'object' ? saved : {} };
}

export function setFleetParticipation(machineId, mode) {
  if (typeof machineId !== 'string' || !/^[\w.:-]{1,128}$/.test(machineId)) {
    const e = new Error('Invalid machine id');
    e.status = 400;
    throw e;
  }
  if (!MODES.has(mode)) {
    const e = new Error('Participation must be controller, enabled, or manual');
    e.status = 400;
    throw e;
  }
  const s = getState();
  if (!s.fleetParticipation || typeof s.fleetParticipation !== 'object') s.fleetParticipation = {};
  s.fleetParticipation[machineId] = mode;
  saveState();
  return { participation: s.fleetParticipation };
}
