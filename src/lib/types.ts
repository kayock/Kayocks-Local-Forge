// Shared types for LocalForge IDE.

export type ProviderKind = 'ollama' | 'openai';

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  label?: string;
  // 0.4.4: how long ONE inference may take before the IDE gives up on it.
  // Seconds; prompt processing on slow hardware can legitimately take many
  // minutes. Companion default is 20 min when unset.
  chatTimeoutSec?: number;
}

export interface ModelInfo {
  id: string;
  display?: string;
  sizeBytes?: number | null;
  paramSize?: string | null;
  quant?: string | null;
  family?: string | null;
}

export interface InferenceParams {
  temperature: number;
  topP: number;
  maxTokens: number;
  numCtx: number;
  // 0.4.4: true only when the USER changed the value. Untouched defaults must
  // NOT override the model server's own configured context/generation budget.
  maxTokensExplicit?: boolean;
  numCtxExplicit?: boolean;
  // Per request, and only for a provider that understands it. 'auto' is not
  // sent: the companion omits the field. Undefined preserves older settings.
  think?: 'auto' | 'enabled' | 'disabled';
}

export const DEFAULT_INFERENCE: InferenceParams = {
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 2048,
  numCtx: 8192,
};

// Marks inference values the user actually changed (differ from the shipped
// defaults) as explicit, so the companion only forwards those to the model
// server. A value the user never touched is left to the server's own config.
export function resolveInferenceParams(inference: InferenceParams): InferenceParams {
  return {
    ...inference,
    maxTokensExplicit: inference.maxTokensExplicit ?? inference.maxTokens !== DEFAULT_INFERENCE.maxTokens,
    numCtxExplicit: inference.numCtxExplicit ?? inference.numCtx !== DEFAULT_INFERENCE.numCtx,
  };
}

export interface DiscoveredProvider {
  kind: ProviderKind | null;
  baseUrl: string;
  name: string | null;
  reachable: boolean;
  models: ModelInfo[];
  // 0.4.4 discovery: honest auth state for reachable-but-locked servers.
  authRequired?: boolean;
  authOk?: boolean;
  authSource?: 'companion-lemond-env' | 'user-provided' | 'companion-key-rejected' | 'user-key-rejected' | 'no-credentials';
  status?: number;
  error?: string;
}

// Reachability class shown on provider cards (merge/discovery layer derives
// it from the HTTP status + auth state the companion reports).
export type ProviderStatus = 'ok' | 'unreachable' | 'auth_required';

export interface ToolCallDraft {
  id: string;
  name: string;  args: Record<string, unknown> | string | null;
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

export interface UnifiedStreamChunk {
  t: 'text' | 'thinking' | 'tool_call' | 'end' | 'error';
  v?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown> | string | null;
  finish?: string;
  toolCalls?: ToolCallDraft[];
  usage?: { promptTokens: number | null; completionTokens: number | null };
  message?: string;
}

// ---- execution policy ----
export type PolicyMode = 'auto' | 'confirm-commands' | 'confirm-all';

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  danger: 'safe' | 'command' | 'destructive';
  summary: string;
}

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny';

// ---- project metadata ----
export interface ProjectMeta {
  id: string; // local UUID; hosted id separately if synced
  hostedId?: string | null;
  name: string;
  path: string; // absolute path on the customer machine
  workspaceId?: string | null; // companion workspace id
  companionLabel?: string | null;
  createdAt: string;
  lastOpenedAt: string;
}
