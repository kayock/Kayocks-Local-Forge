// Companion unit tests (recreated during the Forge upgrade — the previous
// test files were not present in this repository snapshot; a bare `test`
// .gitignore pattern had excluded them from commits — now fixed).
// Covers: path jail, stat (empty vs missing), archive extraction
// (nested root / flatten / zip-slip), tar.gz, and command screening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveInWorkspace, statPath, extractArchive, FsError } from '../src/fsapi.js';
import { screenCommand } from '../src/exec.js';
import { parseArgs } from '../src/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lf-companion-unit-'));
}

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function makeStoreZip(members) {
  const locals = []; const centrals = []; let off = 0;
  for (const [name, data] of members) {
    const nameBuf = Buffer.from(name);
    const dataBuf = Buffer.from(data, 'utf8');
    const crc = crc32(dataBuf);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(dataBuf.length, 18); l.writeUInt32LE(dataBuf.length, 22); l.writeUInt16LE(nameBuf.length, 26);
    locals.push(l, nameBuf, dataBuf);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(dataBuf.length, 20); c.writeUInt32LE(dataBuf.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(off, 42);
    centrals.push(c, nameBuf);
    off += 30 + nameBuf.length + dataBuf.length;
  }
  const cdStart = off; const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('resolveInWorkspace jails paths inside the workspace root', () => {
  const ws = { path: '/tmp/ws-root' };
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), path.resolve('/tmp/ws-root', 'a/b.txt'));
  assert.throws(() => resolveInWorkspace(ws, '../escape.txt'), FsError);
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'), FsError);
});

test('statPath distinguishes missing from empty from non-empty', async () => {
  const dir = tmpDir();
  const ws = { path: dir };
  const missing = await statPath(ws, 'no-such-dir');
  assert.equal(missing.exists, false);
  assert.equal(missing.parentExists, true);
  fs.mkdirSync(path.join(dir, 'empty'));
  const empty = await statPath(ws, 'empty');
  assert.equal(empty.exists, true);
  assert.equal(empty.empty, true);
  assert.equal(empty.entryCount, 0);
  fs.mkdirSync(path.join(dir, 'full'));
  fs.writeFileSync(path.join(dir, 'full', 'a.txt'), 'hi');
  const full = await statPath(ws, 'full');
  assert.equal(full.empty, false);
  assert.equal(full.entryCount, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractArchive detects a nested project root, flattens on request, never silently overwrites', async () => {
  const dir = tmpDir();
  const ws = { path: dir };
  fs.writeFileSync(path.join(dir, 'nested.zip'), makeStoreZip([['calculator repo/', ''], ['calculator repo/main.py', 'print(1)'], ['calculator repo/README.md', '# calc']]));
  const r1 = await extractArchive(ws, 'nested.zip', { dest: '.' });
  assert.equal(r1.nestedRoot, 'calculator repo');
  assert.equal(r1.flattened, false);
  assert.ok(fs.existsSync(path.join(dir, 'calculator repo/main.py')));
  assert.match(r1.note, /nested project root/);

  fs.mkdirSync(path.join(dir, 'flat'));
  const r2 = await extractArchive(ws, 'nested.zip', { dest: 'flat', flatten: true });
  assert.equal(r2.flattened, true);
  assert.ok(fs.existsSync(path.join(dir, 'flat/main.py')));

  fs.writeFileSync(path.join(dir, 'flat/main.py'), 'USER EDITS');
  const r3 = await extractArchive(ws, 'nested.zip', { dest: 'flat', flatten: true });
  assert.ok(r3.skippedExisting >= 1);
  assert.equal(fs.readFileSync(path.join(dir, 'flat/main.py'), 'utf8'), 'USER EDITS');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractArchive rejects zip-slip members', async () => {
  const dir = tmpDir();
  const ws = { path: dir };
  fs.writeFileSync(path.join(dir, 'evil.zip'), makeStoreZip([['../escaped.txt', 'x']]));
  await assert.rejects(() => extractArchive(ws, 'evil.zip', { dest: '.' }), /escapes/);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escaped.txt')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractArchive supports tar.gz', async () => {
  const dir = tmpDir();
  const ws = { path: dir };
  function tarBlock(name, data) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    h[156] = 48;
    h.write('ustar\0', 257, 6, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([h, data, pad]);
  }
  const tar = Buffer.concat([tarBlock('app/index.html', Buffer.from('<h1>x</h1>')), tarBlock('app/app.js', Buffer.from('console.log(1)')), Buffer.alloc(1024)]);
  fs.writeFileSync(path.join(dir, 'bundle.tgz'), zlib.gzipSync(tar));
  const r = await extractArchive(ws, 'bundle.tgz', { dest: 'out', flatten: true });
  assert.equal(r.extracted, 2);
  assert.equal(r.nestedRoot, 'app');
  assert.ok(fs.existsSync(path.join(dir, 'out/index.html')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('screenCommand hard-denies dangerous patterns and needs confirm for privileged commands', () => {
  const deny = screenCommand('rm -rf /', { confirm: true });
  assert.equal(deny.allowed, false);
  const confirm = screenCommand('sudo apt install x', { confirm: false });
  assert.equal(confirm.allowed, false);
  assert.equal(confirm.needsConfirm, true);
  const confirmed = screenCommand('sudo apt install x', { confirm: true });
  assert.equal(confirmed.allowed, true);
  const ok = screenCommand('echo integration-ok', { confirm: false });
  assert.equal(ok.allowed, true);
});


test('CLI option parsing supports Node.js scripts and Bun standalone executables', () => {
  const opts = ['--host', '0.0.0.0', '--port', '7338', '--home', 'C:\\Custom Forge', '--status-file', 'C:\\Custom Forge\\status.json', '--lan', '--show-code'];
  const nodeArgs = parseArgs(['node', '/repo/companion/src/server.js', ...opts]);
  const compiledArgs = parseArgs(['C:\\LocalForgeCompanion\\localforge-companion.exe', ...opts]);
  assert.deepEqual(compiledArgs, nodeArgs);
  assert.equal(compiledArgs.host, '0.0.0.0');
  assert.equal(compiledArgs.port, 7338);
  assert.equal(compiledArgs.lan, true);
  assert.equal(compiledArgs.showCode, true);
  assert.equal(parseArgs(['C:\\LocalForgeCompanion\\localforge-companion.exe', '--help']).help, true);
  assert.equal(parseArgs(['node', '/repo/companion/src/server.js', '--help']).help, true);
  // Bun variants can expose an additional compiled:// entry before real args.
  assert.equal(parseArgs(['bun', 'compiled://root/entry.js', 'localforge-companion.exe', '--help']).help, true);
  assert.deepEqual(parseArgs(['bun', 'compiled://root/entry.js', 'localforge-companion.exe', ...opts]), nodeArgs);
});
