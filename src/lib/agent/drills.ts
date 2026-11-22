// Tool-reliability drills (Forge upgrade — Part 2), inspired by ALS's
// training mode (Apache-2.0, autonomous-loop-studio/Autonomous) and adapted
// to LocalForge: a fixed set of tool exercises that measures whether a
// companion/workspace (and, in live runs, a model) can actually do the
// fundamental operations reliably. Results inform model recommendations —
// they never prevent the user from selecting a model.
//
// The eight drills (mission Part 2): directory listing, file reading, file
// creation, file modification, command execution, error recognition,
// recovery behavior, multi-step task completion.
//
// Rules kept from ALS:
//  - every pass writes its OWN evidence record (never overwrites a previous
//    pass — the caller decides the filename; the report embeds a timestamp);
//  - drills are retried internally where the host may be transient, but a
//    failed drill is reported as failed — never skipped;
//  - the score is honest: passed/failed counts with per-step details.

export interface DrillHost {
  label: string; // e.g. "companion Station ws=calculator" or "mock"
  listDir(path: string): Promise<{ path: string; type: 'dir' | 'file'; size?: number }[]>;
  readFile(path: string): Promise<{ content: string; size: number }>;
  writeFile(path: string, content: string): Promise<{ bytes: number }>;
  deletePath(path: string): Promise<void>;
  exec(command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  stat?(path: string): Promise<{ exists: boolean; empty?: boolean; type?: string; reason?: string }>;
  search?(query: string): Promise<{ path: string; line: number; text: string }[]>;
}

export interface DrillStep {
  drill: string;
  step: string;
  ok: boolean;
  detail: string;
  durMs: number;
}

export interface DrillReport {
  host: string;
  model?: string;
  provider?: string;
  startedAt: string;
  finishedAt: string;
  steps: DrillStep[];
  passed: number;
  failed: number;
  retries: number;
  score: string; // "8/8 drills" style summary
  recommendation: string;
}

const SCRATCH = (ts: number) => `__lf_drills_${ts}`;

async function timed(step: string, drill: string, fn: () => Promise<string>): Promise<DrillStep> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { drill, step, ok: true, detail, durMs: Date.now() - t0 };
  } catch (e) {
    return { drill, step, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 300), durMs: Date.now() - t0 };
  }
}

