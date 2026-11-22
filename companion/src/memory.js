// Persistent per-workspace project memory (Milestone 3).
//
// Durable structured records in SQLite with FTS5 keyword search, optional
// local-embedding hybrid retrieval, incremental workspace file indexing,
// deduplication, backup/restore — persisted across Companion restarts.
// Storage ladder (documented, honest degradation):
//   1. node:sqlite (built into Node >= 22.5 — no native packaging needed)
//   2. JSON store with substring search (very old Node; still durable)
// No external embedding API is ever REQUIRED; embeddings are used only when
// a LOCAL endpoint is configured (e.g. an Ollama embedding model) and are
// always optional.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, log } from './config.js';

function invalid(reason, status = 400) { const e = new Error(reason); e.status = status; throw e; }

// ---------------------------------------------------------------------------
// storage backend detection
// ---------------------------------------------------------------------------
let DatabaseSync = null;
let backend = 'json';
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  backend = 'sqlite';
} catch {
  backend = 'json';
}

export function memoryCapabilities() {
  return {
    backend,
    fts: backend === 'sqlite',
    embeddings: 'optional-local-only',
    description: backend === 'sqlite'
      ? 'SQLite + FTS5 keyword search; optional local-embedding hybrid retrieval.'
      : 'JSON file store with substring search (SQLite unavailable in this runtime); fully durable.',
  };
}

const MEM_DIR = () => path.join(config.home, 'memory');

// Per-workspace isolation: one DB file per workspace id.
const dbs = new Map(); // wsId -> handle

function dbPath(wsId) {
  if (!/^[a-f0-9]{12}$/.test(wsId)) invalid('Invalid workspace id');
  return path.join(MEM_DIR(), `${wsId}.db`);
}

