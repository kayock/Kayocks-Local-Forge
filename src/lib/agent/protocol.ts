// Fallback tool protocol for models without reliable native tool calling.
//
// Instead of the OpenAI tools API, the model is instructed to emit one JSON
// object per turn:  {"tool": "<name>", "args": { ... }}
// The runner parses it, executes the tool, and feeds the result back as a
// user-role message. This is the documented fallback path; it works with any
// instruction-following model regardless of server tool support.

export interface FallbackAction {
  tool: string;
  args: Record<string, unknown>;
}

import type { ToolProtocolMode } from './types';

// Maps persisted/legacy mode values onto the current three-mode scheme.
// 'auto-native' → 'auto', 'force-text' → 'text'; unknown values → 'auto'.
export function normalizeProtocolMode(v: string | null | undefined): ToolProtocolMode {
  switch (v) {
    case 'native': return 'native';
    case 'text': case 'force-text': return 'text';
    case 'auto': case 'auto-native': case undefined: case null: case '': return 'auto';
    default: return 'auto';
  }
}

export const FALLBACK_PROTOCOL_ADDON = `
TOOL PROTOCOL (text mode):
You interact with the workspace ONLY through tool calls. Each of your replies must be EXACTLY ONE JSON object and nothing else (no markdown, no prose before or after):
{"tool": "<tool_name>", "args": { ... }}
Available tools are listed in this conversation. After each tool call you receive a message starting with [TOOL RESULT] containing the output; then you may issue the next call.
When the task is fully complete, reply with: {"tool": "finish", "args": {"summary": "<what you did, files written, how it was verified>"}}
If you cannot complete the task, reply with {"tool": "finish", "args": {"summary": "Could not complete: <reason>"}}.
Examples:
{"tool": "list_dir", "args": {"path": "."}}
{"tool": "write_file", "args": {"path": "src/app.js", "content": "console.log(1);"}}
{"tool": "run_command", "args": {"command": "npm test"}}
`.trim();

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
}

function tryParse(text: string): any | null {
  const cleaned = repairJson(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// Repair the minor formatting defects small local models routinely produce
// (spec §3.2 "Recover from minor formatting defects where the intended
// operation is unambiguous"):
//  - trailing commas:            {"a":1,}  /  {"a":[1,2,]}
//  - single-quoted JSON:         {'tool': 'list_dir'}
//  - unquoted object keys:       {tool: "list_dir"}
//  - fullwidth quotes/braces from CJK-trained models: ｛"tool"：...｝
//  - smart quotes:               "tool"
export function repairJson(text: string): string {
  let s = String(text ?? '');
  if (/[\uFF5B\uFF5D\uFF1A\uFF0C\u201C\u201D\u2018\u2019]/.test(s)) {
    s = s
      .replace(/\uFF5B/g, '{').replace(/\uFF5D/g, '}')
      .replace(/\uFF1A/g, ':').replace(/\uFF0C/g, ',')
      .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  }
  s = s.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
  // single-quoted JSON (only when the payload has no escaped-quote ambiguity)
  if (s.includes("'") && !s.includes('\\"')) {
    const candidate = s.replace(/'([^'\\]*)'/g, '"$1"');
    try { JSON.parse(candidate); s = candidate; } catch { /* leave as-is */ }
  }
  // unquoted keys
  try {
    JSON.parse(s);
  } catch {
    const candidate = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
    try { JSON.parse(candidate); s = candidate; } catch { /* leave as-is */ }
  }
  return s;
}

// Extract the first balanced JSON object that has a tool intent.
// Accepts two shapes:
//   {"tool": "...", "args": {...}}       — the documented text protocol
//   {"name": "...", "arguments": {...}}  — legacy function-call JSON that small
//                                          models emit instead of native calls
export function parseFallbackAction(raw: string): FallbackAction | null {
  const text = stripThink(raw);

  // 1) fenced blocks
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const a = asAction(tryParse(fence[1]));
    if (a) return a;
  }

  // 2) whole-text parse (model emitted bare JSON)
  const a = asAction(tryParse(text));
  if (a) return a;

  // 3) scan for balanced braces
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          const act = asAction(tryParse(candidate));
          if (act) return act;
          break;
        }
      }
    }
  }
  return null;
}

function asAction(parsed: any): FallbackAction | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.tool === 'string') {
    return { tool: parsed.tool, args: coerceArgs(parsed.args) };
  }
  if (typeof parsed.name === 'string' && (parsed.arguments !== undefined || parsed.args !== undefined)) {
    return { tool: parsed.name, args: coerceArgs(parsed.arguments ?? parsed.args) };
  }
  // OpenAI-style nested shape: {"function": {"name": ..., "arguments": ...}}
  if (typeof parsed.function?.name === 'string') {
    return { tool: parsed.function.name, args: coerceArgs(parsed.function.arguments) };
  }
  return null;
}

// args may arrive as a JSON *string* (double-encoded by the model); recover it.
function coerceArgs(a: unknown): Record<string, unknown> {
  if (a == null) return {};
  if (typeof a === 'string') {
    try {
      const parsed = JSON.parse(repairJson(a));
      return typeof parsed === 'object' && parsed !== null ? parsed : { _raw: a };
    } catch { return { _raw: a }; }
  }
  return a as Record<string, unknown>;
}

// Converts a tool result into a user-role message for text protocol models
// (some servers reject the OpenAI "tool" role, so we use "user" consistently).
export function toolResultMessage(tool: string, output: string, isError: boolean) {
  return {
    role: 'user' as const,
    content: `[TOOL RESULT] ${tool} ${isError ? '(ERROR)' : ''}\n${output}\nContinue: reply with exactly one JSON tool call, or finish.`,
  };
}

// Nudge when the model answered in prose without a JSON action.
export const FALLBACK_NUDGE =
  'Your reply was not a valid JSON tool call. Reply with EXACTLY ONE JSON object like {"tool": "read_file", "args": {"path": "index.js"}} or {"tool": "finish", "args": {"summary": "..."}}. No other text.';
