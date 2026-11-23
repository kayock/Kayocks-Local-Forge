#!/usr/bin/env node
/**
 * Explicit, cross-platform LocalForge source setup.
 * Windows: downloads, SHA-256 verifies, then offers the native Companion installer.
 * Linux/macOS: installs Companion dependencies from this checked-out source.
 * Never starts a background service, replaces user state, or bypasses the OS installer UI.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com/repos/kayock/Kayocks-Local-Forge/releases?per_page=30';
const ASSET_PREFIX = 'https://github.com/kayock/Kayocks-Local-Forge/releases/download/';
const PINNED = {
  name: 'LocalForge-Companion-Setup-0.5.0.exe',
  url: ASSET_PREFIX + 'v0.5.0-rc4/LocalForge-Companion-Setup-0.5.0.exe',
  sha256: 'a0bf369e2c99e4f37257f4577becffb06737d2b0e3cc49f988dd19b3df459f1f',
};

export function isTrustedInstallerAsset(asset) {
  return Boolean(
    asset &&
    /^LocalForge-Companion-Setup-[\w.-]+\.exe$/i.test(asset.name) &&
    typeof asset.browser_download_url === 'string' &&
    asset.browser_download_url.startsWith(ASSET_PREFIX) &&
    asset.browser_download_url.endsWith('/' + asset.name),
  );
}

export function chooseReleaseInstaller(releases) {
  if (!Array.isArray(releases)) return null;
  for (const release of [...releases]
    .filter((entry) => entry && !entry.draft && entry.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))) {
    const asset = release.assets?.find(isTrustedInstallerAsset);
    if (asset) {
      return { asset, release };
    }
  }
  return null;
}

export function parseSha256Sums(contents, filename) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'LocalForge-Setup' };

async function getText(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + url);
  return response.text();
}

async function resolveWindowsInstaller() {
  try {
    const releases = JSON.parse(await getText(API));
    const found = chooseReleaseInstaller(releases);
    if (!found) throw new Error('No published Windows installer found.');
    const { asset, release } = found;
    let sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase();
    if (!sha256) {
      const sums = release.assets?.find((entry) =>
        entry.name === 'SHA256SUMS.txt' &&
        typeof entry.browser_download_url === 'string' &&
        entry.browser_download_url.startsWith(ASSET_PREFIX),
      );
      if (sums) sha256 = parseSha256Sums(await getText(sums.browser_download_url), asset.name);
    }
    if (!sha256) throw new Error('Latest installer does not have a published SHA-256 checksum.');
    return { name: asset.name, url: asset.browser_download_url, sha256 };
  } catch (error) {
    console.warn('Could not verify the newest GitHub release (' + error.message + ').');
    console.warn('Using the known SHA-256-pinned v0.5.0 RC4 installer.');
    return PINNED;
  }
}

function run(command, args, cwd = ROOT) {
  // Windows npm is a .cmd wrapper and cannot be spawned directly without cmd.exe.
  const isWindowsNpm = process.platform === 'win32' && (command === 'npm' || command === 'npm.cmd');
  const executable = isWindowsNpm ? (process.env.ComSpec || 'cmd.exe') : command;
  const invocation = isWindowsNpm ? ['/d', '/s', '/c', 'npm', ...args] : args;
  const result = spawnSync(executable, invocation, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
}

async function confirm(message) {
  if (!process.stdin.isTTY) throw new Error('Interactive confirmation required. Run this in a terminal, or pass --yes explicitly.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(message + ' [y/N] ')).trim());
  } finally {
    prompt.close();
  }
}

async function setupWindows({ yes, upgrade }) {
  if (process.arch !== 'x64') throw new Error('The packaged Windows Companion supports x64; see companion/README.md for source installation.');
  const appData = process.env.LOCALAPPDATA;
  const installed = appData && existsSync(join(appData, 'Programs', 'LocalForge Companion', 'LocalForgeCompanion', 'localforge-companion.exe'));
  if (installed && !upgrade) {
    console.log('Windows Companion is already installed. Preserving it and its settings.');
    console.log('To explicitly request a newer installer: npm run setup -- --upgrade');
    return;
  }
  if (!yes && !(await confirm(installed ? 'Download and run an updated Windows Companion installer?' : 'Download and run the Windows Companion installer?'))) {
    console.log('Companion installation skipped. The IDE can be used once a Companion is available.');
    return;
  }

  const asset = await resolveWindowsInstaller();
  const tempDir = await mkdtemp(join(tmpdir(), 'localforge-setup-'));
  const target = join(tempDir, asset.name);
  try {
    console.log('Downloading ' + asset.name + ' from GitHub Releases...');
    const response = await fetch(asset.url, { headers, signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('Installer download failed: HTTP ' + response.status);
    const sha256 = createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({ transform(chunk, _encoding, callback) { sha256.update(chunk); callback(null, chunk); } }),
      createWriteStream(target, { flags: 'wx' }),
    );
    if (sha256.digest('hex') !== asset.sha256) throw new Error('Installer SHA-256 mismatch. Refusing to execute downloaded file.');
    console.log('SHA-256 verified. Launching the Windows installer (unsigned; Windows will ask for confirmation).');
    run(target, []);
    console.log('Installer exited successfully. Launch LocalForge Companion from the Start Menu to get your pairing code.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function setupSourceCompanion(upgrade) {
  const installed = existsSync(join(ROOT, 'companion', 'node_modules', 'ws', 'package.json'));
  if (installed && !upgrade) {
    console.log('Source Companion dependencies already installed; preserving existing setup.');
    return;
  }
  console.log('Installing the local Companion from this repository (no global install or service)...');
  run('npm', ['ci', '--prefix', 'companion', '--no-audit', '--no-fund']);
  console.log('Source Companion ready. Start it with: npm run companion:start');
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--yes', '--upgrade', '--companion-only']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error('Unknown option ' + arg + '. Options: --yes, --upgrade, --companion-only');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const yes = args.includes('--yes'), upgrade = args.includes('--upgrade');
  if (!args.includes('--companion-only')) {
    const ready = existsSync(join(ROOT, 'node_modules', 'next', 'package.json'));
    if (!ready) {
      console.log('Installing LocalForge IDE dependencies...');
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund']);
    } else {
      console.log('IDE dependencies already present; leaving them unchanged.');
    }
    const envPath = join(ROOT, '.env');
    if (!existsSync(envPath)) {
      copyFileSync(join(ROOT, '.env.example'), envPath, constants.COPYFILE_EXCL);
      console.log('Created .env from .env.example; existing .env is never replaced.');
    }
    mkdirSync(join(ROOT, 'db'), { recursive: true });
  }

  if (process.platform === 'win32') await setupWindows({ yes, upgrade });
  else if (process.platform === 'linux' || process.platform === 'darwin') setupSourceCompanion(upgrade);
  else throw new Error('Unsupported platform ' + process.platform);

  console.log('\nNext steps:');
  if (process.platform === 'win32') console.log('  Start LocalForge Companion from the Start Menu (if not already running).');
  else console.log('  In one terminal: npm run companion:start');
  if (!args.includes('--companion-only')) {
    console.log('  For a new self-hosted IDE database: npx prisma db push (only after reviewing your database settings).');
    console.log('  In another terminal: npm run dev');
  }
  console.log('  Open http://localhost:3000/#/ide and enter the Companion pairing code.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('LocalForge setup failed: ' + error.message);
    process.exitCode = 1;
  });
}
