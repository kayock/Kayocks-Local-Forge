import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the Windows companion compile embeds localforgeRelease, not the numeric installer version', () => {
  const sh = fs.readFileSync(new URL('../installer/windows/build-windows.sh', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../companion/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.localforgeRelease, '0.5.0-rc6');
  assert.match(sh, /localforgeRelease/);
  const define = sh.split('\n').find((line) => line.includes('LOCALFORGE_COMPANION_VERSION'));
  assert.ok(define, 'compile define missing');
  assert.match(define, /\$\{REL\}/);
  assert.doesNotMatch(define, /\$\{VER\}/);
});
