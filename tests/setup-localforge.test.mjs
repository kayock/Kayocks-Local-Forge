import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReleaseInstaller, isTrustedInstallerAsset, parseSha256Sums } from '../scripts/setup-localforge.mjs';

const url = 'https://github.com/kayock/Kayocks-Local-Forge/releases/download/v0.5.0-rc4/LocalForge-Companion-Setup-0.5.0.exe';
const asset = { name: 'LocalForge-Companion-Setup-0.5.0.exe', browser_download_url: url };

test('only accepts Windows installers hosted on the project GitHub releases', () => {
  assert.ok(isTrustedInstallerAsset(asset));
  assert.equal(isTrustedInstallerAsset({ ...asset, browser_download_url: 'https://example.org/bad.exe' }), false);
  assert.equal(isTrustedInstallerAsset({ ...asset, name: 'other.exe' }), false);
  assert.equal(isTrustedInstallerAsset({ ...asset, browser_download_url: url + '?foo=bar' }), false);
});

test('selects latest published release with an actual installer, including prereleases', () => {
  const selected = chooseReleaseInstaller([
    { published_at: '2026-11-21T00:00:00Z', assets: [asset] },
    { published_at: '2026-11-25T00:00:00Z', draft: true, assets: [asset] },
    { published_at: '2026-11-24T00:00:00Z', assets: [{ name: 'README.txt', browser_download_url: url }] },
    { published_at: '2026-11-23T00:00:00Z', prerelease: true, assets: [asset] },
  ]);
  assert.equal(selected.release.published_at, '2026-11-23T00:00:00Z');
  assert.equal(selected.asset.browser_download_url, url);
  assert.equal(chooseReleaseInstaller([{ draft: true, assets: [asset] }]), null);
});

test('checksum file parser checks the exact installer filename', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseSha256Sums(hash + '  ' + asset.name + '\n', asset.name), hash);
  assert.equal(parseSha256Sums(hash + ' *' + asset.name + '\n', asset.name), hash);
  assert.equal(parseSha256Sums(hash + '  other.exe\n', asset.name), null);
});