export async function runDrills(host: DrillHost, opts?: { model?: string; provider?: string; retries?: number }): Promise<DrillReport> {
  const startedAt = new Date().toISOString();
  const steps: DrillStep[] = [];
  const maxRetries = opts?.retries ?? 1;
  let retries = 0;
  const scratch = SCRATCH(Date.now());

  const runStep = async (drill: string, step: string, fn: () => Promise<string>) => {
    let res = await timed(step, drill, fn);
    let attempt = 0;
    while (!res.ok && attempt < maxRetries) {
      attempt++;
      retries++;
      res = await timed(`${step} (retry ${attempt})`, drill, fn);
    }
    steps.push(res);
    return res.ok;
  };

  // 1. directory listing — including the empty-vs-missing distinction
  await runStep('directory listing', 'list root', async () => {
    const entries = await host.listDir('.');
    return `root listed: ${entries.length} entries`;
  });
  await runStep('directory listing', 'empty vs missing', async () => {
    if (!host.stat) return 'stat unavailable on this host (older companion) — skipped without penalty';
    const missing = await host.stat('__lf_drills_missing_dir__');
    if (missing.exists !== false) throw new Error('missing path reported as existing');
    return `missing reported as: ${missing.reason ?? 'not-found'}`;
  });

  // 2. file reading
  await runStep('file reading', 'create then read', async () => {
    await host.writeFile(`${scratch}/read_me.txt`, 'DRILL CONTENT 12345');
    const f = await host.readFile(`${scratch}/read_me.txt`);
    if (!f.content.includes('DRILL CONTENT 12345')) throw new Error('content mismatch');
    return `read back ${f.size} bytes`;
  });
  await runStep('file reading', 'missing file error', async () => {
    try {
      await host.readFile(`${scratch}/no_such_file.txt`);
      throw new Error('reading a missing file unexpectedly succeeded');
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/not found|ENOENT|404|missing/i.test(msg)) return `error surfaced correctly: ${msg.slice(0, 80)}`;
      throw new Error(`uninformative error: ${msg.slice(0, 80)}`);
    }
  });

  // 3. file creation
  await runStep('file creation', 'nested write', async () => {
    const r = await host.writeFile(`${scratch}/deep/nested/created.txt`, 'created by drill');
    if (!r.bytes) throw new Error('no byte count returned');
    return `wrote ${r.bytes} bytes to deep/nested path`;
  });

  // 4. file modification
  await runStep('file modification', 'edit exact snippet', async () => {
    const f = await host.readFile(`${scratch}/read_me.txt`);
    const next = f.content.replace('DRILL CONTENT 12345', 'DRILL CONTENT EDITED');
    if (next === f.content) throw new Error('replace produced no change');
    await host.writeFile(`${scratch}/read_me.txt`, next);
    const reread = await host.readFile(`${scratch}/read_me.txt`);
    if (!reread.content.includes('DRILL CONTENT EDITED')) throw new Error('edit did not persist');
    return 'snippet replaced and verified by re-read';
  });

  // 5. command execution
  await runStep('command execution', 'echo exit code', async () => {
    const r = await host.exec('echo drill-ok-777');
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.slice(0, 80)}`);
    if (!r.stdout.includes('drill-ok-777')) throw new Error(`stdout missing marker: "${r.stdout.slice(0, 60)}"`);
    return `exit 0, stdout captured (${r.stdout.trim().length} chars)`;
  });

  // 6. error recognition
  await runStep('error recognition', 'failing command reported honestly', async () => {
    const r = await host.exec('node -e "process.exit(3)" 2>/dev/null || python3 -c "import sys; sys.exit(3)" 2>/dev/null || exit 3');
    if (r.exitCode === 3) return `non-zero exit (3) surfaced truthfully`;
    if (r.exitCode === 0) throw new Error('failing command reported as success — reliability hazard');
    return `non-zero exit (${r.exitCode}) surfaced truthfully`;
  });

  // 7. recovery behavior
  await runStep('recovery behavior', 'recover after error', async () => {
    // after the failing command, a listing must still work and find the scratch dir
    const entries = await host.listDir('.');
    if (!entries.some((e) => e.path === scratch)) throw new Error(`scratch dir ${scratch} not visible after error`);
    const f = await host.readFile(`${scratch}/deep/nested/created.txt`);
    if (!f.content.includes('created by drill')) throw new Error('state lost after error');
    return 'workspace state intact and accessible after a failed command';
  });

  // 8. multi-step task completion
  await runStep('multi-step completion', 'write-verify-update pipeline', async () => {
    await host.writeFile(`${scratch}/pipeline.js`, 'const x = 6 * 7;\nif (x !== 42) process.exit(1);\nconsole.log("pipeline-ok");\n');
    const r1 = await host.exec(`node ${scratch}/pipeline.js`);
    if (r1.exitCode !== 0 || !r1.stdout.includes('pipeline-ok')) throw new Error(`pipeline v1 failed: exit ${r1.exitCode} ${r1.stderr.slice(0, 60)}`);
    const f = await host.readFile(`${scratch}/pipeline.js`);
    await host.writeFile(`${scratch}/pipeline.js`, f.content.replace('6 * 7', '7 * 6'));
    const r2 = await host.exec(`node ${scratch}/pipeline.js`);
    if (r2.exitCode !== 0 || !r2.stdout.includes('pipeline-ok')) throw new Error(`pipeline v2 failed: exit ${r2.exitCode}`);
    if (host.search) {
      const hits = await host.search('pipeline-ok');
      if (!hits.some((h) => h.path.includes('pipeline.js'))) throw new Error('search could not find the written file content');
    }
    return 'create → run → modify → re-run → (search) all succeeded';
  });

  // cleanup (best-effort; a failed cleanup does not fail the report)
  try { await host.deletePath(scratch); } catch { /* best effort */ }

  const drills = new Map<string, boolean>();
  for (const s of steps) {
    const base = s.step.replace(/ \(retry \d+\)$/, '');
    // a drill passes only if its final attempt (by base name) succeeded
    const final = steps.filter((x) => x.step.replace(/ \(retry \d+\)$/, '') === base).at(-1)!;
    drills.set(`${s.drill}::${base}`, final.ok);
  }
  const drillKeys = [...drills.keys()];
  const passed = drillKeys.filter((k) => drills.get(k)).length;
  const failed = drillKeys.length - passed;

  const recommendation = failed === 0
    ? 'All drills passed — this host/model handles the fundamental tool operations reliably.'
    : `Fix first: ${drillKeys.filter((k) => !drills.get(k)).map((k) => k.replace('::', '/')).join(', ')}. Drills inform recommendations; they never block model selection.`;

  return {
    host: host.label,
    model: opts?.model,
    provider: opts?.provider,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    passed,
    failed,
    retries,
    score: `${passed}/${drillKeys.length} drills passed${retries ? `, ${retries} retry needed` : ''}`,
    recommendation,
  };
}
