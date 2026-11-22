// Read-only, best-effort inventory. A missing GPU utility means 'unknown', not 'no GPU'.
import os from 'node:os';
import { reportPlatform } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const cap = (n) => Math.max(0, Number(n) || 0);

async function run(bin, args = []) {
  try {
    const { stdout } = await exec(bin, args, { timeout: 3500, maxBuffer: 256 * 1024, windowsHide: true });
    return stdout.trim();
  } catch { return ''; }
}

export async function hardwareInventory() {
  const cpu = os.cpus();
  const gpus = [];
  const nvidia = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (nvidia) for (const line of nvidia.split(/\r?\n/)) {
    const bits = line.split(',').map((s) => s.trim());
    if (bits[0]) gpus.push({ kind: 'nvidia', name: bits[0], vramBytes: Number.isFinite(+bits[1]) ? Math.round(+bits[1] * 1024 ** 2) : null, driver: bits[2] || null });
  }
  if (process.platform === 'darwin' && !gpus.length) {
    const info = await run('system_profiler', ['SPDisplaysDataType']);
    for (const m of info.matchAll(/Chipset Model:\s*(.+)/g)) gpus.push({ kind: 'apple', name: m[1].trim(), vramBytes: null, driver: null });
  }
  if (process.platform === 'linux' && !gpus.length) {
    const pci = await run('lspci', ['-nn']);
    for (const line of pci.split('\n')) {
      if (!/(vga compatible controller|3d controller|display controller)/i.test(line)) continue;
      const kind = /intel/i.test(line) ? 'intel' : /amd|ati/i.test(line) ? 'amd' : /nvidia/i.test(line) ? 'nvidia' : 'other';
      gpus.push({ kind, name: line.replace(/^.*?:\s*/, '').slice(0, 200), vramBytes: null, driver: null });
    }
  }
  if (process.platform === 'win32' && !gpus.length) {
    const lines = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "`n"']);
    for (const name of lines.split(/\r?\n/).filter(Boolean)) {
      const kind = /intel/i.test(name) ? 'intel' : /amd|radeon/i.test(name) ? 'amd' : /nvidia/i.test(name) ? 'nvidia' : 'other';
      gpus.push({ kind, name: name.trim(), vramBytes: null, driver: null });
    }
  }
  return {
    platform: reportPlatform(), platformVersion: os.release(), arch: process.arch,
    hostname: os.hostname(), cpuModel: cpu[0]?.model || null, cpuCores: cpu.length,
    ramTotalBytes: cap(os.totalmem()), ramAvailableBytes: cap(os.freemem()),
    gpus, npu: { detected: false, runtime: null, detail: 'Not probed; absence is not verified' },
    inferenceRuntimes: [], measuredAt: Date.now(),
  };
}
