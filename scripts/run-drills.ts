// Reliability drill runner (Forge upgrade — Part 2). Executes the eight
// tool-reliability drills from src/lib/agent/drills.ts against a REAL
// companion (paired, token required) and writes one evidence file per pass —
// a new pass never overwrites a previous one (ALS rule).
//
// Usage:
//   bun scripts/run-drills.ts --base http://127.0.0.1:7337 --token <TOK> --workspace /path [--model m] [--out dir]
// Token: shown by the companion console / stored by the IDE. Workspaces are
// authorized on demand; the drill runs in a scratch subfolder and cleans up.
import { CompanionClient } from '../src/lib/companion/client';
import { runDrills, type DrillHost, type DrillReport } from '../src/lib/agent/drills';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = arg('base') || 'http://127.0.0.1:7337';
const token = arg('token') || process.env.LF_TOKEN || '';
const workspacePath = arg('workspace');
const model = arg('model');
const provider = arg('provider');
const outDir = arg('out') || path.join(process.cwd(), 'drill-evidence');

if (!token) {
  console.error('Missing --token (or LF_TOKEN env). The companion only accepts paired calls.');
  process.exit(2);
}

const cfg = {
  mode: 'direct' as const,
  directUrl: base,
  remoteUrl: base,
  gatewayPort: 7337,
  token,
};
const client = new CompanionClient(() => cfg);

async function main() {
  const health = await client.health();
  console.log(`companion: ${health.name} v${health.version} on ${health.platform} (${health.resources?.cpus ?? '?'} cpus)`);

  let wsId: string;
  if (workspacePath) {
    const r = await client.openWorkspace(workspacePath);
    wsId = r.workspace.id;
    console.log(`workspace: ${r.workspace.path} (${wsId})`);
  } else {
    const list = await client.listWorkspaces();
    if (!list.workspaces.length) {
      console.error('No authorized workspaces on this companion. Pass --workspace /absolute/path.');
      process.exit(2);
    }
    wsId = list.workspaces[0].id;
    console.log(`workspace: ${list.workspaces[0].path} (${wsId}) [first authorized]`);
  }

  const host: DrillHost = {
    label: `companion ${base} ws=${wsId}`,
    listDir: async (p) => {
      const rel = (!p || p === '.') ? '' : p.replace(/^\.\//, '').replace(/\/+$/, '');
      const t = await client.tree(wsId, 8);
      const prefix = rel ? rel + '/' : '';
      return t.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
        .map((e) => ({ path: e.path.slice(prefix.length), type: e.type, size: e.size }));
    },
    readFile: async (p) => {
      const f = await client.readFile(wsId, p);
      return { content: f.content, size: f.size };
    },
    writeFile: async (p, c) => client.writeFile(wsId, p, c),
    deletePath: async (p) => { await client.deletePath(wsId, p, true); },
    exec: async (cmd) => {
      const r = await client.exec(wsId, cmd, { timeoutMs: 60000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    stat: async (p) => client.statPath(wsId, p),
    search: async (q) => (await client.search(wsId, q, {})).results,
  };

  console.log('running drills…');
  const report: DrillReport = await runDrills(host, { model, provider });
  console.log(`\n${report.score}`);
  for (const s of report.steps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.drill} / ${s.step} (${s.durMs}ms)${s.ok ? '' : ` — ${s.detail}`}`);
  console.log(report.recommendation);

  // One evidence file per pass; never overwrite a previous pass (ALS rule).
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `drill-${stamp}${model ? '-' + model.replace(/[^\w.-]+/g, '_') : ''}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`evidence written: ${file}`);
}

main().catch((e) => {
  console.error('drill run failed:', e?.message ?? e);
  process.exit(1);
});
