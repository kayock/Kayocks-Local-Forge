// Companion-side streamed tool-call assembly + JSON repair (Phase 1.5 §1.4).
//
// Providers stream native tool-call `arguments` in fragments; this module
// assembles them per tool_calls index and produces the final call list for
// chat(). Repair mirrors src/lib/agent/toolargs.ts (IDE side) exactly — the
// tests assert both implementations agree on the same payloads.
//
// Design rules (same as the IDE module):
//  - repair only fixes serialization damage; it never invents content;
//  - every repair is reported (argsRepairs / argsRepaired);
//  - truncation completion only APPENDS closers (never fabricates values);
//  - unrepairable payloads keep {_raw} + a structured error — no fake success.

const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function jsonBalance(s) {
  // Returns { stack, count } for unclosed brackets outside strings.
  const stack = [];
  let inStr = false, esc = false, count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); count++; }
    else if (ch === '}' || ch === ']') { stack.pop(); count = Math.max(0, count - 1); }
  }
  return { stack, count };
}

export function repairToolCallJson(raw) {
  const src = String(raw ?? '');
  const repairs = [];
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
    if (ch === '\\') { esc = true; continue; } // backslash written only when the escape is valid
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
    if (esc) repairs.push('dangling backslash at EOF removed'); // backslash never written (lazy escape)
    out += '"';
    truncatedCompleted = true;
    repairs.push('unterminated string closed (truncated payload)');
  }
  const balance = jsonBalance(out);
  if (balance.stack.length) {
    if (balance.stack.length > 64) return { ok: false, text: out, repairs, truncatedCompleted };
    out = out.replace(/,(\s*)$/, '$1');
    out += balance.stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    truncatedCompleted = true;
    repairs.push(`closed ${balance.stack.length} unbalanced bracket(s) (truncated payload)`);
  }
  const noComma = out.replace(/,(\s*[}\]])/g, '$1');
  if (noComma !== out) { repairs.push('trailing comma(s) removed'); out = noComma; }
  let ok = true;
  try { JSON.parse(out); } catch { ok = false; }
  return { ok, text: out, repairs, truncatedCompleted };
}

// Assembles streamed OpenAI-compatible tool_call deltas by index.
export function createToolCallAssembler() {
  const parts = new Map(); // index -> { id, name, args }
  let order = [];

  function ensure(index) {
    if (!parts.has(index)) {
      parts.set(index, { id: null, name: null, args: '' });
      order.push(index);
    }
    return parts.get(index);
  }

  function feed(chunk) {
    const deltas = chunk?.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(deltas)) return;
    for (const d of deltas) {
      const idx = Number.isFinite(d.index) ? d.index : 0;
      const rec = ensure(idx);
      if (d.id) rec.id = rec.id || d.id;
      if (d.function?.name) rec.name = rec.name || d.function.name;
      if (typeof d.function?.arguments === 'string') rec.args += d.function.arguments;
    }
  }

  function finalize({ finishReason } = {}) {
    const calls = [];
    for (const idx of order) {
      const rec = parts.get(idx);
      const call = {
        id: rec.id || `call_${idx}`,
        name: rec.name || 'unknown_tool',
        args: {},
        argsRepaired: false,
        argsRepairs: [],
        argsTruncated: false,
        argsError: null,
      };
      const raw = rec.args;
      if (raw && raw.trim()) {
        // 1) exact parse
        try {
          call.args = JSON.parse(raw);
        } catch {
          // 2) repair (never invents content)
          const rep = repairToolCallJson(raw);
          call.argsRepairs = rep.repairs;
          call.argsRepaired = rep.repairs.length > 0;
          call.argsTruncated = rep.truncatedCompleted || finishReason === 'length';
          if (rep.ok) {
            try { call.args = JSON.parse(rep.text); } catch { rep.ok = false; }
          }
          if (!rep.ok) {
            // unrepairable: keep the raw payload visible + a structured error
            call.args = { _raw: raw.length > 2000 ? raw.slice(0, 2000) + `…[${raw.length} chars total]` : raw };
            call.argsError = `Tool-call arguments were not valid JSON after repair: JSON parse failed (${raw.length} chars). The call was NOT executed silently.`;
          }
        }
        if (finishReason === 'length' && !call.argsTruncated) call.argsTruncated = true;
      } else {
        call.argsError = 'Tool call arrived with empty arguments.';
      }
      calls.push(call);
    }
    return calls;
  }

  return { feed, finalize, reset: () => { parts.clear(); order = []; } };
}
