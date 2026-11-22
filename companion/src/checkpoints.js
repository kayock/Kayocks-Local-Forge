// RC3 — Task checkpoints (Cline-style) backed by a SHADOW git repository.
//
// A checkpoint snapshots the whole authorized workspace WITHOUT touching the
// user's own git repo (if any): objects live in a separate git dir under the
// LocalForge home (`checkpoints/<wsHash>.git`) with the workspace as the
// work-tree. Restore checks out tracked files from a chosen commit; unrelated
// user modifications to untracked files are never discarded.
//
// Git is optional: if the binary is unavailable every endpoint reports
// { available: false } and the UI hides the surface (honest degradation).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getState, log } from './config.js';
import os from 'node:os';

function lfHome() {
  return getState()?.home || process.env.LOCALFORGE_HOME || path.join(os.homedir(), '.localforge');
}

function shadowDir(wsPath) {
  const home = lfHome();
  const hash = crypto.createHash('sha1').update(wsPath).digest('hex').slice(0, 16);
  return path.join(home, 'checkpoints', `${hash}.git`);
}

function git(wsPath, args, opts = {}) {
  const dir = shadowDir(wsPath);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['--git-dir', dir, '--work-tree', wsPath, ...args], {
    cwd: wsPath, encoding: 'utf8', timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: 'LocalForge Checkpoints', GIT_AUTHOR_EMAIL: 'checkpoints@localforge.local', GIT_COMMITTER_NAME: 'LocalForge Checkpoints', GIT_COMMITTER_EMAIL: 'checkpoints@localforge.local', ...(opts.env || {}) },
  });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

function wsAvailable(wsPath) {
  return git(wsPath, ['--version']).ok;
}

const META = 'checkpoint-meta.json';
function metaPath(wsPath) { return path.join(shadowDir(wsPath), META); }
function readMeta(wsPath) {
  try { return JSON.parse(fs.readFileSync(metaPath(wsPath), 'utf8')); } catch { return { checkpoints: [] }; }
}
function writeMeta(wsPath, meta) { fs.writeFileSync(metaPath(wsPath), JSON.stringify(meta, null, 2)); }

function wsHash(wsPath) { return crypto.createHash('sha1').update(wsPath).digest('hex').slice(0, 12); }

/** Create a checkpoint commit of the whole work-tree. */
export function createCheckpoint(ws, label) {
  const wsPath = ws.path;
  if (!wsAvailable(wsPath)) return { available: false, error: 'git binary unavailable — checkpoints disabled (workspace files remain untouched)' };
  const init = git(wsPath, ['rev-parse', '--git-dir']);
  if (!init.ok) {
    const i = git(wsPath, ['init', '--quiet']);
    if (!i.ok) return { available: false, error: `git init failed: ${i.stderr.slice(0, 120)}` };
  }
  const add = git(wsPath, ['add', '-A', '--', '.']);
  if (!add.ok) return { available: false, error: `git add failed: ${add.stderr.slice(0, 160)}` };
  const tree = git(wsPath, ['write-tree']);
  if (!tree.ok) return { available: false, error: `git write-tree failed: ${tree.stderr.slice(0, 160)}` };
  const prevHead = git(wsPath, ['rev-parse', 'HEAD']);
  const parents = prevHead.ok ? ['-p', prevHead.stdout] : [];
  const commit = git(wsPath, ['commit-tree', tree.stdout, ...parents, '-m', String(label || 'checkpoint').slice(0, 120)]);
  if (!commit.ok) return { available: false, error: `git commit-tree failed: ${commit.stderr.slice(0, 160)}` };
  const upd = git(wsPath, ['update-ref', 'refs/heads/checkpoints', commit.stdout]);
  if (!upd.ok) return { available: false, error: `git update-ref failed: ${upd.stderr.slice(0, 160)}` };
  const meta = readMeta(wsPath);
  const cp = {
    id: `${Date.now().toString(36)}-${wsHash(wsPath)}`,
    hash: commit.stdout,
    label: String(label || 'checkpoint').slice(0, 120),
    at: Date.now(),
    workspace: wsPath,
  };
  meta.checkpoints = [...meta.checkpoints.filter((c) => c.hash !== cp.hash), cp].slice(-50);
  writeMeta(wsPath, meta);
  log('checkpoint_created', { ws: ws.id, hash: cp.hash.slice(0, 10), label: cp.label });
  return { available: true, checkpoint: cp };
}

export function listCheckpoints(ws) {
  if (!wsAvailable(ws.path)) return { available: false, checkpoints: [] };
  const meta = readMeta(ws.path);
  return { available: true, checkpoints: [...meta.checkpoints].sort((a, b) => b.at - a.at) };
}

/** Files changed between a checkpoint and the CURRENT work-tree. */
export function checkpointDiff(ws, hash) {
  if (!wsAvailable(ws.path)) return { available: false, error: 'git unavailable' };
  const nameOnly = git(ws.path, ['diff', '--name-status', hash, '--', '.']);
  if (!nameOnly.ok) return { available: false, error: `diff failed: ${nameOnly.stderr.slice(0, 160)}` };
  const stat = git(ws.path, ['diff', '--stat', hash, '--', '.']);
  return { available: true, files: nameOnly.stdout.split('\n').filter(Boolean).slice(0, 500), stat: stat.stdout.slice(0, 8000) };
}

/**
 * Restore the work-tree to a checkpoint. Safety model:
 *  - files tracked in the checkpoint are restored (checkout <hash> -- .);
 *  - files CREATED AFTER the checkpoint are DELETED only if they are tracked
 *    in the shadow repo's index (i.e., were checkpointed before deletion);
 *    untracked user files are NEVER touched;
 *  - the pre-restore state is itself committed as a safety checkpoint first,
 *    so a restore can always be undone.
 */
export function restoreCheckpoint(ws, hash) {
  if (!wsAvailable(ws.path)) return { available: false, error: 'git unavailable' };
  const verify = git(wsPath(ws), ['cat-file', '-e', `${hash}^{commit}`]);
  if (!verify.ok) return { available: false, error: 'unknown checkpoint hash' };
  const safety = createCheckpoint(ws, `pre-restore safety checkpoint (restoring ${String(hash).slice(0, 10)})`);
  if (!safety.available) return { available: false, error: `could not create the pre-restore safety snapshot: ${safety.error}` };
  const co = git(wsPath(ws), ['checkout', hash, '--', '.']);
  if (!co.ok) return { available: false, error: `checkout failed: ${co.stderr.slice(0, 160)}` };
  // remove files that exist now but were absent in the restored tree (tracked-only)
  const ls = git(wsPath(ws), ['ls-files']);
  const restored = git(wsPath(ws), ['ls-tree', '-r', '--name-only', hash]);
  const now = new Set(ls.ok ? ls.stdout.split('\n').filter(Boolean) : []);
  const then = new Set(restored.ok ? restored.stdout.split('\n').filter(Boolean) : []);
  const removed = [];
  for (const f of now) {
    if (!then.has(f)) {
      const p = path.join(ws.path, f);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { fs.unlinkSync(p); removed.push(f); } } catch { /* ignore */ }
    }
  }
  // re-index to the restored state
  git(wsPath(ws), ['add', '-A', '--', '.']);
  log('checkpoint_restored', { ws: ws.id, hash: String(hash).slice(0, 10), removed: removed.length });
  return { available: true, restored: hash, removedFiles: removed.slice(0, 100), safetyCheckpoint: safety.checkpoint };
}

function wsPath(ws) { return ws.path; }
