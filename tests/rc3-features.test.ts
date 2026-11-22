// RC3 feature tests: workspace_map, project guidance (rules/skills),
// shadow-git checkpoints over the live companion API, task sessions store.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CORE_TOOLS } from '@/lib/agent/tools';
import { projectGuidanceBlock } from '@/lib/agent/prompts';
import { useTaskSessions } from '@/lib/store/task-sessions';

const ROOT = path.resolve(import.meta.dir, '..');
const COMPANION = path.join(ROOT, 'companion');
const PORT = 7591;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rc3-h-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rc3-ws-'));

let token = '';
let wsId = '';
const procs: any[] = [];

async function api(method: string, p: string, body?: unknown, tok = token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

beforeAll(async () => {
  fs.writeFileSync(path.join(WS, 'app.py'), 'print("hi")\n');
  fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'src', 'util.py'), 'x = 1\n');
  fs.writeFileSync(path.join(WS, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' }, dependencies: { left: '1' } }));
  fs.mkdirSync(path.join(WS, '.localforge', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(WS, '.localforge', 'rules.md'), '- Always run pytest before finishing.\n- Use 2-space indentation.');
  fs.writeFileSync(path.join(WS, '.localforge', 'skills', 'deploy.md'), '# Deploy\nBuild with npm run build, then run scripts/deploy.sh.');

  const proc = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--home', HOME, '--workspace', WS, '--no-mdns', '--no-browser-hint'], {
    cwd: COMPANION, env: { ...process.env, LOCALFORGE_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
  const pr = await (await fetch(`${BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: state.pairingCode, deviceLabel: 'rc3-test' }) })).json();
  token = pr.token;
  const w = await api('POST', '/api/workspaces', { path: WS, name: 'rc3' });
  wsId = w.json.workspace.id;
}, 60000);

afterAll(async () => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(WS, { recursive: true, force: true }).catch(() => {});
});

describe('workspace_map tool (repo awareness)', () => {
  test('maps directories, counts files, and summarizes the manifest', async () => {
    const def = CORE_TOOLS.find((t) => t.name === 'workspace_map')!;
    expect(def).toBeTruthy();
    const ctx = { fs: { listDir: async () => [
      { path: 'app.py', type: 'file', size: 12 },
      { path: 'src', type: 'dir' },
      { path: 'src/util.py', type: 'file', size: 6 },
      { path: 'tests', type: 'dir' },
    ], readFile: async (p: string) => ({ content: JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' }, dependencies: { a: '1', b: '2' } }), size: 0, modifiedAt: '' }) } } as any;
    const r = await def.run({ path: '.' }, ctx);
    expect(r.output).toContain('Workspace map');
    expect(r.output).toContain('src/ (1)');
    expect(r.output).toContain('app.py');
    expect(r.output).toContain('scripts=[test]');
    expect(r.output).toContain('deps=2');
  });
});

describe('project rules & skills (.localforge/)', () => {
  test('companion serves rules + skills from the workspace', async () => {
    const g = await api('GET', `/api/ws/${wsId}/project-guidance`);
    expect(g.status).toBe(200);
    expect(g.json.rules).toContain('pytest before finishing');
    expect(g.json.skills.some((s: any) => s.name === 'deploy' && s.content.includes('Deploy'))).toBe(true);
  });

  test('rules always injected; only task-relevant skills are included', () => {
    const block = projectGuidanceBlock(
      '- Always run pytest before finishing.',
      [{ name: 'deploy', content: '# Deploy\nBuild with npm run build.' }, { name: 'refactoring', content: '# Refactoring guide\nSmall steps.' }],
      'deploy the service to staging',
    );
    expect(block).toContain('PROJECT RULES');
    expect(block).toContain('pytest before finishing');
    expect(block).toContain('PROJECT SKILL: deploy');
    expect(block).not.toContain('Refactoring guide');
    expect(block).toContain('refactoring'); // listed by name, not injected
  });

  test('no guidance → empty block', () => {
    expect(projectGuidanceBlock(null, [], 'anything')).toBe('');
  });
});

describe('shadow-git checkpoints (live companion)', () => {
  test('create → list → diff → restore with a pre-restore safety checkpoint', async () => {
    const c1 = await api('POST', `/api/ws/${wsId}/checkpoints`, { label: 'before edits' });
    expect(c1.status).toBe(200);
    expect(c1.json.available).toBe(true);
    expect(c1.json.checkpoint.hash).toMatch(/^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(WS, 'app.py'), 'print("changed")\n');
    fs.writeFileSync(path.join(WS, 'extra.txt'), 'new file');

    const c2 = await api('POST', `/api/ws/${wsId}/checkpoints`, { label: 'after edits' });
    expect(c2.json.available).toBe(true);

    const list = await api('GET', `/api/ws/${wsId}/checkpoints`);
    expect(list.json.checkpoints.map((c: any) => c.label)).toContain('before edits');

    const diff = await api('GET', `/api/ws/${wsId}/checkpoints/${c1.json.checkpoint.hash}/diff`);
    expect(diff.json.available).toBe(true);
    expect(diff.json.files.join('\n')).toContain('app.py');

    const restore = await api('POST', `/api/ws/${wsId}/checkpoints/${c1.json.checkpoint.hash}/restore`, {});
    expect(restore.json.available).toBe(true);
    expect(fs.readFileSync(path.join(WS, 'app.py'), 'utf8')).toBe('print("hi")\n');
    expect(fs.existsSync(path.join(WS, 'extra.txt'))).toBe(false); // tracked in shadow repo → removed
    // the restore itself is undoable (safety checkpoint recorded)
    const list2 = await api('GET', `/api/ws/${wsId}/checkpoints`);
    expect(list2.json.checkpoints.some((c: any) => c.label.includes('pre-restore'))).toBe(true);
  });
});

describe('durable task sessions (localStorage store)', () => {
  test('create → append → checkpoint → search → resume data intact', () => {
    const st = useTaskSessions.getState();
    const s = st.createSession('ws-rc3', 'Fix the login redirect bug');
    st.appendMessage(s.id, 'user', 'Fix the login redirect bug');
    st.appendMessage(s.id, 'assistant', 'Found the bug in src/auth.py — fixing.');
    st.addCheckpoint(s.id, { id: 'cp1', hash: 'abc123', label: 'before fix', at: Date.now() });
    st.updateSession(s.id, { status: 'paused' });

    const found = useTaskSessions.getState().searchSessions('ws-rc3', 'login redirect');
    expect(found.length).toBe(1);
    expect(found[0].status).toBe('paused');
    expect(found[0].messages.length).toBe(2);
    expect(found[0].checkpoints[0].label).toBe('before fix');
    // search also matches message content
    const byMsg = useTaskSessions.getState().searchSessions('ws-rc3', 'auth.py');
    expect(byMsg.length).toBe(1);
  });
});
