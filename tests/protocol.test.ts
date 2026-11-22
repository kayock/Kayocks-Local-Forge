// Unit tests for the agent fallback tool protocol (text-mode tool calls for
// models without reliable native tool calling). Run: bun run test:protocol
import { describe, test, expect } from 'bun:test';
import {
  parseFallbackAction,
  toolResultMessage,
  FALLBACK_PROTOCOL_ADDON,
  FALLBACK_NUDGE,
} from '../src/lib/agent/protocol';

describe('parseFallbackAction', () => {
  test('bare JSON object parses', () => {
    expect(parseFallbackAction('{"tool": "list_dir", "args": {"path": "."}}')).toEqual({
      tool: 'list_dir',
      args: { path: '.' },
    });
  });

  test('fenced ```json block parses', () => {
    const raw = 'Here is my action:\n```json\n{"tool": "read_file", "args": {"path": "a.js"}}\n```';
    expect(parseFallbackAction(raw)?.args).toEqual({ path: 'a.js' });
  });

  test('thinking blocks are stripped before parsing', () => {
    // built by concatenation so the literal tags in this file are unambiguous
    const OPEN = '<thi' + 'nk>';
    const CLOSE = '</thi' + 'nk>';
    const raw = OPEN + 'I should look around first.' + CLOSE + '{"tool": "list_dir", "args": {}}';
    expect(parseFallbackAction(raw)?.tool).toBe('list_dir');
    // tool JSON hidden inside a stripped thinking block must be ignored
    const tricky = OPEN + '{"tool": "write_file", "args": {"path": "evil.js"}}' + CLOSE + '{"tool": "list_dir", "args": {}}';
    expect(parseFallbackAction(tricky)?.tool).toBe('list_dir');
  });

  test('trailing commas tolerated (small-model JSON)', () => {
    expect(parseFallbackAction('{"tool": "write_file", "args": {"path": "x.js",}}')).toEqual({
      tool: 'write_file',
      args: { path: 'x.js' },
    });
  });

  test('prose with embedded JSON is found by brace balancing', () => {
    const raw = 'I will list the directory now. {"tool": "list_dir", "args": {"path": "."}} — proceeding.';
    expect(parseFallbackAction(raw)?.tool).toBe('list_dir');
  });

  test('braces inside strings do not confuse the scanner', () => {
    const raw = '{"tool": "write_file", "args": {"path": "a.js", "content": "function f() { return \\"}\\"; }"}}';
    const a = parseFallbackAction(raw);
    expect(a?.tool).toBe('write_file');
    expect((a?.args as any)?.path).toBe('a.js');
  });

  test('legacy {name, arguments} shape accepted', () => {
    expect(parseFallbackAction('{"name": "list_dir", "arguments": {"path": "."}}')).toEqual({
      tool: 'list_dir',
      args: { path: '.' },
    });
  });

  test('missing args defaults to {}', () => {
    const a = parseFallbackAction('{"tool": "finish"}');
    expect(a?.tool).toBe('finish');
    expect(a?.args).toEqual({});
  });

  test('non-tool JSON returns null', () => {
    expect(parseFallbackAction('{"hello": "world"}')).toBeNull();
    expect(parseFallbackAction('I think the best approach is to look around first.')).toBeNull();
    expect(parseFallbackAction('')).toBeNull();
  });

  test('finish action carries the summary', () => {
    const a = parseFallbackAction('{"tool": "finish", "args": {"summary": "wrote app.js, tests pass"}}');
    expect(a?.tool).toBe('finish');
    expect((a?.args as any)?.summary).toContain('tests pass');
  });
});

describe('protocol messages', () => {
  test('tool results become user-role messages with the documented prefix', () => {
    const m = toolResultMessage('list_dir', 'index.html\napp.js', false);
    expect(m.role).toBe('user');
    expect(m.content.startsWith('[TOOL RESULT] list_dir')).toBe(true);
    const err = toolResultMessage('run_command', 'ENOENT', true);
    expect(err.content).toContain('(ERROR)');
  });

  test('protocol addon documents the JSON contract and finish shape', () => {
    expect(FALLBACK_PROTOCOL_ADDON).toContain('{"tool":');
    expect(FALLBACK_PROTOCOL_ADDON).toContain('"finish"');
    expect(FALLBACK_NUDGE).toContain('EXACTLY ONE JSON');
  });
});
