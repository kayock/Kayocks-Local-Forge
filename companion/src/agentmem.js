// Durable, per-authorized-workspace agent coordination data under the Companion home.
// No source text is sent to the hosted IDE backend.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

function invalid(reason) { const e = new Error(reason); e.status = 400; throw e; }
function fileFor(wsId) {
  if (!/^[a-f0-9]{12}$/.test(wsId)) invalid('Invalid workspace id');
  return path.join(config.home, 'agent-memory', `${wsId}.json`);
}
function load(wsId) {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(wsId), 'utf8'));
    return { scratchpads: value.scratchpads || {}, notebook: value.notebook || [], assignments: value.assignments || [] };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { scratchpads: {}, notebook: [], assignments: [] };
  }
}
function save(wsId, data) {
  const file = fileFor(wsId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = JSON.stringify(data);
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) invalid('Workspace agent memory is full (4 MiB cap)');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function safeAgent(v) {
  if (typeof v !== 'string' || !/^[\w.:-]{1,128}$/.test(v)) invalid('Invalid agent id');
  return v;
}
function strings(v, name) {
  if (!Array.isArray(v) || v.length > 200 || v.some((s) => typeof s !== 'string' || s.length > 4000)) invalid(`Invalid ${name}`);
  return v;
}
const FIELDS = ['plan', 'findings', 'toolResults', 'errors', 'pending', 'capabilities'];
export function readScratchpad(ws, agent) {
  safeAgent(agent);
  const data = load(ws.id);
  return { agentId: agent, workspaceId: ws.id, objective: null, plan: [], findings: [], toolResults: [], errors: [], pending: [], capabilities: [], progress: '', updatedAt: null, ...(data.scratchpads[agent] || {}) };
}
export function writeScratchpad(ws, agent, patch) {
  safeAgent(agent);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('Invalid scratchpad');
  const data = load(ws.id);
  const s = readScratchpad(ws, agent);
  for (const key of FIELDS) if (patch[key] !== undefined) s[key] = strings(patch[key], key);
  for (const key of ['objective', 'progress']) if (patch[key] !== undefined) {
    if (patch[key] !== null && (typeof patch[key] !== 'string' || patch[key].length > 16000)) invalid(`Invalid ${key}`);
    s[key] = patch[key];
  }
  s.updatedAt = new Date().toISOString();
  data.scratchpads[agent] = s;
  save(ws.id, data);
  return s;
}
export function notebookAppend(ws, body) {
  safeAgent(body.agentId);
  if (!['finding', 'handoff', 'decision', 'issue'].includes(body.kind) || typeof body.content !== 'string' || !body.content.trim() || body.content.length > 32000) invalid('Invalid notebook entry');
  if (body.refs !== undefined && (typeof body.refs !== 'string' || body.refs.length > 2000)) invalid('Invalid refs');
  const data = load(ws.id);
  const seq = (data.notebook.at(-1)?.seq || 0) + 1;
  const entry = { seq, id: crypto.randomUUID(), at: Date.now(), agentId: body.agentId, kind: body.kind, content: body.content, refs: body.refs || null };
  data.notebook.push(entry);
  data.notebook = data.notebook.slice(-1500);
  save(ws.id, data);
  return entry;
}
export function notebookList(ws, query) {
  const data = load(ws.id);
  const since = Number(query.get('since') || 0);
  if (!Number.isFinite(since) || since < 0) invalid('Invalid notebook cursor');
  return { entries: data.notebook.filter((x) => x.seq > since && (!query.get('agent') || x.agentId === query.get('agent')) && (!query.get('kind') || x.kind === query.get('kind'))) };
}
export function saveAssignment(ws, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid assignment');
  safeAgent(body.agentId);
  if (!['pending', 'in-progress', 'done', 'error', 'cancelled', 'conflict'].includes(body.status)) invalid('Invalid assignment status');
  const required = ['role', 'machine', 'model', 'task'];
  for (const key of required) if (typeof body[key] !== 'string' || body[key].length > 8000) invalid(`Invalid ${key}`);
  const id = body.id || crypto.randomUUID();
  if (typeof id !== 'string' || id.length > 128 || !/^[\w.:-]+$/.test(id)) invalid('Invalid assignment id');
  const data = load(ws.id);
  const previous = data.assignments.find((a) => a.id === id);
  const assignment = { ...(previous || {}), ...body, id, updatedAt: new Date().toISOString() };
  const idx = data.assignments.findIndex((a) => a.id === id);
  if (idx >= 0) data.assignments[idx] = assignment;
  else data.assignments.push(assignment);
  data.assignments = data.assignments.slice(-500);
  save(ws.id, data);
  return assignment;
}
export function listAssignments(ws) { return { assignments: load(ws.id).assignments }; }

// Uses path, size and modification time; never follows symlinks and never reads file contents.
export async function workspaceRevision(ws) {
  const root = ws.path;
  const fsAsync = await import('node:fs/promises');
  const h = crypto.createHash('sha256');
  let entries = 0;
  async function walk(abs, rel) {
    const names = (await fsAsync.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of names) {
      if (++entries > 100000) invalid('Workspace has too many entries for revision scan');
      const name = rel ? `${rel}/${item.name}` : item.name;
      const full = path.join(abs, item.name);
      const st = await fsAsync.lstat(full);
      h.update(JSON.stringify([name, item.isDirectory() ? 'd' : item.isFile() ? 'f' : 'link', st.size, st.mtimeMs]) + '\n');
      if (item.isDirectory()) await walk(full, name);
    }
  }
  await walk(root, '');
  return { revision: h.digest('hex'), entries };
}
