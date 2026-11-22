// Cross-machine task packets (Milestone 2). Durable, per-workspace task
// records a coordinator can fan out to other Companion instances, with
// acknowledgments, progress, completion, cancellation, failure records and
// idempotent re-submission (dedupKey). Stored alongside agent memory under
// the Companion home; nothing leaves the LAN except through explicit mesh
// proxy calls made by a paired peer.
//
// State machine: queued → acknowledged → in-progress → completed | failed
//                queued → cancelled; any active state → cancelled (explicit
//                cancellation only — the coordinator never auto-retries).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

function invalid(reason, status = 400) { const e = new Error(reason); e.status = status; throw e; }

const TASKS_DIR = () => path.join(config.home, 'tasks');
const fileFor = (wsId) => {
  if (!/^[a-f0-9]{12}$/.test(wsId)) invalid('Invalid workspace id');
  return path.join(TASKS_DIR(), `${wsId}.json`);
};

function loadTasks(wsId) {
  try {
    const v = JSON.parse(fs.readFileSync(fileFor(wsId), 'utf8'));
    return Array.isArray(v.tasks) ? v.tasks : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function saveTasks(wsId, tasks) {
  fs.mkdirSync(TASKS_DIR(), { recursive: true, mode: 0o700 });
  const raw = JSON.stringify({ tasks });
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) invalid('Task store is full (8 MiB cap)', 507);
  const tmp = `${fileFor(wsId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, fileFor(wsId));
}

const ACTIVE = new Set(['queued', 'acknowledged', 'in-progress']);
const STATUSES = ['queued', 'acknowledged', 'in-progress', 'completed', 'failed', 'cancelled'];

function clampStr(v, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') invalid('Expected string field');
  return v.slice(0, max);
}

export function createTask(wsId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid task payload');
  const title = clampStr(body.title, 300) || 'untitled task';
  const tasks = loadTasks(wsId);
  // Idempotent submission: same dedupKey returns the existing task untouched.
  if (body.dedupKey) {
    const existing = tasks.find((t) => t.dedupKey === body.dedupKey);
    if (existing) return { task: existing, deduplicated: true };
  }
  const now = Date.now();
  const task = {
    id: crypto.randomUUID(),
    wsId,
    title,
    // the full task contract travels with the packet (requirements, context,
    // workspace mapping, acceptance criteria — buildHandoffPacket shape)
    contract: clampStr(body.contract, 64_000) || null,
    requirements: Array.isArray(body.requirements) ? body.requirements.slice(0, 50).map((r) => String(r).slice(0, 500)) : [],
    contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles.slice(0, 100).map((f) => String(f).slice(0, 500)) : [],
    workspaceMapping: body.workspaceMapping && typeof body.workspaceMapping === 'object'
      ? { local: clampStr(body.workspaceMapping.local, 500) ?? null, remote: clampStr(body.workspaceMapping.remote, 500) ?? null, revision: clampStr(body.workspaceMapping.revision, 128) ?? null }
      : null,
    assignedMachine: clampStr(body.assignedMachine, 160) || null,
    machineId: clampStr(body.machineId, 128) || null,
    agentId: clampStr(body.agentId, 128) || null,
    dedupKey: clampStr(body.dedupKey, 200) || null,
    dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn.slice(0, 20).map((d) => String(d).slice(0, 128)) : [],
    priority: Number.isFinite(body.priority) ? Math.max(0, Math.min(9, Number(body.priority))) : 5,
    status: 'queued',
    progress: [],
    result: null,
    error: null,
    evidence: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
    endedAt: null,
  };
  tasks.push(task);
  saveTasks(wsId, tasks.slice(-500));
  return { task, deduplicated: false };
}

export function listTasks(wsId, query = new URLSearchParams()) {
  let tasks = loadTasks(wsId);
  const status = query.get('status');
  if (status && STATUSES.includes(status)) tasks = tasks.filter((t) => t.status === status);
  const machineId = query.get('machineId');
  if (machineId) tasks = tasks.filter((t) => t.machineId === machineId);
  const since = Number(query.get('since') || 0);
  if (Number.isFinite(since) && since > 0) tasks = tasks.filter((t) => t.updatedAt > since);
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  return { tasks: tasks.slice(0, 300), serverTime: Date.now() };
}

function findTask(tasks, id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) invalid('Unknown task', 404);
  return t;
}

export function getTask(wsId, id) {
  return { task: findTask(loadTasks(wsId), id) };
}

// transition helper: only valid edges, explicit cancellation for active tasks
function transition(t, to) {
  const ok =
    (t.status === 'queued' && ['acknowledged', 'cancelled'].includes(to)) ||
    (t.status === 'acknowledged' && ['in-progress', 'completed', 'failed', 'cancelled'].includes(to)) ||
    (t.status === 'in-progress' && ['completed', 'failed', 'cancelled'].includes(to)) ||
    (t.status === 'queued' && ['completed', 'failed'].includes(to)); // un-acked terminal states are legal
  if (!ok) invalid(`Illegal task transition ${t.status} → ${to}`, 409);
  t.status = to;
}

export function ackTask(wsId, id, body) {
  const tasks = loadTasks(wsId);
  const t = findTask(tasks, id);
  if (t.status === 'cancelled') invalid('Task was cancelled before acknowledgment', 409);
  if (ACTIVE.has(t.status) && t.acknowledgedAt) {
    // Idempotent re-ack by the same agent is a no-op.
    if (t.agentId && body?.agentId && t.agentId !== body.agentId) invalid('Task already acknowledged by another agent', 409);
    return { task: t, deduplicated: true };
  }
  transition(t, 'acknowledged');
  t.agentId = clampStr(body?.agentId, 128) || t.agentId;
  t.machineId = clampStr(body?.machineId, 128) || t.machineId;
  t.attempts += 1;
  t.acknowledgedAt = Date.now();
  t.updatedAt = Date.now();
  saveTasks(wsId, tasks);
  return { task: t, deduplicated: false };
}

export function progressTask(wsId, id, body) {
  const tasks = loadTasks(wsId);
  const t = findTask(tasks, id);
  if (!ACTIVE.has(t.status)) invalid(`Task is ${t.status}; progress updates are only accepted while active`, 409);
  t.progress.push({ note: clampStr(body?.note, 2000) || '', at: Date.now() });
  if (t.progress.length > 100) t.progress = t.progress.slice(-100);
  if (body?.status === 'in-progress' || body?.status === 'acknowledged') t.status = body.status;
  t.updatedAt = Date.now();
  saveTasks(wsId, tasks);
  return { task: t };
}

export function completeTask(wsId, id, body) {
  const tasks = loadTasks(wsId);
  const t = findTask(tasks, id);
  if (t.status === 'cancelled') invalid('Task was cancelled; completion refused', 409);
  transition(t, 'completed');
  t.result = {
    summary: clampStr(body?.summary, 8000) || '',
    artifacts: Array.isArray(body?.artifacts) ? body.artifacts.slice(0, 50).map((a) => ({ path: String(a?.path ?? a).slice(0, 500), bytes: Number(a?.bytes) || null })) : [],
    filesChanged: Array.isArray(body?.filesChanged) ? body.filesChanged.slice(0, 100).map((f) => String(f).slice(0, 500)) : [],
    revisionAfter: clampStr(body?.revisionAfter, 128) || null,
  };
  if (Array.isArray(body?.evidence)) t.evidence = body.evidence.slice(0, 50).map((x) => ({ kind: String(x?.kind ?? 'note').slice(0, 40), detail: String(x?.detail ?? '').slice(0, 2000), at: Date.now() }));
  t.endedAt = Date.now();
  t.updatedAt = Date.now();
  saveTasks(wsId, tasks);
  return { task: t };
}

export function failTask(wsId, id, body) {
  const tasks = loadTasks(wsId);
  const t = findTask(tasks, id);
  if (t.status === 'cancelled') invalid('Task was cancelled; failure record refused', 409);
  transition(t, 'failed');
  t.error = {
    reason: clampStr(body?.reason, 8000) || 'unspecified failure',
    recoverable: body?.recoverable !== false,
  };
  t.endedAt = Date.now();
  t.updatedAt = Date.now();
  saveTasks(wsId, tasks);
  return { task: t };
}

export function cancelTask(wsId, id, body) {
  const tasks = loadTasks(wsId);
  const t = findTask(tasks, id);
  if (['completed', 'failed', 'cancelled'].includes(t.status)) return { task: t, deduplicated: true }; // already terminal
  transition(t, 'cancelled');
  t.error = { reason: clampStr(body?.reason, 2000) || 'cancelled by user/coordinator', recoverable: false };
  t.endedAt = Date.now();
  t.updatedAt = Date.now();
  saveTasks(wsId, tasks);
  return { task: t };
}

// Coordinator bookkeeping: mark a lost machine's active tasks failed so the
// coordinator can reassign; called by mesh.js when a peer goes unreachable.
export function failActiveTasksForMachine(wsId, machineId, reason) {
  const tasks = loadTasks(wsId);
  let changed = 0;
  for (const t of tasks) {
    if (ACTIVE.has(t.status) && t.machineId === machineId) {
      t.status = 'failed';
      t.error = { reason: `machine disconnected: ${String(reason).slice(0, 500)}`, recoverable: true };
      t.endedAt = Date.now();
      t.updatedAt = Date.now();
      changed++;
    }
  }
  if (changed) saveTasks(wsId, tasks);
  return changed;
}