function getDb(wsId) {
  if (dbs.has(wsId)) return dbs.get(wsId);
  fs.mkdirSync(MEM_DIR(), { recursive: true, mode: 0o700 });
  if (backend !== 'sqlite') return null;
  const db = new DatabaseSync(dbPath(wsId));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      tags TEXT,
      refs TEXT,
      source TEXT,
      agentId TEXT,
      pinned INTEGER DEFAULT 0,
      superseded INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
    CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(contentHash);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS file_index (
      path TEXT PRIMARY KEY,
      mtimeMs INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      excerpt TEXT,
      indexedAt INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS file_index_fts USING fts5(path, excerpt, content='file_index', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS file_index_ai AFTER INSERT ON file_index BEGIN
      INSERT INTO file_index_fts(rowid, path, excerpt) VALUES (new.rowid, new.path, new.excerpt);
    END;
    CREATE TRIGGER IF NOT EXISTS file_index_ad AFTER DELETE ON file_index BEGIN
      INSERT INTO file_index_fts(file_index_fts, rowid, path, excerpt) VALUES ('delete', old.rowid, old.path, old.excerpt);
    END;
    CREATE TRIGGER IF NOT EXISTS file_index_au AFTER UPDATE ON file_index BEGIN
      INSERT INTO file_index_fts(file_index_fts, rowid, path, excerpt) VALUES ('delete', old.rowid, old.path, old.excerpt);
      INSERT INTO file_index_fts(rowid, path, excerpt) VALUES (new.rowid, new.path, new.excerpt);
    END;
  `);
  dbs.set(wsId, db);
  return db;
}

// ---------------------------------------------------------------------------
// JSON fallback (durable, substring search)
// ---------------------------------------------------------------------------
function jsonFile(wsId) { return path.join(MEM_DIR(), `${wsId}.json`); }
function jsonLoad(wsId) {
  try { return JSON.parse(fs.readFileSync(jsonFile(wsId), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { memories: [], fileIndex: [] }; throw e; }
}
function jsonSave(wsId, data) {
  fs.mkdirSync(MEM_DIR(), { recursive: true, mode: 0o700 });
  const tmp = `${jsonFile(wsId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, jsonFile(wsId));
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
const KINDS = ['decision', 'convention', 'bug', 'fact', 'outcome', 'test-history', 'preference', 'note'];
function checkContent(content) {
  if (typeof content !== 'string' || !content.trim()) invalid('memory content is required');
  if (content.length > 32_000) invalid('memory content too long (32k chars max)');
  return content;
}
function checkTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some((t) => typeof t !== 'string' || t.length > 60)) invalid('tags must be an array of short strings');
  return tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
}
function safeAgent(agentId) {
  if (agentId === undefined || agentId === null) return null;
  if (typeof agentId !== 'string' || !/^[\w.:-]{1,128}$/.test(agentId)) invalid('Invalid agent id');
  return agentId;
}

// ---------------------------------------------------------------------------
// embeddings (OPTIONAL, local endpoint only)
// ---------------------------------------------------------------------------
let embeddingCfg = null; // { endpoint, model }
export function configureEmbeddings(cfg) {
  if (cfg === null) { embeddingCfg = null; return { embeddings: 'disabled' }; }
  if (!cfg || typeof cfg !== 'object') invalid('Invalid embedding config');
  if (typeof cfg.endpoint !== 'string' || !/^http:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cfg.endpoint)) {
    invalid('Embedding endpoint must be a local/LAN http URL — external embedding APIs are never required.');
  }
  embeddingCfg = { endpoint: cfg.endpoint.replace(/\/+$/, ''), model: String(cfg.model || 'nomic-embed-text') };
  return { embeddings: 'configured', endpoint: embeddingCfg.endpoint, model: embeddingCfg.model };
}
export function embeddingStatus() { return embeddingCfg ? { configured: true, ...embeddingCfg } : { configured: false }; }

async function embed(text) {
  if (!embeddingCfg) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    // Ollama-style local endpoint; any endpoint returning {embedding:[...]} works
    const res = await fetch(`${embeddingCfg.endpoint}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingCfg.model, prompt: text.slice(0, 8000) }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const v = j?.embedding;
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; } // embedding is strictly optional
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------------------------------------------------------------------
// memory CRUD
// ---------------------------------------------------------------------------
export function writeMemory(wsId, body) {
  if (!body || typeof body !== 'object') invalid('Invalid memory payload');
  const kind = KINDS.includes(body.kind) ? body.kind : 'note';
  const content = checkContent(body.content);
  const tags = checkTags(body.tags);
  const agentId = safeAgent(body.agentId);
  const refs = typeof body.refs === 'string' ? body.refs.slice(0, 2000) : null;
  const source = typeof body.source === 'string' ? body.source.slice(0, 300) : null;
  const pinned = body.pinned === true ? 1 : 0;
  const contentHash = hash(`${kind}\n${content}`);

  const now = Date.now();
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    // dedup: identical kind+content updates the existing record instead of duplicating
    const existing = db.prepare('SELECT id, createdAt FROM memories WHERE contentHash = ? AND superseded = 0').get(contentHash);
    if (existing) {
      db.prepare('UPDATE memories SET tags = ?, refs = COALESCE(?, refs), agentId = COALESCE(?, agentId), updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(tags), refs, agentId, now, existing.id);
      return { id: existing.id, deduplicated: true, createdAt: existing.createdAt, updatedAt: now };
    }
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO memories (id, kind, content, contentHash, tags, refs, source, agentId, pinned, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, content, contentHash, JSON.stringify(tags), refs, source, agentId, pinned, now, now);
    log('memory_write', { wsId, kind, bytes: content.length, dedup: false });
    return { id, deduplicated: false, createdAt: now, updatedAt: now };
  }
  // JSON backend
  const data = jsonLoad(wsId);
  const existing = data.memories.find((m) => m.contentHash === contentHash && !m.superseded);
  if (existing) {
    existing.tags = tags; existing.refs = refs ?? existing.refs; existing.agentId = agentId ?? existing.agentId; existing.updatedAt = now;
    jsonSave(wsId, data);
    return { id: existing.id, deduplicated: true, createdAt: existing.createdAt, updatedAt: now };
  }
  const id = crypto.randomUUID();
  data.memories.push({ id, kind, content, contentHash, tags, refs, source, agentId, pinned, superseded: 0, createdAt: now, updatedAt: now });
  jsonSave(wsId, data);
  return { id, deduplicated: false, createdAt: now, updatedAt: now };
}

export function readMemory(wsId, id) {
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id));
    if (!m) invalid('Unknown memory id', 404);
    return memoryOut(m);
  }
  const m = jsonLoad(wsId).memories.find((x) => x.id === id);
  if (!m) invalid('Unknown memory id', 404);
  return memoryOut(m);
}

function memoryOut(m) {
  return { ...m, tags: JSON.parse(m.tags || '[]'), pinned: !!m.pinned, superseded: !!m.superseded };
}

export function updateMemory(wsId, id, patch) {
  const prev = readMemory(wsId, id);
  const content = patch.content !== undefined ? checkContent(patch.content) : prev.content;
  const kind = patch.kind !== undefined ? (KINDS.includes(patch.kind) ? patch.kind : invalid('Invalid kind')) : prev.kind;
  const tags = patch.tags !== undefined ? checkTags(patch.tags) : prev.tags;
  const refs = patch.refs !== undefined ? (typeof patch.refs === 'string' ? patch.refs.slice(0, 2000) : null) : prev.refs;
  const pinned = patch.pinned !== undefined ? (patch.pinned === true ? 1 : 0) : (prev.pinned ? 1 : 0);
  const now = Date.now();
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    db.prepare('UPDATE memories SET kind = ?, content = ?, contentHash = ?, tags = ?, refs = ?, pinned = ?, updatedAt = ? WHERE id = ?')
      .run(kind, content, hash(`${kind}\n${content}`), JSON.stringify(tags), refs, pinned, now, String(id));
  } else {
    const data = jsonLoad(wsId);
    const m = data.memories.find((x) => x.id === id);
    Object.assign(m, { kind, content, contentHash: hash(`${kind}\n${content}`), tags, refs, pinned, updatedAt: now });
    jsonSave(wsId, data);
  }
  return { id: String(id), updated: true, updatedAt: now };
}

export function deleteMemory(wsId, id) {
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    const r = db.prepare('DELETE FROM memories WHERE id = ?').run(String(id));
    if (!r.changes) invalid('Unknown memory id', 404);
  } else {
    const data = jsonLoad(wsId);
    const before = data.memories.length;
    data.memories = data.memories.filter((m) => m.id !== id);
    if (data.memories.length === before) invalid('Unknown memory id', 404);
    jsonSave(wsId, data);
  }
  return { deleted: true, id: String(id) };
}

export function listMemories(wsId, query = new URLSearchParams()) {
  const kind = query.get('kind');
  const limit = Math.min(Number(query.get('limit') || 100), 500);
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    const rows = kind
      ? db.prepare('SELECT * FROM memories WHERE kind = ? ORDER BY pinned DESC, updatedAt DESC LIMIT ?').all(kind, limit)
      : db.prepare('SELECT * FROM memories ORDER BY pinned DESC, updatedAt DESC LIMIT ?').all(limit);
    return { memories: rows.map(memoryOut), backend };
  }
  let rows = jsonLoad(wsId).memories;
  if (kind) rows = rows.filter((m) => m.kind === kind);
  rows.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return { memories: rows.slice(0, limit).map(memoryOut), backend };
}

// Search: FTS5 keyword (sqlite) or substring (json), plus OPTIONAL vector
// hybrid scoring when a local embedding endpoint is configured. Pinned
// memories with any keyword hit always rank first.
export async function searchMemory(wsId, query = new URLSearchParams()) {
  const q = String(query.get('q') || '').trim();
  const kind = query.get('kind');
  const limit = Math.min(Number(query.get('limit') || 12), 100);
  if (!q) invalid('Missing search query q');
  const escapeFts = (s) => s.replace(/["*()]/g, ' ').trim();
  const ftsQuery = escapeFts(q).split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(' OR ');

  let rows = []; // [{score, memory}]
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    const sql = kind
      ? `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.kind = ? ORDER BY rank LIMIT ?`
      : `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`;
    try {
      const args = kind ? [ftsQuery, kind, limit * 4] : [ftsQuery, limit * 4];
      rows = db.prepare(sql).all(...args).map((m) => ({ score: 1 / (1 + Math.max(0, m.rank)), memory: memoryOut(m) }));
    } catch {
      rows = db.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY updatedAt DESC LIMIT ?').all(`%${q}%`, limit * 4).map((m) => ({ score: 0.5, memory: memoryOut(m) }));
    }
  } else {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = jsonLoad(wsId).memories.filter((m) => !kind || m.kind === kind);
    for (const m of all) {
      const hay = `${m.content} ${m.tags.join(' ')}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t)).length;
      if (hits) rows.push({ score: hits / terms.length, memory: memoryOut(m) });
    }
    rows.sort((a, b) => b.score - a.score);
    rows = rows.slice(0, limit * 4);
  }

  // optional hybrid: local embeddings refine the ranking (never required)
  const emb = await embed(q);
  if (emb && rows.length) {
    const scored = [];
    for (const r of rows.slice(0, 30)) {
      const v = await embed(r.memory.content);
      scored.push({ ...r, score: v ? 0.6 * r.score + 0.4 * ((cosine(emb, v) + 1) / 2) : r.score });
    }
    scored.sort((a, b) => b.score - a.score);
    rows = scored;
  }

  // pinned boosts
  rows.sort((a, b) => (b.memory.pinned - a.memory.pinned) || (b.score - a.score));
  return {
    query: q,
    backend,
    hybrid: !!emb,
    results: rows.slice(0, limit).map((r) => ({ score: Math.round(r.score * 1000) / 1000, ...r.memory })),
  };
}

