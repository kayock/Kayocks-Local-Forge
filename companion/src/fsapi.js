// Filesystem tools exposed to the IDE/agent. Every path is jailed inside the
// workspace root (logical check + realpath check to defeat symlink escapes).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'venv', '.venv',
  '__pycache__', '.cache', 'target', '.turbo', '.parcel-cache', 'coverage',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.tgz', '.br', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav',
  '.ogg', '.webm', '.wasm', '.exe', '.dll', '.so', '.dylib', '.class', '.pyc',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.o', '.a', '.lib', '.jar',
]);

export class FsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function resolveInWorkspace(ws, relPath) {
  const rel = String(relPath || '.');
  const abs = path.resolve(ws.path, rel);
  if (abs !== ws.path && !abs.startsWith(ws.path + path.sep)) {
    throw new FsError(400, 'Path escapes the authorized workspace.');
  }
  return abs;
}

// Validate the nearest EXISTING ancestor, not just the requested path.
// A missing child of a symlinked directory previously escaped the workspace
// because realpath(child) failed with ENOENT and the error was ignored.
// Dangling symlinks are rejected rather than treated as missing files.
export async function assertInsideReal(ws, abs) {
  const root = await fsp.realpath(ws.path);
  if (abs !== ws.path && !abs.startsWith(ws.path + path.sep)) {
    throw new FsError(400, 'Path escapes the authorized workspace.');
  }
  let current = abs;
  while (true) {
    let exists = false;
    try {
      await fsp.lstat(current);
      exists = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (exists) {
      let resolved;
      try {
        resolved = await fsp.realpath(current);
      } catch (e) {
        // A dangling symlink is NOT a safe destination for a create operation.
        if (e.code === 'ENOENT' || e.code === 'ELOOP') {
          throw new FsError(400, 'Path contains an unresolved symbolic link.');
        }
        throw e;
      }
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new FsError(400, 'Resolved path (symlink) escapes the authorized workspace.');
      }
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new FsError(400, 'No existing workspace ancestor.');
    current = parent;
  }
}

function classify(name) {
  const ext = path.extname(name).toLowerCase();
  return { isBinary: BINARY_EXT.has(ext) };
}

export async function listTree(ws, { depth = 3, maxEntries = 4000 } = {}) {
  const root = ws.path;
  const out = [];
  async function walk(dir, rel, level) {
    if (out.length >= maxEntries || level > depth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name === '.git' && level === 1) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: relPath, type: 'dir' });
        await walk(path.join(dir, e.name), relPath, level + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch {}
        out.push({ path: relPath, type: 'file', size });
      }
    }
  }
  await walk(root, '', 1);
  return { root: ws.path, entries: out };
}

export async function readFileContent(ws, relPath) {
  const abs = resolveInWorkspace(ws, relPath);
  await assertInsideReal(ws, abs);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw new FsError(404, `File not found: ${relPath}`);
  if (st.isDirectory()) throw new FsError(400, `Path is a directory: ${relPath}`);
  if (st.size > 2 * 1024 * 1024) throw new FsError(400, `File too large to open in editor (>2MB): ${relPath}`);
  const { isBinary } = classify(abs);
  if (isBinary) throw new FsError(415, `Binary file (not editable): ${relPath}`);
  const content = await fsp.readFile(abs, 'utf8');
  return { path: relPath, content, size: st.size, modifiedAt: st.mtime.toISOString() };
}

export async function writeFileContent(ws, relPath, content, { createDirs = true } = {}) {
  const abs = resolveInWorkspace(ws, relPath);
  await assertInsideReal(ws, abs);
  if (typeof content !== 'string') throw new FsError(400, 'content must be a string');
  // If the target path is an existing (empty) directory — a common small-model
  // mistake of create_dir on a file path — replace it transparently.
  const st = await fsp.stat(abs).catch(() => null);
  if (st && st.isDirectory()) {
    const children = await fsp.readdir(abs);
    if (children.length === 0) {
      await fsp.rmdir(abs);
    } else {
      throw new FsError(400, `${relPath} is a non-empty directory; delete it before writing a file there.`);
    }
  }
  const dir = path.dirname(abs);
  if (createDirs) await fsp.mkdir(dir, { recursive: true });
  await assertInsideReal(ws, abs);
  await fsp.writeFile(abs, content, 'utf8');
  const st2 = await fsp.stat(abs);
  return { path: relPath, bytes: st2.size };
}

