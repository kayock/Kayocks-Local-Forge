// The concrete tool set the agent can use against the authorized workspace.
// All file operations go through the companion (path-jailed); all commands go
// through companion exec with the configured approval policy.
//
// One authoritative registry (spec §3.3): the same definitions drive native
// function declarations, text-fallback instructions, argument validation,
// companion execution and the automated tests. Argument normalization accepts
// common model-invented aliases (old_content → find, cmd → command, …) BEFORE
// validation, and validation errors name the exact missing parameter plus the
// aliases that would have been accepted — never a vague "missing path or find".
import type { ToolDef, ToolContext, ToolParam, ProcInfo } from './types';

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s);

// Canonicalize a user/model-supplied relative path: "./src" → "src",
// "src/" → "src", ""/"." → ".". Prevents the classic mismatch where the same
// directory is listed once as "repo" and once as "./repo" (and where a
// leading ./ defeats the workspace tree prefix filter).
export function canonRelPath(p: unknown): string {
  let s = String(p ?? '').trim();
  if (!s) return '.';
  s = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return s || '.';
}

// browser_verify checks may arrive as a JSON string from text-protocol models
function safeParseChecks(raw: string): { selector?: string; contains?: string; minCount?: number; evaluate?: string }[] {
  try {
    const parsed = JSON.parse(repairJsonish(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function repairJsonish(s: string): string {
  return s
    .replace(/,(\s*[\]}])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'([^'\\]*)'/g, '"$1"');
}

function fmtErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Companion(?:Error)?:?\s*/i, '');
}

// ---------------------------------------------------------------------------
// Argument normalization: aliases + legacy shapes → canonical tool schema.
// ---------------------------------------------------------------------------

// Model-invented tool-name aliases → canonical registry names. Small models
// routinely emit e.g. {"tool":"bash"} or {"name":"str_replace_editor"}.
const TOOL_ALIASES: Record<string, string> = {
  ls: 'list_dir', list_files: 'list_dir', list_directory: 'list_dir', dir: 'list_dir', glob_files: 'list_dir',
  cat: 'read_file', open_file: 'read_file', view_file: 'read_file', view: 'read_file',
  write: 'write_file', create_file: 'write_file', save_file: 'write_file', save: 'write_file',
  edit: 'edit_file', replace_in_file: 'edit_file', str_replace_editor: 'edit_file', apply_patch: 'edit_file', patch_file: 'edit_file',
  mkdir: 'create_dir', make_dir: 'create_dir',
  rm: 'delete_path', remove: 'delete_path', remove_path: 'delete_path', delete_file: 'delete_path',
  grep: 'search_project', search: 'search_project', search_files: 'search_project', find_in_files: 'search_project',
  bash: 'run_command', shell: 'run_command', execute_command: 'run_command', run_cmd: 'run_command',
  terminal: 'run_command', exec: 'run_command', execute: 'run_command',
  test: 'run_tests', run_test: 'run_tests', pytest: 'run_tests',
  build: 'run_build', compile: 'run_build',
  install: 'install_dependencies', npm_install: 'install_dependencies',
  done: 'finish', complete: 'finish', task_complete: 'finish',
  start_app: 'launch_app', launch: 'launch_app', start_process: 'launch_app', run_detached: 'launch_app', run_background: 'launch_app',
  unzip: 'extract_archive', untar: 'extract_archive', extract: 'extract_archive', unpack: 'extract_archive', decompress: 'extract_archive',
  ps: 'process_status', process_list: 'process_status', list_processes: 'process_status', proc_status: 'process_status',
  kill_process: 'stop_process', terminate_process: 'stop_process', stop_app: 'stop_process',
};

// Per-parameter aliases. Applied AFTER tool-name resolution; e.g. a model that
// calls edit_file with {path, old_content, new_content} still succeeds.
const PATH_ALIASES = ['file', 'filepath', 'file_path', 'filename', 'file_name', 'target', 'dir', 'directory', 'folder'];
const COMMAND_ALIASES = ['cmd', 'commandline', 'command_line', 'shell_command', 'shell', 'script'];

export function canonicalToolName(name: string): string {
  const n = String(name || '').trim();
  return TOOL_ALIASES[n] ?? n;
}

function paramAliases(tool: string, param: string): string[] {
  if (param === 'path') return PATH_ALIASES;
  if (param === 'command') return COMMAND_ALIASES;
  switch (tool) {
    case 'edit_file':
      if (param === 'find') return ['old_content', 'old_text', 'old_string', 'old', 'search', 'original', 'needle', 'target_text'];
      if (param === 'replace') return ['new_content', 'new_text', 'new_string', 'new', 'replacement', 'updated', 'replace_with'];
      if (param === 'replaceAll') return ['replace_all', 'all'];
      break;
    case 'write_file':
    case 'read_file':
      if (param === 'content') return ['text', 'data', 'contents', 'body', 'code'];
      break;
    case 'search_project':
      if (param === 'query') return ['q', 'pattern', 'text', 'term', 'regex'];
      break;
    case 'run_tests':
    case 'run_build':
      if (param === 'command') return ['test_command', 'build_command'];
      break;
    case 'finish':
      if (param === 'summary') return ['result', 'message', 'report', 'notes'];
      break;
    case 'launch_app':
      if (param === 'command') return ['cmd', 'executable', 'app', 'program'];
      break;
    case 'process_status':
    case 'stop_process':
      if (param === 'id') return ['pid', 'process', 'proc_id', 'process_id'];
      break;
  }
  return [];
}

// Applies tool-name and parameter aliases, then returns canonical args.
// Exported for the runner (both protocols) and the regression tests.
export function normalizeToolArgs(toolName: string, rawArgs: unknown): { tool: string; args: Record<string, any>; aliasesApplied: Record<string, string> } {
  const tool = canonicalToolName(toolName);
  let args: Record<string, any>;
  if (rawArgs == null) args = {};
  else if (typeof rawArgs === 'string') {
    // Some providers deliver arguments as a JSON *string*; recover the object.
    try { args = JSON.parse(rawArgs); } catch { args = { _raw: rawArgs }; }
  } else if (typeof rawArgs === 'object') args = { ...(rawArgs as Record<string, any>) };
  else args = { _raw: String(rawArgs) };
  // Nested stringified args: {"args": "{\"path\": ...}"} appears from double-encoded models
  if (typeof args.args === 'string' && Object.keys(args).length === 1) {
    try { args = JSON.parse(args.args); } catch { /* keep */ }
  }

  const aliasesApplied: Record<string, string> = {};
  const def = CORE_TOOLS.find((t) => t.name === tool);
  const canon = (p: ToolParam) => [p.name, ...paramAliases(tool, p.name)];
  // Any provided key that matches an alias for a declared param is renamed.
  if (def) {
    for (const p of def.params) {
      for (const alias of canon(p)) {
        if (alias === p.name) continue;
        if (args[alias] !== undefined && args[p.name] === undefined) {
          args[p.name] = args[alias];
          aliasesApplied[alias] = p.name;
        }
        delete args[alias];
      }
    }
  }
  return { tool, args, aliasesApplied };
}

