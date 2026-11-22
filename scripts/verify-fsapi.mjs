// Verify companion fsapi additions: statPath (empty vs missing) and
// extractArchive (zip/tar, nested-root detection, flatten, zip-slip guard).
// Run: node scripts/verify-fsapi.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { statPath, extractArchive, FsError } from '../companion/src/fsapi.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-fsapi-'));
const ws = { path: tmp };
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failed++;
};

// --- statPath: missing vs empty vs non-empty ---
const missing = await statPath(ws, 'does-not-exist');
check('missing path: exists=false, parentExists=true', missing.exists === false && missing.parentExists === true);

fs.mkdirSync(path.join(tmp, 'empty-dir'));
const empty = await statPath(ws, 'empty-dir');
check('empty dir: exists=true, empty=true, entryCount=0', empty.exists && empty.empty === true && empty.entryCount === 0);

fs.mkdirSync(path.join(tmp, 'full-dir'));
fs.writeFileSync(path.join(tmp, 'full-dir', 'a.txt'), 'hello');
const full = await statPath(ws, 'full-dir');
check('non-empty dir: exists=true, empty=false, entryCount=1', full.exists && full.empty === false && full.entryCount === 1);

// --- build a nested zip ("calculator repo/" twice) ---
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6);
    l.writeUInt16LE(8, 8); l.writeUInt16LE(0, 10); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nameBuf.length, 26);
    locals.push(l, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(off, 42);
    centrals.push(c, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const cdStart = off;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const nestedZip = makeZip([
  ['calculator repo/', ''],
  ['calculator repo/main.py', Buffer.from('print("hi")')],
  ['calculator repo/README.md', Buffer.from('# calc')],
]);
fs.writeFileSync(path.join(tmp, 'calc.zip'), nestedZip);

const ex1 = await extractArchive(ws, 'calc.zip', { dest: '.' });
check('nested zip extracted as-is', ex1.extracted === 2 && fs.existsSync(path.join(tmp, 'calculator repo/main.py')));
check('nested root DETECTED and reported', ex1.nestedRoot === 'calculator repo' && ex1.flattened === false, ex1.note?.slice(0, 60));

const ex2 = await extractArchive(ws, 'calc.zip', { dest: 'flat', flatten: true });
check('flatten:true strips the nested root', ex2.flattened === true && fs.existsSync(path.join(tmp, 'flat/main.py')));

// skip-existing behavior
fs.writeFileSync(path.join(tmp, 'flat/main.py'), 'MODIFIED');
const ex3 = await extractArchive(ws, 'calc.zip', { dest: 'flat', flatten: true });
check('existing files skipped without overwrite', ex3.extracted === 0 && ex3.skippedExisting === 2 && fs.readFileSync(path.join(tmp, 'flat/main.py'), 'utf8') === 'MODIFIED');

// zip-slip guard
const evilZip = makeZip([['../../evil.txt', Buffer.from('x')]]);
fs.writeFileSync(path.join(tmp, 'evil.zip'), evilZip);
let slipped = false;
try { await extractArchive(ws, 'evil.zip', { dest: '.' }); } catch (e) { slipped = e instanceof FsError && /escapes/.test(e.message); }
check('zip-slip member rejected', slipped && !fs.existsSync(path.join(tmp, '..', 'evil.txt')));

// --- tar.gz path ---
const tarMembers = [['app/index.html', Buffer.from('<h1>x</h1>')], ['app/app.js', Buffer.from('console.log(1)')]];
function makeTar(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('000644\0', 100, 8, 'utf8');
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    h[156] = 48; // typeflag '0'
    h.write('ustar\0', 257, 6, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const tgz = zlib.gzipSync(makeTar(tarMembers));
fs.writeFileSync(path.join(tmp, 'bundle.tgz'), tgz);
const ex4 = await extractArchive(ws, 'bundle.tgz', { dest: 'fromtar', flatten: true });
check('tar.gz extracted + flattened', ex4.extracted === 2 && fs.existsSync(path.join(tmp, 'fromtar/index.html')), `nestedRoot=${ex4.nestedRoot}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILURES` : '\nAll fsapi checks passed');
process.exit(failed ? 1 : 0);
