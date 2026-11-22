// Unified diff generation for file-write previews (Milestone 1).
// Dependency-free Myers-style LCS diff over lines, emitting a standard
// unified diff with @@ hunk headers and 3 lines of context. Used by the
// /diff/preview endpoint (agent sees the proposed change BEFORE approving)
// and by concise post-edit confirmations.
export function unifiedDiff(oldText, newText, { from = 'a/' + 'current', to = 'b/' + 'proposed', contextLines = 3, maxHunks = 40 } = {}) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  // Trailing newline handling: "x\n".split('\n') = ['x','']; treat the final
  // empty element as "no newline" marker consistent with unified diff output.
  if (a.length > 1 && a[a.length - 1] === '') a.pop();
  if (b.length > 1 && b[b.length - 1] === '') b.pop();

  const ops = diffOps(a, b); // list of {type:'same'|'del'|'add', line, aLine, bLine}
  const hunks = buildHunks(ops, contextLines);
  if (!hunks.length) return { diff: '', changed: 0, added: 0, removed: 0, truncated: false };

  let added = 0, removed = 0;
  const out = [`--- ${from}`, `+++ ${to}`];
  let truncated = false;
  let hunkCount = 0;
  for (const h of hunks) {
    if (hunkCount >= maxHunks) { truncated = true; break; }
    hunkCount++;
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    for (const op of h.ops) {
      if (op.type === 'same') out.push(' ' + op.line);
      else if (op.type === 'del') { out.push('-' + op.line); removed++; }
      else { out.push('+' + op.line); added++; }
    }
  }
  return { diff: out.join('\n'), changed: added + removed, added, removed, truncated };
}

// LCS via dynamic programming over line hashes. Inputs are already capped
// upstream (files > 2MB are rejected by readFileContent), so worst case
// stays bounded; for very large equal regions the diagonal shortcut keeps
// it fast in practice.
function diffOps(a, b) {
  const n = a.length, m = b.length;
  // Trim common prefix/suffix first (keeps the DP table small for small edits
  // inside large files — the common agent case).
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n, endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', line: a[i] });
  // DP LCS
  const N = midA.length, M = midB.length;
  if (N === 0 || M === 0) {
    for (const line of midA) ops.push({ type: 'del', line });
    for (const line of midB) ops.push({ type: 'add', line });
  } else if (N * M > 4_000_000) {
    // Too large for DP: emit a whole-block replace instead of hanging.
    for (const line of midA) ops.push({ type: 'del', line });
    for (const line of midB) ops.push({ type: 'add', line });
  } else {
    const dp = new Int32Array((N + 1) * (M + 1));
    const w = M + 1;
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (midA[i] === midB[j]) { ops.push({ type: 'same', line: midA[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ type: 'del', line: midA[i] }); i++; }
      else { ops.push({ type: 'add', line: midB[j] }); j++; }
    }
    while (i < N) { ops.push({ type: 'del', line: midA[i] }); i++; }
    while (j < M) { ops.push({ type: 'add', line: midB[j] }); j++; }
  }
  for (let k = endA; k < n; k++) ops.push({ type: 'same', line: a[k] });
  return ops;
}

function buildHunks(ops, ctx) {
  // Group change regions with up to `ctx` lines of surrounding context.
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'same') { i++; continue; }
    // find the run of changes [i, j)
    let j = i;
    while (j < ops.length && ops[j].type !== 'same') j++;
    // extend with context
    const start = Math.max(0, i - ctx);
    const end = Math.min(ops.length, j + ctx);
    // merge with the previous hunk when context ranges overlap
    const last = hunks[hunks.length - 1];
    if (last && start <= last.endAbs) {
      for (let k = last.endAbs; k < end; k++) last.ops.push(ops[k]);
      last.endAbs = end;
    } else {
      hunks.push({ startAbs: start, endAbs: end, ops: ops.slice(start, end) });
    }
    i = j;
  }
  for (const h of hunks) {
    let aStart = 1, bStart = 1;
    for (let k = 0; k < h.startAbs; k++) {
      if (ops[k].type !== 'add') aStart++;
      if (ops[k].type !== 'del') bStart++;
    }
    h.aStart = aStart; h.bStart = bStart;
    h.aLen = h.ops.filter((o) => o.type !== 'add').length;
    h.bLen = h.ops.filter((o) => o.type !== 'del').length;
    delete h.startAbs; delete h.endAbs;
  }
  return hunks;
}
