import type { InferenceParams } from '@/lib/types';

export type ThinkingMode = 'auto' | 'enabled' | 'disabled';

// Automatic omits the provider parameter. Enabled and disabled are explicit
// and belong to one participant, not to the whole collaboration.
export function paramsWithThinking(
  base: Partial<InferenceParams> | undefined,
  mode: ThinkingMode | undefined,
): Partial<InferenceParams> {
  const params: Partial<InferenceParams> = { ...(base || {}) };
  if (mode === 'enabled' || mode === 'disabled') params.think = mode;
  else delete params.think;
  return params;
}