// Append text to a file (large-file assembly, tool-call repair mission).
// Creates the file and its parent directories when missing; jailed
// identically to every other fs operation. Each append is atomic; the file
// is complete only once the agent appends its final section. Returns the
// new total size so the agent can track assembly progress.
export async function appendFileContent(ws, relPath, content, { createDirs = true } = {}) {
  const abs = resolveInWorkspace(ws, relPath);
  await assertInsideReal(ws, abs);
  if (typeof content !== 'string') throw new FsError(400, 'content must be a string');
  const st = await fsp.stat(abs).catch(() => null);
  if (st && st.isDirectory()) throw new FsError(400, `${relPath} is a directory; append needs a file path.`);
  const dir = path.dirname(abs);
  if (createDirs) await fsp.mkdir(dir, { recursive: true });
  await assertInsideReal(ws, abs);
  await fsp.appendFile(abs, content, 'utf8');
  const st2 = await fsp.stat(abs);
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf8'), totalBytes: st2.size };
}

export async function makeDir(ws, relPath) {
  const abs = resolveInWorkspace(ws, relPath);
  await assertInsideReal(ws, abs);
  await fsp.mkdir(abs, { recursive: true });
  await assertInsideReal(ws, abs);
  return { path: relPath };
}

export async function deletePath(ws, relPath, { confirm = false } = {}) {
  if (!confirm) throw new FsError(403, 'Deletion requires confirm:true (destructive operation).');
  const abs = resolveInWorkspace(ws, relPath);
  await assertInsideReal(ws, abs);
  if (abs === ws.path) throw new FsError(400, 'Refusing to delete the workspace root.');
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: relPath, deleted: true };
}

export async function renamePath(ws, fromRel, toRel, { overwrite = false } = {}) {
  const from = resolveInWorkspace(ws, fromRel);
  const to = resolveInWorkspace(ws, toRel);
  await assertInsideReal(ws, from);
  await assertInsideReal(ws, to);
  if (from === to) return { from: fromRel, to: toRel };
  // Never silently replace an existing destination. This prevents the
  // platform-dependent rename() overwrite/data-loss behaviour.
  const existing = await fsp.lstat(to).then(() => true, (e) => {
    if (e.code === 'ENOENT') return false;
    throw e;
  });
  if (existing && !overwrite) throw new FsError(409, 'Destination already exists; pass overwrite:true to replace it.');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await assertInsideReal(ws, to);
  await fsp.rename(from, to);
  return { from: fromRel, to: toRel };
}

export async function searchWorkspace(ws, { q, isRegex = false, glob = '', maxResults = 300, ignoreCase = true }) {
  if (!q) throw new FsError(400, 'Missing search query q');
  let re;
  try {
    re = isRegex ? new RegExp(q, ignoreCase ? 'i' : '') : new RegExp(escapeRe(q), ignoreCase ? 'i' : '');
  } catch (e) {
    throw new FsError(400, `Invalid regex: ${e.message}`);
  }
  const root = ws.path;
  const results = [];
  const globRe = glob ? globToRe(glob) : null;

  async function walk(dir, rel) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      if (IGNORE_DIRS.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, relPath);
      } else if (e.isFile()) {
        const { isBinary } = classify(e.name);
        if (isBinary) continue;
        if (globRe && !globRe.test(relPath) && !globRe.test(e.name)) continue;
        const st = await fsp.stat(abs).catch(() => null);
        if (!st || st.size > 1024 * 1024) continue;
        let text;
        try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
        if (text.includes('\u0000')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ path: relPath, line: i + 1, text: lines[i].slice(0, 240) });
            if (results.length >= maxResults) return;
          }
        }
      }
    }
  }
  await walk(root, '');
  return { query: q, count: results.length, results };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRe(glob) {
  const src = escapeRe(glob).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`(^|/)${src}$`, 'i');
}

// ---------------------------------------------------------------------------
// Workspace state inspection (Forge upgrade — Problem B). An EMPTY directory
// and a MISSING directory must never look the same to the agent again: the
// calculator regression started with a "successful" empty listing of a path
// that did not actually exist.
// ---------------------------------------------------------------------------