// Precise, actionable validation error (spec §3.3): names the exact expected
// parameter, what was received, and the accepted aliases. Returns null when
// the arguments satisfy the schema.
export function validateToolArgs(tool: string, args: Record<string, any>): string | null {
  const def = CORE_TOOLS.find((t) => t.name === tool);
  if (!def) {
    return `Unknown tool "${tool}". Available tools: ${CORE_TOOLS.map((t) => t.name).join(', ')}. Reply again with one of these exact names.`;
  }
  if (args._raw !== undefined) {
    return `The "args" for ${tool} were not valid JSON and could not be parsed: ${cap(String(args._raw), 200)}. Send args as a JSON object, e.g. {"${def.params[0]?.name ?? 'path'}": "..."}.`;
  }
  const missing = def.params.filter((p) => p.required && (args[p.name] === undefined || String(args[p.name] ?? '').trim() === ''));
  if (missing.length) {
    const lines = missing.map((p) => {
      const aliases = paramAliases(tool, p.name);
      return `  - "${p.name}" (${p.type}): ${p.description}${aliases.length ? ` [aliases accepted: ${aliases.join(', ')}]` : ''}`;
    });
    const received = Object.keys(args).filter((k) => k !== '_raw');
    return (
      `Invalid arguments for "${tool}": missing required parameter(s):\n${lines.join('\n')}` +
      (received.length ? `\nArguments received: ${received.map((k) => `${k}=${cap(String(JSON.stringify(args[k]) ?? ''), 60)}`).join(', ')}` : '\nNo arguments were received.') +
      `\nExpected schema for ${tool}: ${def.params.map((p) => `${p.name}${p.required ? '' : '?'}:${p.type}`).join(', ')}.` +
      ` Fix the argument names and repeat the call.`
    );
  }
  // Type sanity for the common primitives (numbers/booleans arrive as strings from text-mode models)
  for (const p of def.params) {
    const v = args[p.name];
    if (v === undefined) continue;
    if (p.type === 'number' && typeof v !== 'number' && !Number.isFinite(Number(v))) {
      return `Invalid arguments for "${tool}": parameter "${p.name}" must be a number, received ${JSON.stringify(v).slice(0, 60)}.`;
    }
    if (p.type === 'boolean' && typeof v !== 'boolean' && !['true', 'false'].includes(String(v))) {
      return `Invalid arguments for "${tool}": parameter "${p.name}" must be a boolean, received ${JSON.stringify(v).slice(0, 60)}.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core tools
// ---------------------------------------------------------------------------

export const CORE_TOOLS: ToolDef[] = [
  {
    name: 'workspace_info',
    description: 'Report the active workspace: its canonical absolute path on the executing machine, the machine/companion handling execution, platform, whether the root exists, and an entry summary. Use this FIRST whenever you are unsure where you are working or a path does not behave as expected.',
    danger: 'safe',
    params: [],
    async run(args, ctx) {
      const meta = ctx.workspaceMeta;
      let rootState = '(unknown)';
      try {
        const rootEntries = await ctx.fs.listDir('.');
        rootState = `${rootEntries.length} top-level entr${rootEntries.length === 1 ? 'y' : 'ies'}`;
      } catch (e) {
        rootState = `root listing failed: ${summarizeError(e)}`;
      }
      let rootAbs = meta?.rootPath || '(companion did not report an absolute path)';
      if (ctx.fs.stat) {
        try {
          const st = await ctx.fs.stat('.');
          rootAbs = st.exists ? `${st.type === 'dir' ? 'directory' : st.type} at ${meta?.rootPath ?? '(absolute path unavailable)'}` : `MISSING: ${st.reason ?? 'does not exist'}`;
        } catch { /* older companion */ }
      }
      const lines = [
        `workspace id: ${meta?.id ?? ctx.workspaceId}`,
        `canonical root (absolute): ${rootAbs}`,
        `machine: ${meta?.machineLabel ?? 'the paired companion'}`,
        `platform: ${meta?.platform ?? 'unknown'}`,
        `root state: ${rootState}`,
        'All tool paths are relative to this root. If a path you expected is missing, list "." to see what actually exists here.',
      ];
      return { output: lines.join('\n') };
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders in a directory of the workspace. Use path "." for the workspace root. Reports MISSING and EMPTY directories differently — trust that distinction.',
    danger: 'safe',
    params: [{ name: 'path', type: 'string', description: 'Directory path relative to workspace root, e.g. "." or "src"', required: true }],
    async run(args, ctx: ToolContext) {
      const p = canonRelPath(args.path ?? '.');
      // Forge upgrade (Problem B): check existence FIRST when the companion
      // supports it, so an empty result can never be mistaken for a missing
      // directory (the calculator regression).
      if (ctx.fs.stat) {
        let st: Awaited<ReturnType<NonNullable<ToolContext['fs']['stat']>>>;
        try {
          st = await ctx.fs.stat(p);
        } catch (e: any) {
          if (String(e?.message || e).includes('404')) st = { exists: false, reason: 'not-found' };
          else st = { exists: false, reason: `stat unavailable: ${summarizeError(e)}` };
        }
        if (!st.exists) {
          return {
            output: `MISSING: "${p}" does not exist in the workspace${st.parentExists === false ? ' (its parent directory is missing too)' : ''}. This is NOT an empty directory. Use workspace_info to see the canonical root, or list "." to see what actually exists. Do NOT retry this exact path.`,
            isError: false,
          };
        }
        if (st.type === 'file') {
          return { output: `"${p}" is a FILE, not a directory (${st.size ?? '?'} bytes). Use read_file on it, or list its parent directory.` };
        }
        if (st.empty === true) {
          return {
            output: `EMPTY: "${p}" exists as a directory but contains 0 entries. This is a successful result — the directory is genuinely empty. Listing it again cannot change that: create the files the task needs (write_file), or work in a different directory.`,
          };
        }
      }
      const entries = await ctx.fs.listDir(p);
      if (!entries.length) {
        // Companion without /stat support: be explicit that this is the
        // ambiguous case instead of presenting it as a fact about the world.
        return { output: `No entries returned for "${p}". Either the directory is empty or it does not exist (this companion cannot distinguish; stat unavailable). Verify with workspace_info or list "." before concluding anything.` };
      }
      const lines = entries
        .map((e) => `${e.type === 'dir' ? '[dir] ' : '[file]'} ${e.path}${e.type === 'file' && e.size != null ? ` (${e.size}B)` : ''}`)
        .join('\n');
      return { output: cap(`Directory listing for ${p}:\n${lines}`, 8000) };
    },
  },
  {
    name: 'extract_archive',
    description: 'Extract a .zip, .tar, .tar.gz or .tgz archive that is inside the workspace into an explicit destination directory. Detects a nested single top-level directory (e.g. "MyProject/MyProject/") and reports it; pass flatten:true ONLY when you want that top-level directory stripped. Never overwrites existing files unless overwrite:true.',
    danger: 'safe',
    params: [
      { name: 'path', type: 'string', description: 'Archive path relative to workspace root', required: true },
      { name: 'dest', type: 'string', description: 'Destination directory relative to workspace root (default ".")' },
      { name: 'flatten', type: 'boolean', description: 'Strip a detected single top-level directory (e.g. "MyProject/MyProject/" → "MyProject/")' },
      { name: 'overwrite', type: 'boolean', description: 'Overwrite existing files (default: skip and report)' },
    ],
    async run(args, ctx) {
      if (!ctx.fs.extractArchive) {
        return { output: 'Error: this companion does not support archive extraction (update the LocalForge Companion), or use run_command with your platform unzip/tar.', isError: true };
      }
      const p = canonRelPath(args.path);
      try {
        const r = await ctx.fs.extractArchive(p, {
          dest: args.dest ? canonRelPath(args.dest) : '.',
          flatten: args.flatten === true || args.flatten === 'true',
          overwrite: args.overwrite === true || args.overwrite === 'true',
        });
        const lines = [
          `Extracted ${r.extracted} file(s) from ${r.archive} into ${r.dest}${r.nestedRoot && !r.flattened ? `/${r.nestedRoot}` : ''} (${r.bytes} bytes, ${r.skippedExisting} existing file(s) skipped).`,
        ];
        if (r.note) lines.push(r.note);
        if (r.sample?.length) lines.push(`Files: ${r.sample.slice(0, 12).join(', ')}${r.sample.length > 12 ? ' …' : ''}`);
        return { output: lines.join('\n'), isError: false };
      } catch (e: any) {
        return { output: `Extraction failed: ${summarizeError(e)}`, isError: true };
      }
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    danger: 'safe',
    params: [{ name: 'path', type: 'string', description: 'File path relative to workspace root', required: true }],
    async run(args, ctx) {
      const p = canonRelPath(args.path);
      try {
        const f = await ctx.fs.readFile(p);
        return { output: cap(`Contents of ${p} (${f.size} bytes):\n${f.content}`, 40000) };
      } catch (e: any) {
        const msg = summarizeError(e);
        if (/not found|404|ENOENT/i.test(msg)) {
          return { output: `MISSING: file "${p}" does not exist${ctx.fs.stat ? '' : ' (or cannot be read)'}. This is NOT a permission problem and NOT an empty file. Check workspace_info / list the parent directory to find the correct path. Do NOT retry this exact path.`, isError: true };
        }
        return { output: `Error reading ${p}: ${msg}`, isError: true };
      }
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace. Parent directories are created automatically. A unified diff of the change is generated before the write; concurrent modifications made after the diff are refused instead of overwritten.',
    danger: 'safe',
    params: [
      { name: 'path', type: 'string', description: 'File path relative to workspace root', required: true },
      { name: 'content', type: 'string', description: 'Full file contents to write', required: true },
    ],
    async run(args, ctx) {
      const p = canonRelPath(args.path);
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      ctx.assertEditable?.(p);
      // Milestone 1: preview the diff BEFORE writing (best-effort; mock hosts
      // and older companions without the endpoint just skip it).
      let diff: string | undefined;
      let mtime: string | null = null;
      if (ctx.fs.diffPreview) {
        try {
          const pv = await ctx.fs.diffPreview(p, content);
          diff = pv.diff ? (pv.truncated ? pv.diff + '\n…[diff truncated]' : pv.diff) : undefined;
          mtime = pv.currentMtime;
        } catch (e: any) {
          if (e?.status === 415 || e?.status === 400) return { output: `Cannot write ${p}: ${summarizeError(e)}`, isError: true };
          // other preview failures are non-fatal — proceed with a plain write
        }
      }
      try {
        const r = await ctx.fs.writeFile(p, content, { ifUnmodifiedSince: mtime });
        const stat = r.created ? 'created' : `updated (+${r.diffAdded ?? '?'} / -${r.diffRemoved ?? '?'} lines)`;
        return {
          output: `Wrote ${p} (${r.bytes} bytes, ${stat}).`,
          diff,
          diffPath: p,
          changedFile: p,
        };
      } catch (e: any) {
        // Overwrite protection fired: hand the model the CURRENT content so it
        // re-previews instead of clobbering newer work.
        const conflict = e?.payload?.conflict;
        if (conflict || /changed on disk after the diff was previewed/i.test(String(e?.message || e))) {
          const cur = conflict?.currentContent != null ? conflict.currentContent.slice(0, 2000) : '(content unavailable — re-read the file)';
          return { output: `CONFLICT: "${p}" changed after your diff was previewed — your write was REFUSED to avoid overwriting newer work. Current content (first 2000 chars):\n${cur}\nRe-read the file, integrate the newer changes, and write again.`, isError: true };
        }
        throw e;
      }
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact snippet in an existing file. Provide path, find (exact text to locate) and replace. Use for small targeted changes; use write_file to rewrite whole small files.',
    danger: 'safe',
    params: [
      { name: 'path', type: 'string', description: 'File path relative to workspace root', required: true },
      { name: 'find', type: 'string', description: 'Exact text to find (must match exactly and appear the expected number of times). Aliases: old_content, old_text, old_string', required: true },
      { name: 'replace', type: 'string', description: 'Replacement text. Aliases: new_content, new_text, new_string', required: true },
      { name: 'replaceAll', type: 'boolean', description: 'Replace every occurrence (default: require exactly one match)' },
    ],
    async run(args, ctx) {
      const p = canonRelPath(args.path);
      const find = String(args.find ?? '');
      const replace = String(args.replace ?? '');
      const all = args.replaceAll === true || args.replaceAll === 'true';
      if (!p) {
        return { output: `Error: edit_file is missing the required parameter "path" (the file to edit). Accepted aliases for path: ${PATH_ALIASES.join(', ')}.`, isError: true };
      }
      if (!find) {
        return { output: `Error: edit_file is missing the required parameter "find" (the exact text to locate in "${p}"). path was provided. Aliases accepted for find: old_content, old_text, old_string, old, search, original. Your call named: ${Object.keys(args).join(', ') || '(no parameters)'}.`, isError: true };
      }
      ctx.assertEditable?.(p);
      const f = await ctx.fs.readFile(p);
      const count = f.content.split(find).length - 1;
      if (count === 0) {
        const preview = f.content.length > 600 ? f.content.slice(0, 600) + '\n…' : f.content;
        return { output: `Error: the text to find was not present in ${p}. CURRENT FILE CONTENT:\n${preview}\nRetry with an exact snippet copied from this content.`, isError: true };
      }
      if (count > 1 && !all) {
        return { output: `Error: "find" appears ${count} times in ${p}. Provide more surrounding context or set replaceAll:true.`, isError: true };
      }
      const next = all ? f.content.split(find).join(replace) : f.content.replace(find, replace);
      // Milestone 1: diff preview BEFORE the edit is applied + overwrite
      // protection via the file's last-modified time read moments ago.
      let diff: string | undefined;
      if (ctx.fs.diffPreview) {
        try {
          const pv = await ctx.fs.diffPreview(p, next);
          diff = pv.diff ? (pv.truncated ? pv.diff + '\n…[diff truncated]' : pv.diff) : undefined;
        } catch { /* preview is best-effort */ }
      }
      try {
        const r = await ctx.fs.writeFile(p, next, { ifUnmodifiedSince: f.modifiedAt ?? null, returnDiff: true });
        return {
          output: `Edited ${p} (replaced ${all ? count : 1} occurrence(s), diff: +${r.diffAdded ?? 0} / -${r.diffRemoved ?? 0} lines).`,
          diff: diff ?? r.diff,
          diffPath: p,
          changedFile: p,
        };
      } catch (e: any) {
        const conflict = e?.payload?.conflict;
        if (conflict || /changed on disk after the diff was previewed/i.test(String(e?.message || e))) {
          const cur = conflict?.currentContent != null ? conflict.currentContent.slice(0, 2000) : '(content unavailable — re-read the file)';
          return { output: `CONFLICT: "${p}" changed after you read it — the edit was REFUSED to avoid overwriting newer work. Current content (first 2000 chars):\n${cur}\nRe-read the file and retry with a snippet from the CURRENT content.`, isError: true };
        }
        throw e;
      }
    },
  },
  {
    name: 'create_dir',
    description: 'Create a directory (and parents) in the workspace.',
    danger: 'safe',
    params: [{ name: 'path', type: 'string', description: 'Directory path relative to workspace root', required: true }],
    async run(args, ctx) {
      await ctx.fs.mkdir(canonRelPath(args.path));
      return { output: `Created directory ${args.path}.` };
    },
  },
  {
    name: 'delete_path',
    description: 'Delete a file or directory inside the workspace. DESTRUCTIVE — requires explicit user approval.',
    danger: 'destructive',
    params: [{ name: 'path', type: 'string', description: 'Path relative to workspace root', required: true }],
    async run(args, ctx) {
      const p = canonRelPath(args.path);
      ctx.assertEditable?.(p);
      await ctx.fs.deletePath(p);
      return { output: `Deleted ${p}.` };
    },
  },
  {
    name: 'search_project',
    description: 'Search file contents across the workspace. Returns matching file, line number and text.',
    danger: 'safe',
    params: [
      { name: 'query', type: 'string', description: 'Text or regex to search for', required: true },
      { name: 'regex', type: 'boolean', description: 'Treat query as a regular expression' },
      { name: 'glob', type: 'string', description: 'Optional filename filter like "*.js"' },
    ],
    async run(args, ctx) {
      const q = String(args.query ?? '');
      const r = await ctx.fs.search(q, { isRegex: args.regex === true || args.regex === 'true', glob: args.glob ? String(args.glob) : undefined });
      if (!r.length) return { output: `No matches for "${q}".` };
      const lines = r.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n');
      return { output: cap(`${r.length} match(es):\n${lines}`, 20000) };
    },
  },
  {
    name: 'run_command',
    description: 'Run a SHORT shell command in the workspace and wait for it (builds, tests, installs, git, file inspection). For GUI/desktop applications or servers that keep running, use launch_app instead — it returns immediately.',
    danger: 'command',
    params: [
      { name: 'command', type: 'string', description: 'Shell command to run, e.g. "npm test"', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory relative to workspace root (default: workspace root)' },
      { name: 'timeoutMs', type: 'number', description: 'Timeout in milliseconds (default 180000, max 600000)' },
    ],
    async run(args, ctx) {
      const cmd = String(args.command ?? '');
      const r = await ctx.runCommand(cmd, { cwd: args.cwd ? String(args.cwd) : undefined, timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined });
      const parts = [
        `$ ${cmd}`,
        `cwd: ${r.cwd ?? '(workspace root)'}`,
        `exit code: ${r.exitCode}${r.timedOut ? ' (TIMED OUT)' : ''}`,
        `duration: ${(r.durMs / 1000).toFixed(1)}s`,
      ];
      if (r.stdout.trim()) parts.push(`stdout:\n${cap(r.stdout, 30000)}`);
      if (r.stderr.trim()) parts.push(`stderr:\n${cap(r.stderr, 15000)}`);
      if (r.timedOut) {
        parts.push(
          'The command hit the timeout and was terminated (partial output above). If this is a GUI/desktop application or a server that should keep running, use launch_app instead — it starts the process detached and returns immediately; check it with process_status.'
        );
      }
      return { output: parts.join('\n'), isError: r.exitCode !== 0 || r.timedOut };
    },
  },
  {
    name: 'launch_app',
    description: 'Start a long-running or graphical process (desktop app, dev server) DETACHED: returns immediately with a process id and does NOT wait for the program to exit. Check progress with process_status; stop it with stop_process.',
    danger: 'command',
    params: [
      { name: 'command', type: 'string', description: 'Command to start, e.g. "python taskforge_gui.py" or "npm run dev"', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory relative to workspace root (default: workspace root)' },
    ],
    async run(args, ctx) {
      if (!ctx.procs) {
        return { output: 'Error: this companion does not support detached processes (update the LocalForge Companion).', isError: true };
      }
      const cmd = String(args.command ?? '');
      const proc = await ctx.procs.launch(cmd, { cwd: args.cwd ? String(args.cwd) : undefined });
      if (proc.status === 'failed') {
        return { output: `Failed to start "${cmd}": ${proc.spawnError || 'unknown spawn error'}`, isError: true };
      }
      return {
        output: `Started detached process:\n  id: ${proc.id}\n  pid: ${proc.pid ?? '?'}\n  command: ${cmd}\n  status: ${proc.status}\nThe process is running independently — this call did NOT wait for it. Use process_status (id=${proc.id}) to see its output and whether it is still running, and stop_process to terminate it.`,
      };
    },
  },
  {
    name: 'process_status',
    description: 'List detached processes started via launch_app (or one specific one), with running/exited status, exit code, duration and recent output. Use this instead of re-running a command to check whether it already succeeded.',
    danger: 'safe',
    params: [{ name: 'id', type: 'string', description: 'Optional process id (from launch_app). Omit to list all.' }],
    async run(args, ctx) {
      if (!ctx.procs) return { output: 'Error: detached processes are not supported by this companion (update it).', isError: true };
      if (args.id) {
        const { proc, output } = await ctx.procs.output(String(args.id));
        return { output: formatProc(proc, output) };
      }
      const list = await ctx.procs.list();
      if (!list.length) return { output: 'No detached processes have been started in this session.' };
      return { output: list.map((p) => formatProc(p, '')).join('\n\n') };
    },
  },
  {
    name: 'stop_process',
    description: 'Terminate a detached process started with launch_app (kills the whole process tree). Reports the actual termination result.',
    danger: 'command',
    params: [{ name: 'id', type: 'string', description: 'Process id (from launch_app or process_status)', required: true }],
    async run(args, ctx) {
      if (!ctx.procs) return { output: 'Error: detached processes are not supported by this companion (update it).', isError: true };
      const proc = await ctx.procs.stop(String(args.id));
      return { output: formatProc(proc, ''), isError: proc.status === 'running' };
    },
  },
  {
    name: 'install_dependencies',
    description: 'Install project dependencies. Detects the package manager from lockfiles (npm/pnpm/yarn/bun) or runs pip install -r requirements.txt for Python projects.',
    danger: 'command',
    params: [{ name: 'args', type: 'string', description: 'Extra args for the package manager (optional)' }],
    async run(args, ctx) {
      const extra = args.args ? ` ${args.args}` : '';
      const tryList = [
        { file: 'pnpm-lock.yaml', cmd: 'pnpm install' + extra },
        { file: 'yarn.lock', cmd: 'yarn install' + extra },
        { file: 'bun.lockb', cmd: 'bun install' + extra },
        { file: 'bun.lock', cmd: 'bun install' + extra },
        { file: 'package-lock.json', cmd: 'npm install' + extra },
        { file: 'package.json', cmd: 'npm install' + extra },
        { file: 'requirements.txt', cmd: 'pip install -r requirements.txt' + extra },
      ];
      for (const t of tryList) {
        try {
          await ctx.fs.readFile(t.file);
          const r = await ctx.runCommand(t.cmd, { timeoutMs: 300000 });
          return { output: `$ ${t.cmd}\nexit code: ${r.exitCode}\n${cap(r.stdout, 12000)}\n${cap(r.stderr, 8000)}`, isError: r.exitCode !== 0 };
        } catch { /* file missing — try next */ }
      }
      return { output: 'No dependency manifest found (package.json / requirements.txt). Nothing to install.', isError: true };
    },
  },
  {
    name: 'run_tests',
    description: 'Run the project test suite. Auto-detects the project type: package.json test script (JavaScript/TypeScript), Cargo.toml (Rust), go.mod (Go), and Python projects (pytest, falling back to unittest). You can also pass an explicit command.',
    danger: 'command',
    params: [{ name: 'command', type: 'string', description: 'Optional explicit test command; default auto-detects (npm test / cargo test / go test / pytest / unittest)' }],
    async run(args, ctx) {
      const explicit = args.command ? String(args.command) : null;
      if (explicit) {
        const r = await ctx.runCommand(explicit, { timeoutMs: 300000 });
        return { output: formatRun(explicit, r), isError: r.exitCode !== 0 };
      }
      const disc = await discoverTestCommand(ctx);
      if (!disc) {
        return {
          output: [
            'No test command could be auto-detected. Checked, in order:',
            '  • package.json "test" script (JavaScript/TypeScript)',
            '  • Cargo.toml → cargo test (Rust)',
            '  • go.mod → go test ./... (Go)',
            '  • pytest.ini / pyproject.toml / conftest.py / tests/ → python -m pytest (Python)',
            'This project matches none of them. Pass an explicit command to run_tests, or use run_command directly.',
          ].join('\n'),
          isError: true,
        };
      }
      let r = await ctx.runCommand(disc.command, { timeoutMs: 300000 });
      // pytest not installed → fall back to the stdlib unittest runner
      if (disc.fallback && /No module named pytest|pytest: (command )?not found/i.test(r.stderr + r.stdout)) {
        const fb = disc.fallback;
        const r2 = await ctx.runCommand(fb, { timeoutMs: 300000 });
        return { output: `$ ${disc.command}\n${cap(r.stderr, 2000)}\n(pytest unavailable — falling back)\n${formatRun(fb, r2)}`, isError: r2.exitCode !== 0 };
      }
      return { output: formatRun(disc.command, r, disc.how), isError: r.exitCode !== 0 };
    },
  },
  {
    name: 'run_build',
    description: 'Run the project build. Auto-detects: package.json "build" script, Cargo.toml (cargo build), go.mod (go build ./...), Makefile (make). Or pass an explicit build command.',
    danger: 'command',
    params: [{ name: 'command', type: 'string', description: 'Optional explicit build command' }],
    async run(args, ctx) {
      const explicit = args.command ? String(args.command) : null;
      if (explicit) {
        const r = await ctx.runCommand(explicit, { timeoutMs: 300000 });
        return { output: formatRun(explicit, r), isError: r.exitCode !== 0 };
      }
      const tryList: { file: string; cmd: string; how: string }[] = [
        { file: 'Cargo.toml', cmd: 'cargo build', how: 'detected Cargo.toml' },
        { file: 'go.mod', cmd: 'go build ./...', how: 'detected go.mod' },
        { file: 'Makefile', cmd: 'make', how: 'detected Makefile' },
      ];
      for (const t of tryList) {
        try {
          await ctx.fs.readFile(t.file);
          const r = await ctx.runCommand(t.cmd, { timeoutMs: 300000 });
          return { output: formatRun(t.cmd, r, t.how), isError: r.exitCode !== 0 };
        } catch { /* file missing — try next */ }
      }
      try {
        const pkg = JSON.parse((await ctx.fs.readFile('package.json')).content);
        if (pkg.scripts?.build) {
          const r = await ctx.runCommand('npm run build', { timeoutMs: 300000 });
          return { output: formatRun('npm run build', r, 'package.json build script'), isError: r.exitCode !== 0 };
        }
        return { output: 'package.json exists but has no "build" script (static sites do not need a build — use run_command to validate instead).', isError: true };
      } catch {
        return { output: 'No build command detected (checked Cargo.toml, go.mod, Makefile, package.json). Pass an explicit command or use run_command.', isError: true };
      }
    },
  },
  {
    name: 'browser_open',
    description: 'Open (or reuse) the shared local browser for this workspace and optionally navigate to a URL. Use visible:false (default) for a background session used by automated checks; visible:true shows the window to the user. Reports honestly when no browser is available.',
    danger: 'safe',
    params: [
      { name: 'url', type: 'string', description: 'URL to open. Local file paths and workspace-relative HTML files are allowed via http://127.0.0.1 preview or file:// if the companion supports it' },
      { name: 'visible', type: 'boolean', description: 'Show the browser window to the user (default: background/headless)' },
    ],
    async run(args, ctx) {
      if (!ctx.browser) return { output: 'Error: browser tools are not available in this context (companion too old or host does not provide them). Record verification as UNVERIFIED — do not claim it passed.', isError: true };
      const r = await ctx.browser.open({ url: args.url ? String(args.url) : undefined, visible: args.visible === true || args.visible === 'true' });
      if (r.unavailable) return { output: `BROWSER UNAVAILABLE: ${r.unavailable}\nRecord browser verification as UNVERIFIED in your summary. Do NOT claim browser verification passed.`, isError: false };
      return { output: `Browser ${r.reused ? 'reused' : 'opened'} (${r.browser ?? 'local browser'}${r.visible ? ', visible' : ', background'})${r.url ? ` at ${r.url}` : ''}. Use browser_verify to check page elements and console errors.` };
    },
  },
  {
    name: 'browser_verify',
    description: 'Verify a web page in the shared browser: navigate to the URL, run the checks, capture console errors and optionally save a screenshot into the workspace. Returns structured evidence. If the browser is unavailable the result says so — record UNVERIFIED, never claim success.',
    danger: 'safe',
    params: [
      { name: 'url', type: 'string', description: 'Page URL to verify (e.g. http://127.0.0.1:8000/index.html)', required: true },
      { name: 'checks', type: 'object', description: 'Array of checks: {"selector": "#display", "contains": "42"} or {"evaluate": "document.querySelectorAll(\'.key\').length >= 10"}. Optional but strongly recommended' },
      { name: 'screenshotPath', type: 'string', description: 'Optional workspace-relative path to save a screenshot (e.g. verification/screenshot.png)' },
    ],
    async run(args, ctx) {
      if (!ctx.browser) return { output: 'Error: browser tools are not available in this context (companion too old or host does not provide them). Record verification as UNVERIFIED — do not claim it passed.', isError: true };
      const checks = Array.isArray(args.checks) ? args.checks : (typeof args.checks === 'string' ? safeParseChecks(args.checks) : []);
      const r = await ctx.browser.verify({
        url: String(args.url ?? ''),
        checks,
        saveScreenshot: args.screenshotPath ? String(args.screenshotPath) : undefined,
      });
      if (r.unavailable) {
        return { output: `BROWSER UNAVAILABLE: ${r.unavailable}\nRecord browser verification as UNVERIFIED in your summary (say explicitly that browser testing could not be performed). Do NOT claim it passed.`, isError: false };
      }
      const lines = [
        r.verdict || 'BROWSER VERIFICATION RESULT',
        `url: ${r.url}${r.title ? ` (title: "${r.title}")` : ''}`,
        `checks passed: ${r.checksPassed ?? 0}/${r.checksTotal ?? checks.length}`,
      ];
      for (const c of r.checks ?? []) {
        lines.push(`  ${c.pass ? '✓' : '✗'} ${c.check}${c.count != null ? ` (count ${c.count})` : ''}${c.text ? ` → "${String(c.text).slice(0, 80)}"` : ''}${c.error ? ` ERROR: ${c.error}` : ''}`);
      }
      if (r.consoleErrors?.length) {
        lines.push(`console errors (${r.consoleErrors.length}):`);
        for (const e of r.consoleErrors.slice(0, 8)) lines.push(`  [${e.kind}] ${e.text.slice(0, 160)}`);
      } else {
        lines.push('console errors: none');
      }
      if (r.screenshotPath) lines.push(`screenshot saved: ${r.screenshotPath}`);
      lines.push(r.verdict?.startsWith('BROWSER VERIFICATION PASSED')
        ? 'Include this evidence in your finish summary (mention the checks and that they passed in a real browser).'
        : 'The verification did NOT fully pass — fix the issues and call browser_verify again. Do not claim GUI functionality works.');
      return { output: lines.join('\n'), isError: !r.verdict?.startsWith('BROWSER VERIFICATION PASSED') };
    },
  },
  {
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression in the shared browser page and return its value. Use for element interaction (click, fill) and inspection. Console errors since the last navigation are returned with the result.',
    danger: 'safe',
    params: [{ name: 'expression', type: 'string', description: 'JavaScript to evaluate in the page, e.g. "document.querySelector(\'#btn2\').click()"', required: true }],
    async run(args, ctx) {
      if (!ctx.browser) return { output: 'Error: browser tools are not available in this context. Record verification as UNVERIFIED.', isError: true };
      const r = await ctx.browser.evaluate(String(args.expression ?? ''));
      if (r.unavailable) return { output: `BROWSER UNAVAILABLE: ${r.unavailable}`, isError: true };
      const parts = [`${r.ok ? 'result' : 'error'}: ${r.ok ? JSON.stringify(r.value) ?? 'undefined' : r.error}`];
      if (r.consoleErrors?.length) {
        parts.push(`console errors since navigation (${r.consoleErrors.length}):`);
        for (const e of r.consoleErrors.slice(0, 6)) parts.push(`  [${e.kind}] ${e.text.slice(0, 160)}`);
      }
      return { output: parts.join('\n'), isError: !r.ok };
    },
  },
  {
    name: 'browser_close',
    description: 'Close the shared browser session for this workspace (background sessions only; a visible window the user opened stays open).',
    danger: 'safe',
    params: [],
    async run(args, ctx) {
      if (!ctx.browser) return { output: 'Error: browser tools are not available in this context.', isError: true };
      const r = await ctx.browser.close();
      return { output: r.note ?? 'Browser session closed.' };
    },
  },
  // ---- Milestone 3: durable project memory tools ----
  {
    name: 'memory_search',
    description: 'Search the workspace\'s durable project memory (decisions, conventions, known bugs, outcomes, preferences) plus the indexed source files. Use at task start to recall prior project knowledge, and before redoing work.',
    danger: 'safe',
    params: [
      { name: 'query', type: 'string', description: 'Keyword search query', required: true, aliases: ['q'] },
      { name: 'kind', type: 'string', description: 'Optional filter: decision | convention | bug | fact | outcome | test-history | preference | note' },
      { name: 'limit', type: 'number', description: 'Max results (default 8)' },
    ],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: project memory is not available in this context (older companion or mock host).', isError: true };
      const q = String(args.query ?? args.q ?? '');
      if (!q) return { output: 'Error: memory_search needs a query.', isError: true };
      const r = await ctx.memory.search(q, { kind: args.kind ? String(args.kind) : undefined, limit: Number(args.limit) || 8 });
      if (!r.results.length) return { output: `No project memories match "${q}". You can record new knowledge with memory_write.` };
      const lines = r.results.map((m) => `[${m.kind}]#${m.id.slice(0, 8)} (${m.score != null ? `score ${m.score}, ` : ''}updated ${new Date(m.updatedAt).toISOString().slice(0, 10)})${m.tags?.length ? ` tags:${m.tags.join(',')}` : ''}\n  ${m.content.slice(0, 400)}`);
      return { output: cap(`${r.results.length} memory hit(s)${r.hybrid ? ' (hybrid keyword+embedding)' : ''}:\n${lines.join('\n')}`, 16000) };
    },
  },
  {
    name: 'memory_read',
    description: 'Read one full project memory record by its id (as returned by memory_search).',
    danger: 'safe',
    params: [{ name: 'id', type: 'string', description: 'Memory record id (full id or the 8-char prefix shown by memory_search)', required: true }],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: project memory is not available in this context.', isError: true };
      const wanted = String(args.id ?? '');
      try {
        const m = await ctx.memory.read(wanted);
        return { output: `[${m.kind}] ${m.content}${m.refs ? `\nrefs: ${m.refs}` : ''}` };
      } catch (e: any) {
        // allow the 8-char prefix form: resolve via a fresh search
        if (wanted.length === 8) {
          const r = await ctx.memory.search(wanted, { limit: 20 }).catch(() => null);
          const hit = r?.results.find((x) => x.id.startsWith(wanted));
          if (hit) return { output: `[${hit.kind}] ${hit.content}` };
        }
        return { output: `Error reading memory ${wanted}: ${summarizeError(e)}`, isError: true };
      }
    },
  },
  {
    name: 'memory_write',
    description: 'Record durable project knowledge for future agents: architecture/design decisions, coding conventions, discovered bugs and fixes, important facts, task outcomes, verified test history. Duplicate content is merged automatically — write freely.',
    danger: 'safe',
    params: [
      { name: 'kind', type: 'string', description: 'decision | convention | bug | fact | outcome | test-history | preference | note', required: true },
      { name: 'content', type: 'string', description: 'The knowledge to persist — concrete and self-contained (a future agent reads it without this conversation)', required: true },
      { name: 'tags', type: 'string', description: 'Comma-separated short tags, e.g. "storage,architecture"' },
      { name: 'refs', type: 'string', description: 'Related file paths or ids' },
    ],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: project memory is not available in this context.', isError: true };
      const kind = String(args.kind ?? 'note');
      const content = String(args.content ?? '');
      if (!content.trim()) return { output: 'Error: memory_write needs non-empty content.', isError: true };
      const tags = typeof args.tags === 'string' && args.tags.trim() ? args.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : undefined;
      const r = await ctx.memory.write(kind, content, { tags, refs: args.refs ? String(args.refs) : undefined });
      return { output: r.deduplicated
        ? `Memory already known — existing record merged/updated (id ${r.id}).`
        : `Memory recorded (id ${r.id}). Future agents will find it via memory_search.` };
    },
  },
  {
    name: 'notebook_append',
    description: 'Append an entry to the shared agent notebook (append-only; visible to all agents on this workspace): kind = finding | handoff | decision | issue.',
    danger: 'safe',
    params: [
      { name: 'kind', type: 'string', description: 'finding | handoff | decision | issue', required: true },
      { name: 'content', type: 'string', description: 'The entry text', required: true },
      { name: 'refs', type: 'string', description: 'Optional related file paths or assignment ids' },
    ],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: notebook is not available in this context.', isError: true };
      const agentId = ctx.workspaceMeta?.machineLabel ? `agent@${ctx.workspaceMeta.machineLabel}` : 'agent';
      const r = await ctx.memory.notebookAppend(String(args.kind ?? 'finding'), String(args.content ?? ''), { refs: args.refs ? String(args.refs) : undefined });
      return { output: `Notebook entry appended (seq ${r.seq ?? '?'}).` };
    },
  },
  {
    name: 'notebook_search',
    description: 'Search the shared agent notebook (findings, handoffs, decisions, issues from other agents).',
    danger: 'safe',
    params: [
      { name: 'query', type: 'string', description: 'Keyword filter', required: true, aliases: ['q'] },
      { name: 'kind', type: 'string', description: 'Optional kind filter' },
      { name: 'limit', type: 'number', description: 'Max entries (default 20)' },
    ],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: notebook is not available in this context.', isError: true };
      const r = await ctx.memory.notebookSearch(String(args.query ?? args.q ?? ''), { kind: args.kind ? String(args.kind) : undefined, limit: Number(args.limit) || 20 });
      if (!r.results.length) return { output: 'No notebook entries match.' };
      const lines = r.results.map((e) => `#${e.seq ?? '?'} [${e.kind}] ${e.agentId}: ${e.content.slice(0, 240)}${e.refs ? ` (refs: ${e.refs})` : ''}`);
      return { output: cap(lines.join('\n'), 16000) };
    },
  },
  {
    name: 'read_scratchpad',
    description: 'Read an agent scratchpad (private working state: objective, plan, findings, errors, pending) by agent id. Use your own agentId from the task assignment, or read another agent\'s to coordinate.',
    danger: 'safe',
    params: [{ name: 'agentId', type: 'string', description: 'Agent id whose scratchpad to read', required: true }],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: scratchpad is not available in this context.', isError: true };
      const s = await ctx.memory.readScratchpad(String(args.agentId ?? ''));
      const parts: string[] = [];
      if (s.objective) parts.push(`objective: ${String(s.objective).slice(0, 300)}`);
      if (s.progress) parts.push(`progress: ${String(s.progress).slice(0, 200)}`);
      for (const key of ['plan', 'findings', 'toolResults', 'errors', 'pending']) {
        if (Array.isArray(s[key]) && s[key].length) parts.push(`${key}: ${s[key].slice(0, 8).map((x: unknown) => String(x).slice(0, 160)).join(' | ')}`);
      }
      return { output: parts.length ? parts.join('\n') : '(empty scratchpad)' };
    },
  },
  {
    name: 'write_scratchpad',
    description: 'Update your scratchpad (private working state persisted across turns): objective, progress, plan, findings, toolResults, errors, pending. Merge-safe: only provided fields change.',
    danger: 'safe',
    params: [
      { name: 'agentId', type: 'string', description: 'Your agent id', required: true },
      { name: 'objective', type: 'string', description: 'What this agent is trying to do' },
      { name: 'progress', type: 'string', description: 'Short current status' },
      { name: 'plan', type: 'string', description: 'JSON array of plan steps' },
      { name: 'findings', type: 'string', description: 'JSON array of discovered facts' },
      { name: 'errors', type: 'string', description: 'JSON array of errors seen (with context)' },
      { name: 'pending', type: 'string', description: 'JSON array of remaining steps' },
    ],
    async run(args, ctx) {
      if (!ctx.memory) return { output: 'Error: scratchpad is not available in this context.', isError: true };
      const patch: Record<string, unknown> = {};
      for (const k of ['objective', 'progress']) if (args[k] !== undefined) patch[k] = String(args[k]);
      for (const k of ['plan', 'findings', 'toolResults', 'errors', 'pending']) {
        if (args[k] !== undefined) {
          try { patch[k] = JSON.parse(String(args[k])); } catch { patch[k] = [String(args[k])]; }
        }
      }
      const s = await ctx.memory.writeScratchpad(String(args.agentId ?? 'agent'), patch);
      return { output: `Scratchpad updated (progress: ${String((s as any)?.progress ?? 'n/a').slice(0, 80)}).` };
    },
  },
  {
    name: 'finish',
    description: 'Declare the task complete with a summary. Call this when everything requested has been done and verified.',
    danger: 'safe',
    params: [{ name: 'summary', type: 'string', description: 'What was done, which files were created or changed, and how it was verified.', required: true }],
    async run(args) {
      return { output: `Finished: ${String(args.summary ?? '')}` };
    },
  },
];

