import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSavedNetwork, readSavedNetwork } from '../src/config.js';

test('a saved Windows network.json supplies the bind address when no host flag is present', () => {
  assert.deepEqual(parseSavedNetwork({ host: '0.0.0.0', port: 7337, lanEnabled: true }), { host: '0.0.0.0', lan: true });
  assert.deepEqual(parseSavedNetwork({ host: '127.0.0.1', lanEnabled: false }), { host: '127.0.0.1', lan: false });
  assert.equal(parseSavedNetwork({ host: 'bad host' }), null);
  assert.equal(parseSavedNetwork(null), null);
  if (process.platform !== 'win32') {
    assert.equal(readSavedNetwork(os.tmpdir()), null);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-net-'));
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({ host: '0.0.0.0', port: 7337, lanEnabled: true }));
  assert.deepEqual(readSavedNetwork(dir), { host: '0.0.0.0', lan: true });
});