export async function statPath(ws, relPath) {
  const rel = String(relPath || '.');
  const abs = resolveInWorkspace(ws, rel);
  await assertInsideReal(ws, abs);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) {
    // Distinguish at the resolution level too: does the parent exist?
    const parent = await fsp.stat(path.dirname(abs)).catch(() => null);
    return {
      path: rel,
      absolute: abs,
      exists: false,
      parentExists: !!parent,
      reason: parent ? 'not-found (parent exists)' : 'not-found (parent missing)',
    };
  }
  const base = {
    path: rel,
    absolute: abs,
    exists: true,
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
  if (st.isDirectory()) {
    let children = [];
    try { children = await fsp.readdir(abs); } catch { /* unreadable */ }
    base.entryCount = children.length;
    base.empty = children.length === 0;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Archive extraction (Forge upgrade — Problem B). The calculator regression
// produced "calculator repo/calculator repo/" because extraction had no
// nested-root detection. Rules here:
//   - zip (store + deflate) and tar / tar.gz / tgz, both read in-memory
//     (archives stay under 512 MB uncompressed);
//   - destination is an explicit path inside the workspace (default "."),
//     never implicit; existing files are skipped unless overwrite:true;
//   - zip-slip: every member path is jailed inside the destination;
//   - a nested single top-level directory is DETECTED and REPORTED, and only
//     flattened when the caller explicitly passes flatten:true;
//   - contents are never silently moved or deleted.
// ---------------------------------------------------------------------------

const ARCHIVE_MAX_UNCOMPRESSED = 512 * 1024 * 1024;
const ARCHIVE_MAX_ENTRIES = 20000;

function detectNestedRoot(memberPaths) {
  // memberPaths: normalized relative paths (no leading ./, no trailing /).
  // A nested root exists when every member lives under one single top-level
  // directory (and there is at least one file, not just the directory entry).
  let root = null;
  let hasFile = false;
  for (const p of memberPaths) {
    if (!p || p === '.') continue;
    const top = p.split('/')[0];
    if (p.includes('/')) hasFile = true;
    if (root === null) root = top;
    else if (root !== top) return null;
  }
  if (!root || !hasFile) return null;
  return root;
}

function safeJoin(base, rel) {
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new FsError(400, `Archive member escapes the destination ("${rel}").`);
  }
  return abs;
}

// --- minimal ZIP reader (central directory; store + deflate) ---
function readZip(buf) {
  // End of Central Directory record: signature 0x06054b50, may be followed by
  // a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new FsError(400, 'Not a readable ZIP archive (no end-of-central-directory record).');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central dir signature
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lfhOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // locate the local header to find the true data offset (extra field may
    // differ between central dir and local header)
    let dataOff = -1;
    if (lfhOffset + 30 <= buf.length && buf.readUInt32LE(lfhOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(lfhOffset + 26);
      const lExtraLen = buf.readUInt16LE(lfhOffset + 28);
      dataOff = lfhOffset + 30 + lNameLen + lExtraLen;
    }
    if (dataOff < 0 || dataOff + compSize > buf.length) {
      throw new FsError(400, 'ZIP entry is truncated or invalid.');
    }
    entries.push({ name, method, compSize, uncompressedSize: buf.readUInt32LE(off + 24), dataOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipMemberData(buf, entry) {
  const raw = buf.slice(entry.dataOff, entry.dataOff + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: ARCHIVE_MAX_UNCOMPRESSED + 1 });
  throw new FsError(400, `Unsupported ZIP compression method ${entry.method} (only store/deflate).`);
}

// --- minimal TAR reader (ustar; handles tar, tar.gz, tgz) ---
function readTar(buf) {
  const entries = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.slice(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive block
    const nameEnd = header.indexOf(0, 0, 100);
    let name = header.slice(0, nameEnd < 0 ? 100 : nameEnd).toString('utf8');
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/[^0-7]/g, ''), 8) || 0;
    const typeflag = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0/g, '').trim();
    if (prefix) name = `${prefix}/${name}`;
    off += 512;
    const dataEnd = off + size;
    if (dataEnd > buf.length) break;
    if (typeflag === '48' || typeflag === '0') entries.push({ name, data: buf.slice(off, dataEnd) });
    // skip pax/global headers (x/g types) and link entries (type 1/2) silently
    off = Math.ceil(dataEnd / 512) * 512;
  }
  return entries;
}

export async function extractArchive(ws, archiveRel, { dest = '.', flatten = false, overwrite = false, stripComponents = 0 } = {}) {
  const archiveAbs = resolveInWorkspace(ws, archiveRel);
  await assertInsideReal(ws, archiveAbs);
  const st = await fsp.stat(archiveAbs).catch(() => null);
  if (!st) throw new FsError(404, `Archive not found: ${archiveRel}`);
  if (st.size > 256 * 1024 * 1024) throw new FsError(400, 'Archive larger than 256 MB is not supported.');
  if (!st.isFile()) throw new FsError(400, 'Archive path is not a regular file.');
  const buf = await fsp.readFile(archiveAbs);
  const lower = archiveRel.toLowerCase();

  let members;
  if (lower.endsWith('.zip')) {
    const entries = readZip(buf);
    if (entries.length > ARCHIVE_MAX_ENTRIES) throw new FsError(400, 'Archive has too many entries.');
    let total = 0;
    members = entries.map((e) => {
      if (e.uncompressedSize > ARCHIVE_MAX_UNCOMPRESSED - total) {
        throw new FsError(400, 'Archive exceeds the uncompressed size limit.');
      }
      const data = zipMemberData(buf, e);
      total += data.length;
      if (total > ARCHIVE_MAX_UNCOMPRESSED) throw new FsError(400, 'Archive exceeds the uncompressed size limit.');
      return { name: e.name, data };
    });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    try {
      members = readTar(zlib.gunzipSync(buf, { maxOutputLength: ARCHIVE_MAX_UNCOMPRESSED + 1 }));
    } catch {
      throw new FsError(400, 'Not a valid gzip stream (file ends with .tar.gz/.tgz).');
    }
  } else if (lower.endsWith('.tar')) {
    members = readTar(buf);
  } else {
    throw new FsError(400, `Unsupported archive type: ${archiveRel} (supported: .zip, .tar, .tar.gz, .tgz)`);
  }
  if (members.length > ARCHIVE_MAX_ENTRIES) throw new FsError(400, `Archive has too many entries (${members.length}).`);

  // Reject archive paths that would need sanitizing; never silently turn a
  // traversal into a different filename (including Windows path forms).
  const files = [];
  let uncompressedTotal = 0;
  for (const m of members) {
    uncompressedTotal += m.data.length;
    if (uncompressedTotal > ARCHIVE_MAX_UNCOMPRESSED) throw new FsError(400, 'Archive exceeds the uncompressed size limit.');
    const rawName = String(m.name || '').replace(/\\/g, '/');
    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue; // explicit directory entry
    if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName) ||
        rawName.split('/').includes('..') || rawName.includes('\u0000')) {
      throw new FsError(400, `Archive member escapes the destination ("${rawName}").`);
    }
    let name = rawName.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!name || name.endsWith('/')) continue;
    files.push({ name, data: m.data });
  }
  if (!files.length) throw new FsError(400, 'Archive contains no regular files.');

  const nestedRoot = detectNestedRoot(files.map((f) => f.name));
  let prefix = '';
  if (flatten && nestedRoot) prefix = `${nestedRoot}/`;
  if (stripComponents > 0) {
    const cut = files[0].name.split('/').slice(0, stripComponents).join('/') + '/';
    prefix = cut;
  }

  const destAbs = resolveInWorkspace(ws, dest);
  await assertInsideReal(ws, destAbs);
  await fsp.mkdir(destAbs, { recursive: true });

  let extracted = 0;
  let skipped = 0;
  let bytes = 0;
  const written = [];
  for (const f of files) {
    let rel = f.name;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (!rel) continue; // the nested root directory itself
    const outAbs = safeJoin(destAbs, rel);
    await assertInsideReal(ws, outAbs);
    const exists = await fsp.lstat(outAbs).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (exists && !overwrite) { skipped++; continue; }
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    await assertInsideReal(ws, outAbs);
    if (f.data.length > ARCHIVE_MAX_UNCOMPRESSED) throw new FsError(400, 'Archive member exceeds the uncompressed size limit.');
    await fsp.writeFile(outAbs, f.data);
    extracted++;
    bytes += f.data.length;
    if (written.length < 40) written.push(rel);
  }

  return {
    archive: archiveRel,
    dest,
    destAbsolute: destAbs,
    extracted,
    skippedExisting: skipped,
    bytes,
    nestedRoot: nestedRoot || null,
    flattened: !!(flatten && nestedRoot),
    note: nestedRoot
      ? (flatten
        ? `Archive had a nested project root "${nestedRoot}/" — it was stripped as requested (flatten:true).`
        : `Archive had a nested project root "${nestedRoot}/". Files were extracted to ${dest}/${nestedRoot}/ — call again with flatten:true or point your work at ${dest}/${nestedRoot} unless that is intended.`)
      : undefined,
    sample: written,
    totalEntries: files.length,
  };
}
