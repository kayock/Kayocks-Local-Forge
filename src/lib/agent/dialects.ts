// Model-aware tool-call dialect handling (Forge upgrade — Part 2), adapted
// from the ALS "learned dialect" design (Apache-2.0, autonomous-loop-studio/
// Autonomous) to LocalForge's runner: detect the tool-call dialect a model
// actually speaks, repair recognizable near-misses instead of dropping them,
// and remember which dialect worked per provider+model.
//
// The ladder, in probe order (ALS: "plain → JSON → native → XML"):
//   native  — genuine OpenAI function-call deltas (handled by the runner
//             directly, not parsed from text)
//   json    — bare or fenced JSON tool object (the documented text protocol)
//   tagged  — <tool_call>{...}</tool_call> / <tool>{"name": ...}</tool> /
//             [TOOL_CALL] {...} wrappers many local models emit
//   py      — pythonic call text: tool_name(path="x") (name repair applies)
//
// Rules kept from ALS: a guessed name is repaired against the registry, an
// invented name is refused; conversational prose is never executed as a tool
// call; the successful dialect is recorded and led with next time.
import type { FallbackAction } from './protocol';
import { parseFallbackAction, repairJson } from './protocol';

export type ToolDialect = 'native' | 'json' | 'tagged' | 'py';

export const DIALECT_LADDER: ToolDialect[] = ['json', 'tagged', 'py'];

export interface DialectParse {
  dialect: ToolDialect;
  action: FallbackAction;
}

// Tagged wrappers seen in the wild (Qwen3, DeepSeek, Hermes-style, ALS XML).
const TAGGED_RES = [
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i,
  /<tool>\s*([\s\S]*?)\s*<\/tool>/i,
  /\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]/i,
  /<function_call>\s*([\s\S]*?)\s*<\/function_call>/i,
];

// Pythonic-call extraction:  list_dir(path="."),  write_file(path='x', content="...")
const PY_CALL_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*|"[a-zA-Z_][a-zA-Z0-9_]*")\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/;

// Detect the dialect of a model reply. Returns null when the text carries no
// executable tool intent (conversational prose stays prose).
export function detectToolDialect(raw: string): DialectParse | null {
  const text = String(raw ?? '');

  // 1) json ladder (fenced / bare / embedded) — includes legacy shapes and
  //    double-encoded args repair
  const jsonAction = parseFallbackAction(text);
  if (jsonAction) return { dialect: 'json', action: jsonAction };

  // 2) tagged wrappers — JSON inside a wrapper (repair JSON inside)
  for (const re of TAGGED_RES) {
    const m = text.match(re);
    if (m?.[1]) {
      const inner = m[1];
      const action = parseFallbackAction(inner) ?? parseKeyValueTag(inner);
      if (action) return { dialect: 'tagged', action };
    }
  }

  // 3) pythonic call syntax
  const py = parsePythonicCall(text);
  if (py) return { dialect: 'py', action: py };

  return null;
}

// Tagged but non-JSON content, e.g. <tool_call>list_dir path="."</tool_call>
// or <tool name="list_dir">path=.</tool>. Best effort: key="value" pairs; the
// tool name is an explicit name/tool key or the leading identifier.
function parseKeyValueTag(inner: string): FallbackAction | null {
  const body0 = inner.trim();
  if (!body0) return null;
  const nameMatch = body0.match(/(?:name|tool)\s*[:=]\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/i);
  let tool: string | null = nameMatch?.[1] ?? null;
  let body = body0.replace(/(?:name|tool)\s*[:=]\s*["'][^"']*["']\s*,?/i, '');
  if (!tool) {
    // leading identifier form: `list_dir path="."`
    const lead = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+)$/);
    if (!lead) return null;
    tool = lead[1];
    body = lead[2];
  }
  const args: Record<string, unknown> = {};
  const pairRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\n}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(body))) {
    const key = m[1];
    let v: unknown = m[2].trim();
    if (typeof v === 'string' && /^["']/.test(v)) v = v.slice(1, -1);
    args[key] = v;
  }
  if (!Object.keys(args).length) {
    // `<tool_call>list_dir</tool_call>` with no args at all is still a call
    if (!nameMatch && /\s/.test(body0)) return null;
    return { tool: tool!, args: {} };
  }
  return { tool: tool!, args };
}

function parsePythonicCall(text: string): FallbackAction | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = cleaned.match(PY_CALL_RE);
  if (!m) return null;
  const tool = m[1].replace(/"/g, '');
  const argText = m[2];
  if (!argText) return { tool, args: {} };
  // try JSON with quoted keys first, else key=value pairs
  const jsonish = `{${argText}}`;
  try {
    const parsed = JSON.parse(repairJson(jsonish.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')));
    if (parsed && typeof parsed === 'object') return { tool, args: parsed };
  } catch { /* fall through */ }
  const args: Record<string, unknown> = {};
  const pairRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = pairRe.exec(argText))) {
    let v: unknown = pm[2].trim();
    if (typeof v === 'string' && /^["']/.test(v)) v = v.slice(1, -1);
    args[pm[1]] = v;
  }
  return Object.keys(args).length ? { tool, args } : null;
}

// ---- per-model learned-dialect ledger ----
// Keyed `${providerBaseUrl}::${model}` like the protocol ledger in settings.

export interface DialectRecord {
  dialect: ToolDialect;
  at: number;
  successes: number;
  lastArgs?: string; // canonicalized arg keys that worked (diagnostics)
}

export type DialectLedger = Record<string, DialectRecord>;

export function dialectKey(baseUrl: string | undefined, model: string): string {
  return `${String(baseUrl || '').replace(/\/+$/, '')}::${model}`;
}

export function recordDialectSuccess(ledger: DialectLedger, key: string, dialect: ToolDialect, argKeys?: string[]): DialectLedger {
  const prev = ledger[key];
  return {
    ...ledger,
    [key]: {
      dialect,
      at: Date.now(),
      successes: (prev?.successes ?? 0) + 1,
      lastArgs: argKeys?.join(','),
    },
  };
}

export function preferredDialect(ledger: DialectLedger, key: string): ToolDialect | null {
  return ledger[key]?.dialect ?? null;
}