function formatRun(cmd: string, r: { exitCode: number | null; stdout: string; stderr: string; durMs: number; timedOut: boolean }, how?: string): string {
  const parts = [`$ ${cmd}${how ? `  (${how})` : ''}`, `exit code: ${r.exitCode}${r.timedOut ? ' (TIMED OUT)' : ''}`, `duration: ${(r.durMs / 1000).toFixed(1)}s`];
  if (r.stdout.trim()) parts.push(`stdout:\n${cap(r.stdout, 24000)}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${cap(r.stderr, 12000)}`);
  return parts.join('\n');
}

function formatProc(p: ProcInfo, output: string): string {
  const dur = p.durMs != null ? `${(p.durMs / 1000).toFixed(1)}s` : `${((Date.now() - p.startedAt) / 1000).toFixed(0)}s (so far)`;
  const lines = [
    `process ${p.id}`,
    `  command: ${p.cmd}`,
    `  pid: ${p.pid ?? '?'}`,
    `  status: ${p.status}${p.exitCode != null ? ` (exit code: ${p.exitCode})` : ''}${p.spawnError ? ` (${p.spawnError})` : ''}`,
    `  duration: ${dur}`,
  ];
  if (output.trim()) lines.push(`  recent output:\n${cap(output, 6000)}`);
  return lines.join('\n');
}

