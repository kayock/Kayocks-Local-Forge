import { describe, expect, test } from 'bun:test';
import {
  allowAutomatic,
  assertFleetParticipants,
  defaultParticipation,
  isExcludedWindowsLlama,
  isPlaceholderEndpoint,
  resolveParticipation,
} from '@/lib/fleet/participation';

describe('fleet participation defaults', () => {
  test('Station is the controller, Portable is enabled, Windows is manual', () => {
    expect(defaultParticipation({ machineId: 'local', name: 'eric-UbuntuStation' })).toBe('controller');
    expect(defaultParticipation({ machineId: 'p1', name: 'Portable', platform: 'linux' })).toBe('enabled');
    expect(defaultParticipation({ machineId: 'w1', name: 'Windows', platform: 'win32' })).toBe('manual');
    expect(defaultParticipation({ machineId: 'other', name: 'Lab', platform: 'linux' })).toBe('manual');
  });

  test('a saved override wins, and Windows stays manual without one', () => {
    expect(resolveParticipation({ machineId: 'w1', name: 'Windows', platform: 'win32' }, { w1: 'enabled' })).toBe('enabled');
    expect(resolveParticipation({ machineId: 'w1', name: 'Windows', platform: 'win32' }, {})).toBe('manual');
  });

  test('manual machines are not automatic retry targets even when explicitly included', () => {
    expect(allowAutomatic('enabled')).toBe(true);
    expect(allowAutomatic('manual', true)).toBe(false);
    expect(allowAutomatic('controller', true)).toBe(false);
  });

  test('Windows loopback :8080 is excluded; other endpoints are not', () => {
    expect(isExcludedWindowsLlama('http://127.0.0.1:8080/v1', { machineId: 'w', name: 'Windows', platform: 'win32' })).toBe(true);
    expect(isExcludedWindowsLlama('http://127.0.0.1:11434', { machineId: 'p', name: 'Portable', platform: 'linux' })).toBe(false);
    expect(isExcludedWindowsLlama('http://127.0.0.1:8080/v1', { machineId: 'p', name: 'Portable', platform: 'linux' })).toBe(false);
  });

  test('the old hard-coded participant endpoint is not treated as a selection', () => {
    expect(isPlaceholderEndpoint('http://127.0.0.1:8080/v1', 'qwen3-coder-30b-a3b-instruct')).toBe(true);
    expect(isPlaceholderEndpoint('http://127.0.0.1:11434', 'llama3.2:3b')).toBe(false);
  });

  test('Windows is refused unless this run explicitly selects it, and never via :8080', () => {
    expect(() => assertFleetParticipants([
      { machineId: 'w1', name: 'Windows', platform: 'win32', baseUrl: 'http://127.0.0.1:11434', model: 'x' },
    ])).toThrow(/manual-only/);
    const allowed = assertFleetParticipants([
      { machineId: 'p1', name: 'Portable', platform: 'linux', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b' },
      { machineId: 'w1', name: 'Windows', platform: 'win32', baseUrl: 'http://127.0.0.1:11434', model: 'x', explicitRun: true },
    ]);
    expect(allowed.map((p) => p.machineId)).toEqual(['p1', 'w1']);
    expect(() => assertFleetParticipants([
      { machineId: 'w1', name: 'Windows', platform: 'win32', baseUrl: 'http://127.0.0.1:8080/v1', model: 'x', explicitRun: true },
    ])).toThrow(/excluded/);
  });

  test('Portable being the only enabled worker is accepted without Windows', () => {
    const allowed = assertFleetParticipants([
      { machineId: 'local', name: 'Station', baseUrl: 'http://127.0.0.1:11434', model: 'm' },
      { machineId: 'p1', name: 'Portable', platform: 'linux', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b' },
    ].filter((p) => p.machineId !== 'local'));
    expect(allowed).toHaveLength(1);
    expect(allowed[0].participation).toBe('enabled');
  });
});
