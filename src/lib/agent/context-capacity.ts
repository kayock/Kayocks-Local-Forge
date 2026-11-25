// Effective context for compaction. The allocated server context and an
// explicit participant limit are both real constraints. A model's training
// context is not. An unknown capacity stays unknown — it is never reported
// as 8192.

export type ContextSource = 'explicit' | 'live' | 'configured' | 'min' | 'unknown';

export interface ResolvedContext {
  tokens: number | null;
  source: ContextSource;
  verified: boolean;
  explicit: number | null;
  live: number | null;
  configured: number | null;
  reservedOutput: number;
  note: string;
}

export interface ContextCapacityInput {
  explicitTokens?: number | null;
  explicit?: boolean;
  liveTokens?: number | null;
  configuredTokens?: number | null;
  reservedOutputTokens?: number | null;
}

function positive(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveContextCapacity(input: ContextCapacityInput = {}): ResolvedContext {
  const explicit = input.explicit ? positive(input.explicitTokens) : null;
  const live = positive(input.liveTokens);
  const configured = positive(input.configuredTokens);
  const reservedOutput = positive(input.reservedOutputTokens) ?? 1200;
  const limits: { tokens: number; source: Exclude<ContextSource, 'min' | 'unknown'> }[] = [];
  if (explicit) limits.push({ tokens: explicit, source: 'explicit' });
  if (live) limits.push({ tokens: live, source: 'live' });
  else if (configured) limits.push({ tokens: configured, source: 'configured' });

  if (!limits.length) {
    return {
      tokens: null,
      source: 'unknown',
      verified: false,
      explicit,
      live,
      configured,
      reservedOutput,
      note: 'Context capacity is unknown. Compaction was not applied and 8192 was not assumed.',
    };
  }

  const tightest = limits.reduce((best, item) => (item.tokens < best.tokens ? item : best));
  const source: ContextSource = limits.length > 1 && limits.some((item) => item.tokens !== tightest.tokens)
    ? 'min'
    : tightest.source;
  const note = source === 'min'
    ? `Compaction uses ${tightest.tokens} tokens, the smaller of the explicit participant limit and the verified server context.`
    : source === 'live'
      ? `Compaction uses the verified live server context of ${tightest.tokens} tokens.`
      : source === 'explicit'
        ? `Compaction uses the explicit participant limit of ${tightest.tokens} tokens.`
        : `Compaction uses the configured server context of ${tightest.tokens} tokens. It was not confirmed from a loaded server.`;
  return {
    tokens: tightest.tokens,
    source,
    verified: limits.some((item) => item.source === 'live'),
    explicit,
    live,
    configured,
    reservedOutput,
    note,
  };
}

// llama.cpp /v1/models meta. n_ctx is the context the running server allocated.
// n_ctx_train is the model file's training context and must not be used here.
export function allocatedContextFromModelMeta(meta: { n_ctx?: unknown; n_ctx_train?: unknown } | null | undefined): {
  tokens: number | null;
  trainTokens: number | null;
} {
  return {
    tokens: positive(meta?.n_ctx as number | null),
    trainTokens: positive(meta?.n_ctx_train as number | null),
  };
}

export function compactionBudgetChars(resolved: ResolvedContext, overheadChars = 0): number | null {
  if (resolved.tokens == null) return null;
  const messageTokens = Math.max(1, resolved.tokens - resolved.reservedOutput);
  const overhead = Number.isFinite(overheadChars) && overheadChars > 0 ? overheadChars : 0;
  return Math.max(1, messageTokens * 4 - overhead);
}

export function compactToBudget(wire: any[], budgetChars: number | null): any[] {
  if (budgetChars == null) return wire;
  const size = (m: any) => (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  let total = wire.reduce((sum: number, message: any) => sum + size(message), 0);
  if (total <= budgetChars) return wire;
  const cutoff = Math.max(1, wire.length - 8);
  for (let i = 1; i < cutoff && total > budgetChars; i++) {
    const message = wire[i];
    const len = (message.content ?? '').length;
    if (typeof message.content === 'string' && /\[COORDINATOR RECOVERY|\[USER STEERING|MODEL HANDOFF|TASK CONTRACT|MANDATORY ACCEPTANCE/.test(message.content)) continue;
    if ((message.role === 'tool' || (message.role === 'user' && String(message.content ?? '').startsWith('[TOOL RESULT]'))) && len > 240) {
      total -= len - 200;
      message.content = String(message.content).slice(0, 200) + '…[earlier tool output trimmed]';
    } else if (message.role === 'assistant' && len > 500) {
      total -= len - 300;
      message.content = String(message.content).slice(0, 300) + '…[trimmed]';
    }
  }
  return wire;
}