export interface DiscoveredCommand {
  command: string;
  how: string;
  fallback?: string;
}

// Language-aware test discovery (spec §3.6). Never assumes package.json.
async function discoverTestCommand(ctx: ToolContext): Promise<DiscoveredCommand | null> {
  // 1) JavaScript/TypeScript
  try {
    const pkg = JSON.parse((await ctx.fs.readFile('package.json')).content);
    if (pkg.scripts?.test) return { command: 'npm test', how: 'package.json test script' };
  } catch { /* no package.json */ }
  // 2) Rust
  try { await ctx.fs.readFile('Cargo.toml'); return { command: 'cargo test', how: 'detected Cargo.toml' }; } catch { /* no */ }
  // 3) Go
  try { await ctx.fs.readFile('go.mod'); return { command: 'go test ./...', how: 'detected go.mod' }; } catch { /* no */ }
  // 4) Python: pytest markers, else unittest against a tests/ dir
  const pyMarkers = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py', 'tox.ini'];
  let pyHint: string | null = null;
  for (const m of pyMarkers) {
    try {
      const f = await ctx.fs.readFile(m);
      if (m !== 'pyproject.toml' || /tool\.pytest|\[tool\.pytest/.test(f.content)) { pyHint = m; break; }
      pyHint = m;
    } catch { /* not present */ }
  }
  if (!pyHint) {
    try {
      const root = await ctx.fs.listDir('.');
      if (root.some((e) => e.type === 'dir' && /tests?/i.test(e.path))) pyHint = 'tests/ directory';
    } catch { /* ignore */ }
  }
  if (pyHint) {
    return {
      command: 'python -m pytest -q',
      how: `Python project (${pyHint})`,
      fallback: 'python -m unittest discover -v',
    };
  }
  return null;
}

export function toolsByNames(names?: string[]): ToolDef[] {
  if (!names) return CORE_TOOLS;
  const set = new Set(names);
  return CORE_TOOLS.filter((t) => set.has(t.name));
}

export function summarizeError(e: unknown): string {
  return fmtErr(e);
}
