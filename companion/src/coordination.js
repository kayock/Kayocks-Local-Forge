// Workspace write reservations (Milestone 2 — coordination). Advisory,
// short-TTL, in-memory locks that let a coordinator serialize writes between
// parallel agents on the SAME workspace host. They complement (never replace)
// the hard guarantees:
//   - revision checks (agentmem.workspaceRevision),
//   - per-file overwrite protection via ifUnmodifiedSince (fsapi.writeFile),
//   - explicit conflict reporting to the user.
// Locks are per workspace + relative path, expire automatically (TTL), and
// can only be released or overwritten by their owner.
const locks = new Map(); // `${wsId}::${path}` -> { owner, expiresAt, createdAt }

function key(wsId, p) { return `${wsId}::${String(p || '.').replace(/\\/g, '/')}`; }
function invalid(reason, status = 400) { const e = new Error(reason); e.status = status; throw e; }

function sweepExpired() {
  const now = Date.now();
  for (const [k, l] of locks) if (l.expiresAt <= now) locks.delete(k);
}

export function acquireLock(wsId, relPath, owner, { ttlMs = 60_000 } = {}) {
  sweepExpired();
  const k = key(wsId, relPath);
  const now = Date.now();
  const ttl = Math.max(1000, Math.min(Number(ttlMs) || 60_000, 15 * 60_000));
  const existing = locks.get(k);
  if (existing && existing.expiresAt > now) {
    if (existing.owner === owner) {
      existing.expiresAt = now + ttl; // owner refreshes its own reservation
      return { locked: true, reservation: { path: relPath, owner, expiresAt: existing.expiresAt, refresh: true } };
    }
    const e = invalid(`"${relPath}" is reserved by another writer (${existing.owner}) until ${new Date(existing.expiresAt).toISOString()}. Resolve or wait for the reservation to expire.`, 409);
    e.conflict = { path: relPath, owner: existing.owner, expiresAt: existing.expiresAt };
    throw e;
  }
  locks.set(k, { owner: String(owner), expiresAt: now + ttl, createdAt: now });
  return { locked: true, reservation: { path: relPath, owner: String(owner), expiresAt: now + ttl } };
}

export function releaseLock(wsId, relPath, owner) {
  sweepExpired();
  const k = key(wsId, relPath);
  const existing = locks.get(k);
  if (!existing) return { released: false, reason: 'no reservation held' };
  if (existing.owner !== owner) invalid(`Reservation belongs to ${existing.owner}; not ${owner}.`, 403);
  locks.delete(k);
  return { released: true };
}

export function listLocks(wsId) {
  sweepExpired();
  const prefix = `${wsId}::`;
  const out = [];
  for (const [k, l] of locks) {
    if (!k.startsWith(prefix)) continue;
    out.push({ path: k.slice(prefix.length), owner: l.owner, expiresAt: l.expiresAt, createdAt: l.createdAt });
  }
  return { reservations: out };
}
