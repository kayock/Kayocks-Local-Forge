// Agent runtime types. Pure logic — no React, no browser APIs — so the same
// runtime runs in the browser IDE and in the Node E2E verification script.
import type { ToolCallDraft } from '@/lib/types';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallDraft[];
  toolCallId?: string;
  name?: string;
}

export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required?: boolean;
  aliases?: string[]; // accepted alternate names, normalized before execution
}

// A detached (long-running / GUI) process tracked by the companion. Starting a
// desktop application returns one of these immediately instead of waiting for
// the GUI event loop to exit.
export interface ProcInfo {
  id: string;
  pid: number | null;
  cmd: string;
  cwd: string | null;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  durMs?: number;
  spawnError?: string;
}

export interface ToolContext {
  workspaceId: string;
  assertEditable?: (path: string) => void;
  log: (entry: ToolLogEntry) => void;
  runCommand: (cmd: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; cwd: string | null; durMs: number; timedOut: boolean }>;
  // detached process management (companion /proc/* endpoints); optional so
  // older companions keep working — tools degrade with a clear message.
  procs?: {
    launch: (cmd: string, opts?: { cwd?: string }) => Promise<ProcInfo>;
    list: () => Promise<ProcInfo[]>;
    output: (id: string, sinceBytes?: number) => Promise<{ proc: ProcInfo; output: string; outputBytes: number }>;
    stop: (id: string) => Promise<ProcInfo>;
  };
  fs: {
    listDir: (path?: string) => Promise<{ path: string; type: 'dir' | 'file'; size?: number }[]>;
    readFile: (path: string) => Promise<{ content: string; size: number; modifiedAt?: string }>;
    // opts (Milestone 1): ifUnmodifiedSince implements overwrite protection —
    // the companion refuses with 409 + current content when the file changed
    // after the preview; returnDiff asks for a concise post-edit diff.
    writeFile: (path: string, content: string, opts?: { ifUnmodifiedSince?: string | null; returnDiff?: boolean }) => Promise<{ bytes: number; created?: boolean; modifiedAt?: string; diff?: string; diffAdded?: number; diffRemoved?: number; changedFile?: { path: string; size: number; mtimeMs: number } }>;
    mkdir: (path: string) => Promise<void>;
    deletePath: (path: string) => Promise<void>; // pre-approved by the time a tool runs
    rename: (from: string, to: string) => Promise<void>;
    search: (q: string, opts?: { isRegex?: boolean; glob?: string }) => Promise<{ path: string; line: number; text: string }[]>;
    // Milestone 1: unified diff preview BEFORE a write is approved. Optional
    // so mock hosts and older companions degrade to plain writes.
    diffPreview?: (path: string, content: string) => Promise<{ path: string; exists: boolean; diff: string; added: number; removed: number; truncated: boolean; currentMtime: string | null; previewedBytes: number }>;
    // Forge upgrade — Problem B: distinguish empty from missing. Optional so
    // mock hosts and older companions degrade gracefully.
    stat?: (path: string) => Promise<{ exists: boolean; type?: 'dir' | 'file' | 'other'; empty?: boolean; entryCount?: number; parentExists?: boolean; reason?: string; size?: number }>;
    // Forge upgrade — Problem B: archive extraction (companion-backed).
    extractArchive?: (path: string, opts?: { dest?: string; flatten?: boolean; overwrite?: boolean }) => Promise<{
      archive: string; dest: string; extracted: number; skippedExisting: number; bytes: number;
      nestedRoot: string | null; flattened: boolean; note?: string; sample: string[]; totalEntries: number;
    }>;
  };
  // Forge upgrade — Part 6: shared local browser over CDP (companion-backed).
  // Optional so mock hosts and older companions degrade with clear messages.
  browser?: {
    open: (opts?: { url?: string; visible?: boolean }) => Promise<{ ok?: boolean; reused?: boolean; url?: string; visible?: boolean; browser?: string; unavailable?: string }>;
    navigate: (url: string) => Promise<{ ok: boolean; url: string; title?: string; unavailable?: string }>;
    evaluate: (expression: string) => Promise<{ ok: boolean; value?: unknown; error?: string; consoleErrors?: { kind: string; text: string }[]; unavailable?: string }>;
    verify: (opts: { url: string; checks?: { selector?: string; contains?: string; minCount?: number; evaluate?: string }[]; saveScreenshot?: string }) => Promise<{
      ok?: boolean; url?: string; title?: string; checks?: { check: string; pass: boolean; count?: number; text?: string | null; value?: unknown; error?: string }[];
      checksPassed?: number; checksTotal?: number; consoleErrors?: { kind: string; text: string }[]; screenshotPath?: string;
      verdict?: string; unavailable?: string;
    }>;
    close: () => Promise<{ ok: boolean; note?: string }>;
    status: () => Promise<{ running: boolean; url?: string; visible?: boolean }>;
  };
  // Forge upgrade — canonical workspace identity, resolved once per run so
  // every tool reports the same absolute root and machine.
  workspaceMeta?: {
    id: string;
    rootPath: string;     // absolute path on the executing machine
    machineLabel: string; // e.g. "This computer", "Station", "Portable", "Windows Dell"
    platform: string;
    projectName?: string;
    knownTree?: string;
  };
  // Milestone 3: durable project memory + shared coordination surfaces.
  // Optional so mock hosts and older companions degrade with clear messages.
  memory?: {
    search: (q: string, opts?: { kind?: string; limit?: number }) => Promise<{ query: string; results: { id: string; kind: string; content: string; tags: string[]; score?: number; updatedAt: number; refs?: string | null }[]; hybrid?: boolean }>;
    read: (id: string) => Promise<{ id: string; kind: string; content: string; tags: string[]; refs?: string | null; updatedAt: number }>;
    write: (kind: string, content: string, opts?: { tags?: string[]; refs?: string }) => Promise<{ id: string; deduplicated: boolean }>;
    notebookAppend: (kind: string, content: string, opts?: { refs?: string }) => Promise<{ id?: string; seq?: number }>;
    notebookSearch: (q: string, opts?: { kind?: string; limit?: number }) => Promise<{ results: { seq?: number; agentId: string; kind: string; content: string; refs?: string | null; at: number }[] }>;
    readScratchpad: (agentId: string) => Promise<Record<string, unknown>>;
    writeScratchpad: (agentId: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  // Milestone 1: unified diff attached by write/edit tools. Rendered in the
  // UI (tool card + approval card) but NOT fed to the model with the result —
  // the model gets the concise confirmation line instead.
  diff?: string;
  diffPath?: string;
  // structured result metadata surfaced to the coordinator/diagnostics
  changedFile?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  danger: 'safe' | 'command' | 'destructive';
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;
}

// Tool-calling protocol mode:
//  - 'native': genuine provider function calling; never injects text-protocol
//    instructions or nudges (models with solid native support, e.g. the
//    Qwen3-Coder family — see docs/HARNESS_UPGRADE.md).
//  - 'text':   JSON-per-turn text protocol for models without reliable native
//    tool calling.
//  - 'auto':   probe-and-fall-back. Starts native; switches to text only when
//    the server/model rejects the tools API, recording why via mode_change.
// Legacy persisted values map: 'auto-native' → 'auto', 'force-text' → 'text'.
export type ToolProtocolMode = 'native' | 'text' | 'auto';

export interface ToolLogEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'ok' | 'error' | 'denied';
  startedAt: number;
  endedAt?: number;
  output?: string;
  exitCode?: number | null;
  // Forge upgrade — Part 2 structured execution feedback:
  machine?: string;      // companion host label executing the tool
  cwd?: string | null;   // working directory reported by the executor
  fsChanged?: boolean;   // whether this operation modified the workspace
  outcome?: 'ok-empty' | 'ok-nonempty' | 'error' | 'denied' | 'blocked';
  // Diagnostics detail (Phase 1.5 §6): optional per-call annotations. Present
  // when the runner records them; the diagnostics panel renders '—' otherwise.
  parse?: 'ok' | 'repair' | 'failed';
  validation?: 'ok' | 'schema-invalid' | 'unknown-tool';
  durMs?: number;
  repeatBlocked?: boolean;
  recoveryIssued?: boolean;
  argsTruncated?: boolean;
  argsError?: string;
  // Milestone 1: unified diff of the change (UI display only), the file it
  // touches, and the workspace-revision note recorded after FS writes.
  diff?: string;
  diffPath?: string;
  changedFile?: string;
  workspaceRevision?: string | null;
}

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; v: string }
  | { type: 'text_final'; v: string }
  | { type: 'tool_start'; call: ToolCallDraft }
  | { type: 'tool_end'; call: ToolCallDraft; entry: ToolLogEntry }
  | { type: 'approval_request'; req: { id: string; tool: string; args: Record<string, unknown>; danger: string; summary: string } }
  | { type: 'approval_decision'; id: string; decision: string }
  | { type: 'model_error'; message: string }
  | { type: 'mode_change'; from: string; to: string; reason: string }
  | { type: 'loop_detected'; tool: string; count: number; action: string; message: string }
  // Forge upgrade — Problem A: coordinator-level recovery and steering
  | { type: 'steering_applied'; message: string }
  | { type: 'auto_steering'; trigger: string; text: string }
  | { type: 'paused'; turn: number; reason?: string; note?: string }
  | { type: 'stall_detected'; tool: string; attempts: number; message: string }
  // Milestone 4: outcome-aware recovery ladder + honest stalled verdict
  | { type: 'recovery_action'; action: 'workspace_refocus' | 'strategy_directive'; stallClass: string; step: number; message: string }
  | { type: 'stalled'; message: string }
  | { type: 'escalation'; fromModel: string; toModel?: string; reason: string }
  // Forge upgrade — Problem D: evidence-gated completion
  | { type: 'completion_gate'; status: CompletionStatus; missing: string[]; detail: string; overridden?: boolean }
  | { type: 'dialect_learned'; dialect: 'native' | 'json' | 'tagged' | 'py'; model: string }
  | { type:'usage'; usage: { promptTokens: number | null; completionTokens: number | null } }
  // Milestone 1: a file write/edit produced a diff preview (UI renders it;
  // never fed to the model to keep context lean).
  | { type: 'diff_preview'; path: string; diff: string; added?: number; removed?: number }
  | { type: 'final'; content: string; turns: number; note?: string; canContinue?: boolean; completion?: CompletionResult }
  | { type: 'stage'; stage: string }
  | { type: 'notice'; message: string };

// Task completion statuses (Forge upgrade — Problem D). COMPLETE requires
// captured evidence; a model's self-reported success is never sufficient.
export type CompletionStatus = 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'UNVERIFIED';

export interface CompletionResult {
  status: CompletionStatus;
  missingCriteria: string[];
  reasons: string[];
  evidence: EvidenceRecord[];
  overriddenByUser?: boolean;
  overrideNote?: string;
}

export interface EvidenceRecord {
  kind: 'file-exists' | 'command-run' | 'tests-passed' | 'tests-failed' | 'browser-verified' | 'browser-unavailable' | 'feature-accounted' | 'manual';
  detail: string;
  at: number;
  source?: string; // tool call id or user override marker
}

export type Approver = (req: { tool: string; args: Record<string, unknown>; danger: string; summary: string }) => Promise<'allow' | 'allow-always' | 'deny'>;