// ---------------------------------------------------------------------------
// incremental workspace file indexing (bounded, secrets-excluded)
// ---------------------------------------------------------------------------
const INDEX_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'venv', '.venv', '__pycache__', '.cache', 'target', 'coverage', '.turbo']);
const SECRET_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i, /(^|\/)\.env$/i, /secret/i, /credential/i, /(^|\/)id_rsa/i, /(^|\/)id_ed25519/i,
  /\.pem$/i, /\.key$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /(^|\/)\.aws/i, /(^|\/)\.ssh/i, /password/i,
  /(^|\/)\.git-credentials$/i, /(^|\/)service-account.*\.json$/i, /\.p12$/i, /\.pfx$/i, /(^|\/)secrets?\./i,
];
const INDEX_MAX_FILE = 512 * 1024;
const INDEX_MAX_FILES = 3000;
const EXCERPT_MAX = 4000;

function isSecretPath(rel) { return SECRET_PATTERNS.some((re) => re.test(rel)); }

export async function indexWorkspace(ws, { full = false } = {}) {
  if (backend !== 'sqlite') {
    // JSON backend: file indexing stays available but lighter (paths only)
    return { indexed: 0, skippedSecrets: 0, unchanged: 0, note: 'file indexing requires the SQLite backend; memory records remain fully available' };
  }
  const db = getDb(ws.id);
  const root = ws.path;
  let indexed = 0, skippedSecrets = 0, unchanged = 0;
  const seen = new Set();
  const fsAsync = fsp;

  async function walk(abs, rel, depth) {
    if (indexed + skippedSecrets >= INDEX_MAX_FILES || depth > 8) return;
    let entries;
    try { entries = await fsAsync.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (indexed + skippedSecrets >= INDEX_MAX_FILES) return;
      if (INDEX_IGNORE.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const absPath = path.join(abs, e.name);
      if (e.isDirectory()) { await walk(absPath, relPath, depth + 1); continue; }
      if (!e.isFile()) continue;
      seen.add(relPath);
      const prior = db.prepare('SELECT mtimeMs, size, hash FROM file_index WHERE path = ?').get(relPath);
      const st = await fsAsync.stat(absPath).catch(() => null);
      if (!st) continue;
      if (prior && prior.mtimeMs === Math.floor(st.mtimeMs) && prior.size === st.size && !doFullScan) { unchanged++; continue; }
      if (isSecretPath(relPath) || isSecretPath(e.name)) { skippedSecrets++; continue; }
      if (st.size > INDEX_MAX_FILE) continue;
      let text;
      try { text = await fsAsync.readFile(absPath, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue;
      // cheap secret content sniff for indexed text files
      if (/(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|-----BEGIN PGP PRIVATE)/.test(text)) { skippedSecrets++; continue; }
      const h = hash(text);
      if (prior && prior.hash === h) { unchanged++; continue; }
      const excerpt = text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) : text;
      db.prepare('INSERT INTO file_index (path, mtimeMs, size, hash, excerpt, indexedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtimeMs=excluded.mtimeMs, size=excluded.size, hash=excluded.hash, excerpt=excluded.excerpt, indexedAt=excluded.indexedAt')
        .run(relPath, Math.floor(st.mtimeMs), st.size, h, excerpt, Date.now());
      indexed++;
    }
  }
  const doFullScan = full === true;
  await walk(root, '', 0);
  // prune stale entries
  if (backend === 'sqlite') {
    const all = db.prepare('SELECT path FROM file_index').all();
    for (const r of all) if (!seen.has(r.path)) db.prepare('DELETE FROM file_index WHERE path = ?').run(r.path);
  }
  log('memory_index', { wsId: ws.id, indexed, unchanged, skippedSecrets });
  return { indexed, unchanged, skippedSecrets, backend };
}

export async function searchFiles(wsId, query) {
  const q = String(query.get('q') || '').trim();
  const limit = Math.min(Number(query.get('limit') || 10), 50);
  if (!q) invalid('Missing q');
  if (backend !== 'sqlite') return { query: q, results: [], note: 'file search requires the SQLite backend' };
  const db = getDb(wsId);
  const ftsQuery = q.replace(/["*()]/g, ' ').trim().split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(' OR ');
  let rows;
  try {
    rows = db.prepare(`SELECT f.path, snippet(file_index_fts, 1, '…', '…', '…', 12) AS snippet FROM file_index_fts f WHERE file_index_fts MATCH ? LIMIT ?`).all(ftsQuery, limit);
  } catch {
    rows = db.prepare('SELECT path, substr(excerpt, 1, 200) AS snippet FROM file_index WHERE excerpt LIKE ? LIMIT ?').all(`%${q}%`, limit);
  }
  return { query: q, results: rows };
}

export function memoryStats(wsId) {
  if (backend === 'sqlite') {
    const db = getDb(wsId);
    const mems = db.prepare('SELECT COUNT(*) AS n, SUM(pinned) AS pinned FROM memories').get();
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind').all();
    const files = db.prepare('SELECT COUNT(*) AS n, MAX(indexedAt) AS lastIndexedAt FROM file_index').get();
    return { backend, memories: mems.n, pinned: mems.pinned || 0, byKind: kinds, indexedFiles: files.n, lastIndexedAt: files.lastIndexedAt || null, dbFile: dbPath(wsId) };
  }
  const data = jsonLoad(wsId);
  return { backend, memories: data.memories.length, pinned: data.memories.filter((m) => m.pinned).length, byKind: [], indexedFiles: 0, lastIndexedAt: null, dbFile: jsonFile(wsId) };
}

// Backup / restore: dump the whole per-workspace DB to a portable JSON file
// (sqlite CLI-free via SELECTs) and restore into a fresh DB.
export function exportMemory(wsId) {
  let memories;
  if (backend === 'sqlite') {
    memories = getDb(wsId).prepare('SELECT * FROM memories ORDER BY createdAt').all();
  } else {
    memories = jsonLoad(wsId).memories;
  }
  return {
    format: 'localforge-memory-v1', workspaceId: wsId, exportedAt: new Date().toISOString(), backend,
    memories: memories.map(memoryOut),
  };
}

export function importMemory(wsId, payload, { replace = false } = {}) {
  if (!payload || payload.format !== 'localforge-memory-v1' || !Array.isArray(payload.memories)) invalid('Invalid memory backup payload');
  let restored = 0, deduplicated = 0;
  for (const m of payload.memories.slice(0, 5000)) {
    const r = writeMemory(wsId, { kind: m.kind, content: m.content, tags: m.tags, refs: m.refs, agentId: m.agentId, pinned: m.pinned });
    if (r.deduplicated) deduplicated++; else restored++;
  }
  if (replace) {
    // after import, optionally drop memories that were not in the backup
    const keep = new Set(payload.memories.map((m) => hash(`${m.kind}\n${m.content}`)));
    if (backend === 'sqlite') {
      const db = getDb(wsId);
      const all = db.prepare('SELECT id, contentHash FROM memories').all();
      for (const row of all) if (!keep.has(row.contentHash)) db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
    } else {
      const data = jsonLoad(wsId);
      data.memories = data.memories.filter((m) => keep.has(m.contentHash));
      jsonSave(wsId, data);
    }
  }
  return { restored, deduplicated, replaced: replace };
}

// Concurrent-writer safety: scratchpads/notebooks (agentmem) remain the
// append/shared surfaces; memory records are content-hash deduplicated so
// two agents writing the same fact MERGE instead of destroying each other.
export function closeAllMemoryDbs() {
  for (const [, db] of dbs) { try { db.close(); } catch { /* ignore */ } }
  dbs.clear();
}
