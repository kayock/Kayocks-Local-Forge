import { describe, expect, test } from 'bun:test';
import { paramsWithThinking } from '@/lib/agent/thinking';

describe('per-participant thinking controls', () => {
  test('disabled and enabled are explicit, automatic omits the parameter', () => {
    expect(paramsWithThinking({ temperature: 0.2 }, 'disabled').think).toBe('disabled');
    expect(paramsWithThinking({ temperature: 0.2 }, 'enabled').think).toBe('enabled');
    expect(paramsWithThinking({ temperature: 0.2, think: 'enabled' }, 'auto').think).toBeUndefined();
    expect(paramsWithThinking({ temperature: 0.2, think: 'enabled' }, undefined).think).toBeUndefined();
  });

  test('two participants keep different selections', () => {
    const coder = paramsWithThinking({ temperature: 0.2 }, 'disabled');
    const reviewer = paramsWithThinking({ temperature: 0.2 }, undefined);
    expect(coder.think).toBe('disabled');
    expect(reviewer.think).toBeUndefined();
    expect(coder.temperature).toBe(0.2);
  });

  test('selecting a thinking mode does not set a context cap', () => {
    const params = paramsWithThinking({ temperature: 0.7 }, 'disabled');
    expect(params.numCtx).toBeUndefined();
    expect(params.numCtxExplicit).toBeUndefined();
  });
});
