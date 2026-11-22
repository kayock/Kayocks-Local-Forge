// Regression tests for the workspace and preview boundary repairs.
// All paths are temporary; no user project files or running services touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FsError, writeFileContent, appendFileContent, makeDir, renamePath,
  statPath, readFileContent, extractArchive,
} from '../src/fsapi.js';
import { mintPreviewToken, handlePreview } from '../src/preview.js';

async function withWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'localforge-fs-boundary-'));
  const root = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  try { await fn({ root, outside, ws: { id: 'test-ws', path: root } }); }
  finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

function expectBoundary(promise) {
  return assert.rejects(promise, (error) => error instanceof FsError && error.status === 400);
}

function makeZip(name, content) {
  // Tiny stored ZIP containing exactly one file. No external dependencies.
  const n = Buffer.from(name);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(n.length, 26);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(data.length, 20);
  central.writeUInt16LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const centralOffset = local.length + n.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, n, data, central, n, eocd]);
}

test('file write, append and directory creation reject outside symlinked parents', async () => {
  await withWorkspace(async ({ ws, root, outside }) => {
    await fsp.symlink(outside, path.join(root, 'link'), 'dir');
    await expectBoundary(writeFileContent(ws, 'link/nested/new.txt', 'escape'));
    await expectBoundary(appendFileContent(ws, 'link/nested/new.txt', 'escape'));
    await expectBoundary(makeDir(ws, 'link/nested/new-dir'));
    assert.equal(fs.existsSync(path.join(outside, 'nested')), false);
    await writeFileContent(ws, 'safe/sub/new.txt', 'inside');
    await appendFileContent(ws, 'safe/sub/new.txt', ' ok');
    assert.equal(await fsp.readFile(path.join(root, 'safe/sub/new.txt'), 'utf8'), 'inside ok');
  });
});

test('read and metadata reject symlinks to outside files', async () => {
  await withWorkspace(async ({ ws, root, outside }) => {
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'do-not-read');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'));
    await expectBoundary(readFileContent(ws, 'secret.txt'));
    await expectBoundary(statPath(ws, 'secret.txt'));
  });
});

test('rename rejects symlink targets and prevents silent overwrite of an existing file', async () => {
  await withWorkspace(async ({ ws, root, outside }) => {
    await fsp.symlink(outside, path.join(root, 'link'), 'dir');
    await fsp.writeFile(path.join(root, 'from.txt'), 'from');
    await expectBoundary(renamePath(ws, 'from.txt', 'link/new.txt'));
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
    await fsp.writeFile(path.join(root, 'to.txt'), 'original');
    await assert.rejects(renamePath(ws, 'from.txt', 'to.txt'), (e) => e instanceof FsError && e.status === 409);
    assert.equal(await fsp.readFile(path.join(root, 'to.txt'), 'utf8'), 'original');
    assert.equal(await fsp.readFile(path.join(root, 'from.txt'), 'utf8'), 'from');
    await renamePath(ws, 'from.txt', 'moved.txt');
    assert.equal(await fsp.readFile(path.join(root, 'moved.txt'), 'utf8'), 'from');
  });
});

test('ZIP extraction rejects symlink destinations and traversal member names', async () => {
  await withWorkspace(async ({ ws, root, outside }) => {
    await fsp.symlink(outside, path.join(root, 'link'), 'dir');
    await fsp.writeFile(path.join(root, 'good.zip'), makeZip('hello.txt', 'world'));
    await expectBoundary(extractArchive(ws, 'good.zip', { dest: 'link' }));
    await fsp.writeFile(path.join(root, 'evil.zip'), makeZip('../outside.txt', 'attack'));
    await expectBoundary(extractArchive(ws, 'evil.zip'));
    assert.equal(fs.existsSync(path.join(outside, 'hello.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
    const safe = await extractArchive(ws, 'good.zip', { dest: 'safe' });
    assert.equal(safe.extracted, 1);
    assert.equal(await fsp.readFile(path.join(root, 'safe/hello.txt'), 'utf8'), 'world');
  });
});

test('static preview refuses files outside its preview directory', async () => {
  await withWorkspace(async ({ ws, root, outside }) => {
    await fsp.mkdir(path.join(root, 'dist'));
    await fsp.writeFile(path.join(root, 'dist', 'index.html'), '<h1>safe</h1>');
    await fsp.writeFile(path.join(outside, 'leak.txt'), 'outside-private-data');
    await fsp.symlink(path.join(outside, 'leak.txt'), path.join(root, 'dist', 'leak.txt'));
    const ptok = mintPreviewToken(ws.id);
    const request = async (filename) => {
      const headers = {};
      const res = {
        status: null, body: '',
        writeHead(status, h = {}) { this.status = status; Object.assign(headers, h); },
        end(data = '') { this.body = String(data); },
      };
      await handlePreview({}, res, new URL(`http://localhost/preview/${ws.id}/${ptok}/${filename}`), {
        ...ws, previewDir: 'dist',
      });
      return res;
    };
    const denied = await request('leak.txt');
    assert.equal(denied.status, 400);
    assert.doesNotMatch(denied.body, /outside-private-data/);
    const allowed = await request('index.html');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, '<h1>safe</h1>');
  });
});
