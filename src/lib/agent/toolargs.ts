// Tool-call argument decoding + repair (IDE side, Phase 1.5 spec §1).
//
// The companion already assembles streamed native tool calls and repairs them
// (companion/src/toolcalls.js). This module is the second chance inside the
// IDE runtime: it decodes whatever still arrives as a raw string — args
// delivered as a JSON *string* by some providers, double-encoded args, legacy
// {_raw} fallbacks from older companions, and text-protocol payloads.
//
// Design rules:
//  - repair only fixes serialization damage; it never invents content;
//  - every successful repair is reported so the model + tool log know;
//  - failures keep the original string (capped) plus a precise, actionable
//    error — the full original is preserved for diagnostics, not for the
//    model (context protection).

const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

export interface ArgsParseResult {
  ok: boolean;
  args: Record<string, any> | null;
  // "raw" arrived as a string; "repaired" = serialization was fixed; "clean" =
  // parsed as-is; "raw" = unparseable (error + preview are set). "object" =
  // the input was already an object.
  from: 'object' | 'clean' | 'repaired' | 'raw';
  repairs?: string[];
  truncated?: boolean; // payload looked incomplete and was completed
  error?: string;      // when ok=false: precise parse failure description
  rawPreview?: string; // capped original for diagnostics/error messages
  rawLength?: number;
}

const RAW_CAP = 2000;

export function capPreview(s: string, n = RAW_CAP): string {
  return s.length > n ? s.slice(0, n) + `…[${s.length - n} chars omitted]` : s;
}

// Decode a tool-call args value that may be: an object, a JSON string,
// a double-encoded JSON string, or broken JSON needing repair.
export function parseToolCallArgs(raw: unknown): ArgsParseResult {
  if (raw == null) return { ok: true, args: {}, from: 'object' };
  if (typeof raw === 'object') {
    return { ok: true, args: { ...(raw as Record<string, any>) }, from: 'object' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, args: null, from: 'raw', error: `Arguments arrived as ${typeof raw}, expected a JSON object.`, rawPreview: capPreview(String(raw)) };
  }
  const s = raw;
  const base = { rawPreview: capPreview(s), rawLength: s.length };

  // 1) exact parse
  try {
    const v = JSON.parse(s);
    // A bare JSON string as top level = double-encoded args: unwrap once.
    if (typeof v === 'string') {
      try {
        const inner = JSON.parse(v);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          return { ok: true, args: inner as Record<string, any>, from: 'repaired', repairs: ['double-encoded JSON string unwrapped'], ...base };
        }
      } catch { /* not double-encoded after all */ }
    }
    return { ok: true, args: normalizeParsed(v), from: 'clean', ...base };
  } catch (e) {
    /* continue to repair */
  }

  // 2) repair pass (invalid escapes, literal control chars, truncation)
  const rep = repairToolCallJson(s);
  try {
    const v = JSON.parse(rep.text);
    return {
      ok: true,
      args: normalizeParsed(v),
      from: 'repaired',
      repairs: rep.repairs,
      truncated: rep.truncatedCompleted,
      ...base,
    };
  } catch {
    /* fall through */
  }

  // 3) double-encoded: the payload is itself a quoted string containing JSON
  const unquoted = tryUnwrapQuotedJson(s);
  if (unquoted) {
    try {
      const v = JSON.parse(unquoted);
      return { ok: true, args: normalizeParsed(v), from: 'repaired', repairs: ['double-encoded JSON string unwrapped'], ...base };
    } catch { /* keep failure */ }
  }

  return {
    ok: false,
    args: null,
    from: 'raw',
    error: firstJsonError(s),
    ...base,
  };
}

function normalizeParsed(v: any): Record<string, any> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  // Non-object top level (e.g. a bare string) → wrap so validation can report it.
  return { _value: v };
}

function tryUnwrapQuotedJson(s: string): string | null {
  const t = s.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return null;
  try {
    const inner = JSON.parse(t);
    return typeof inner === 'string' ? inner : null;
  } catch {
    return null;
  }
}

// Human-readable first-error context: position + surrounding snippet.
function firstJsonError(s: string): string {
  let msg = 'Invalid JSON.';
  let pos = -1;
  try {
    JSON.parse(s);
  } catch (e: any) {
    msg = String(e?.message || msg);
    const m = /position (\d+)/i.exec(msg);
    if (m) pos = Number(m[1]);
  }
  const around = pos >= 0
    ? `Near position ${pos}: ${JSON.stringify(s.slice(Math.max(0, pos - 40), pos + 40))}`
    : `Payload start: ${JSON.stringify(s.slice(0, 80))}${s.length > 80 ? '…' : ''}`;
  return `${msg} ${around}`;
}

// Repair serialization damage in a JSON document (mirrors the companion's
// repairToolCallJson — see that file for the rationale).
export function repairToolCallJson(raw: string): { ok: boolean; text: string; repairs: string[]; truncatedCompleted: boolean } {
  const src = String(raw ?? '');
  const repairs: string[] = [];
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inStr) {
      if (ch === '\uFF5B') { out += '{'; repairs.push('fullwidth { → {'); continue; }
      if (ch === '\uFF5D') { out += '}'; repairs.push('fullwidth } → }'); continue; }
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (esc) {
      esc = false;
      if (VALID_ESCAPES.has(ch)) { out += '\\' + ch; continue; }
      if (ch === 'u') {
        const hex = src.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += '\\u' + hex; i += 4; continue; }
        out += '\\\\u';
        repairs.push('bad \\u escape → literal');
        continue;
      }
      out += ch;
      repairs.push(`invalid escape \\${ch} → ${ch}`);
      continue;
    }
    if (ch === '\\') { esc = true; continue; } // backslash is written only if the escape is valid
    if (ch === '"') { inStr = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      repairs.push(`literal control char U+${code.toString(16).padStart(4, '0')} escaped`);
      continue;
    }
    out += ch;
  }
  let truncatedCompleted = false;
  if (inStr) {
    if (esc) repairs.push('dangling backslash at EOF removed'); // backslash was never written (lazy escape)
    out += '"';
    truncatedCompleted = true;
    repairs.push('unterminated string closed (truncated payload)');
  }
  const balance = jsonBalance(out);
  if (balance) {
    if (balance.stack.length > 64) return { ok: false, text: out, repairs, truncatedCompleted };
    out = out.replace(/,(\s*)$/, '$1');
    out += balance.stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    truncatedCompleted = true;
    repairs.push(`closed ${balance.count} unbalanced bracket(s) (truncated payload)`);
  }
  const noComma = out.replace(/,(\s*[}\]])/g, '$1');
  if (noComma !== out) { repairs.push('trailing comma(s) removed'); out = noComma; }
  return { ok: true, text: out, repairs, truncatedCompleted };
}

function jsonBalance(s: string): { stack: string[]; count: number } | null {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return inStr || stack.length ? { stack, count: stack.length + (inStr ? 1 : 0) } : null;
}
