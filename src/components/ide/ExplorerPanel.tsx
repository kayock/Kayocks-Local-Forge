'use client';

// File explorer + Git panel in the left dock.
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useWorkspace, type TreeNode } from '@/lib/store/workspace';
import type { CompanionClient } from '@/lib/companion/client';
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderPlus, FilePlus2, GitBranch, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

function languageFor(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json', md: 'markdown',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    sql: 'sql', xml: 'xml', svg: 'xml', txt: 'plaintext',
  };
  return ext ? map[ext] : 'plaintext';
}

export function ExplorerPanel({ client }: { client: CompanionClient }) {
  const ws = useWorkspace();
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  const tree = ws.tree;

  // Build a nested structure from flat paths
  const nested = useMemo(() => {
    const rootChildren: TreeNode & { children: Map<string, any> } = { path: '', type: 'dir', children: new Map() };
    for (const node of tree) {
      const parts = node.path.split('/');
      let cur = rootChildren;
      for (let i = 0; i < parts.length; i++) {
        const p = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        if (!cur.children.has(p)) {
          cur.children.set(p, { path: p, type: isLast ? node.type : 'dir', size: node.size, children: new Map() });
        }
        cur = cur.children.get(p)!;
      }
    }
    return rootChildren;
  }, [tree]);

  const openFile = async (path: string) => {
    try {
      const f = await client.readFile(ws.workspaceId!, path);
      ws.openTab({ path, content: f.content, draft: f.content, language: languageFor(path), loadedAt: Date.now() });
      ws.setActiveTab(path);
    } catch (e: any) {
      toast({ title: 'Cannot open file', description: e.message, variant: 'destructive' });
    }
  };

  const newFile = async (dirPath: string) => {
    const name = prompt(`New file in ${dirPath || 'workspace root'}:`);
    if (!name) return;
    const p = dirPath ? `${dirPath}/${name}` : name;
    try {
      await client.writeFile(ws.workspaceId!, p, '');
      ws.markTreeDirty();
      ws.openTab({ path: p, content: '', draft: '', language: languageFor(p), loadedAt: Date.now() });
      ws.setActiveTab(p);
    } catch (e: any) {
      toast({ title: 'Cannot create file', description: e.message, variant: 'destructive' });
    }
  };

  const newFolder = async (dirPath: string) => {
    const name = prompt(`New folder in ${dirPath || 'workspace root'}:`);
    if (!name) return;
    try {
      await client.mkdir(ws.workspaceId!, dirPath ? `${dirPath}/${name}` : name);
      ws.markTreeDirty();
    } catch (e: any) {
      toast({ title: 'Cannot create folder', description: e.message, variant: 'destructive' });
    }
  };

  const deleteEntry = async (p: string) => {
    if (!confirm(`Delete "${p}"? This cannot be undone.`)) return;
    try {
      await client.deletePath(ws.workspaceId!, p, true);
      ws.closeTab(p);
      ws.markTreeDirty();
      toast({ title: 'Deleted', description: p });
    } catch (e: any) {
      toast({ title: 'Cannot delete', description: e.message, variant: 'destructive' });
    }
  };

  const renameEntry = async (p: string) => {
    const next = prompt(`Rename ${p} to:`, p);
    if (!next || next === p) return;
    try {
      await client.rename(ws.workspaceId!, p, next);
      ws.closeTab(p);
      ws.markTreeDirty();
    } catch (e: any) {
      toast({ title: 'Cannot rename', description: e.message, variant: 'destructive' });
    }
  };

  const doSearch = async () => {
    if (!search.trim()) { setSearchResults(null); return; }
    try {
      const r = await client.search(ws.workspaceId!, search.trim(), { max: 100 });
      setSearchResults(r.results);
    } catch (e: any) {
      toast({ title: 'Search failed', description: e.message, variant: 'destructive' });
    }
  };

  const renderNode = (node: any, depth: number) => {
    if (node.type === 'dir') {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            className="w-full flex items-center gap-1 text-left text-sm py-1 pr-2 hover:bg-accent rounded-sm group"
            style={{ paddingLeft: depth * 12 + 4 }}
            onClick={() => {
              const next = new Set(expanded);
              if (isOpen) next.delete(node.path); else next.add(node.path);
              setExpanded(next);
            }}
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
            <Folder className="w-3.5 h-3.5 shrink-0 text-primary/70" />
            <span className="truncate">{node.path.split('/').pop()}</span>
          </button>
          {isOpen && [...node.children.values()].map((c: any) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <ContextMenu key={node.path}>
        <ContextMenuTrigger asChild>
          <button
            className={`w-full flex items-center gap-1.5 text-left text-sm py-1 pr-2 hover:bg-accent rounded-sm ${ws.activeTab === node.path ? 'bg-accent text-accent-foreground' : ''}`}
            style={{ paddingLeft: depth * 12 + 16 }}
            onClick={() => openFile(node.path)}
          >
            <FileIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.path.split('/').pop()}</span>
            {ws.tabs.find((t) => t.path === node.path && t.draft !== t.content) && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" title="Unsaved" />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => openFile(node.path)}>Open</ContextMenuItem>
          <ContextMenuItem onClick={() => newFolder(node.path.split('/').slice(0, -1).join('/'))}>New folder here</ContextMenuItem>
          <ContextMenuItem onClick={() => renameEntry(node.path)}>Rename</ContextMenuItem>
          <ContextMenuItem className="text-destructive" onClick={() => deleteEntry(node.path)}>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex-1 px-1">Explorer</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" title="New file" onClick={() => newFile('')}><FilePlus2 className="w-3.5 h-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-6 w-6" title="New folder" onClick={() => newFolder('')}><FolderPlus className="w-3.5 h-3.5" /></Button>
        <Button size="icon" variant="ghost" className="h-6 w-6" title="Refresh" onClick={() => ws.markTreeDirty()}><RefreshCw className="w-3.5 h-3.5" /></Button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Search in project…"
          className="h-7 text-xs"
        />
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={doSearch} title="Search contents"><Search className="w-3.5 h-3.5" /></Button>
      </div>

      <div className="flex-1 overflow-y-auto lf-scroll px-1 py-1" onClick={(e) => {
        // clicking a directory context area
      }}>
        {searchResults ? (
          <div>
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs text-muted-foreground">{searchResults.length} results</span>
              <button className="text-xs text-primary" onClick={() => setSearchResults(null)}>clear</button>
            </div>
            {searchResults.map((r, i) => (
              <button
                key={`${r.path}:${r.line}:${i}`}
                className="w-full text-left px-2 py-1 hover:bg-accent rounded-sm"
                onClick={() => openFile(r.path)}
              >
                <div className="text-xs font-mono text-primary">{r.path}:{r.line}</div>
                <div className="text-xs text-muted-foreground truncate font-mono">{r.text.trim().slice(0, 80)}</div>
              </button>
            ))}
          </div>
        ) : (
          [...nested.children.values()].map((c: any) => renderNode(c, 0))
        )}
      </div>
    </div>
  );
}

// ---------- Git panel ----------
export function GitPanel({ client }: { client: CompanionClient }) {
  const ws = useWorkspace();
  const [status, setStatus] = useState<string>('');
  const [log, setLog] = useState<string>('');
  const [diff, setDiff] = useState<string>('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (cmd: string, confirm = false): Promise<string> => {
    setBusy(true);
    try {
      const r = await client.exec(ws.workspaceId!, cmd, { confirm });
      return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)';
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    const [s, l] = await Promise.all([run('git status --porcelain=v1 -b'), run('git log --oneline -15 --decorate')]);
    setStatus(s);
    setLog(l);
  };

  const commit = async () => {
    if (!message.trim()) return;
    const out = await run(`git add -A && git commit -m ${JSON.stringify(message)}`, true);
    setMessage('');
    toast({ title: 'Commit', description: out.split('\n').slice(0, 4).join('\n') || 'done' });
    refresh();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        <GitBranch className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex-1 px-1">Git</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={refresh} disabled={busy} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="flex-1 overflow-y-auto lf-scroll p-2 space-y-3 text-xs">
        <div>
          <div className="flex gap-1 mb-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => run('git init').then((o) => { setStatus(o); toast({ title: 'git init', description: o }); })}>Init repo</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => run('git diff').then(setDiff)}>Diff</Button>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground bg-muted/40 rounded p-2 max-h-32 overflow-y-auto lf-scroll">{status || 'Click refresh to load status.'}</pre>
        </div>
        <div>
          <div className="flex gap-1">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              className="h-7 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && commit()}
            />
            <Button size="sm" className="h-7 text-xs" onClick={commit} disabled={busy || !message.trim()}>Commit</Button>
          </div>
        </div>
        {diff && (
          <div>
            <p className="text-muted-foreground mb-1">Diff <button className="text-primary underline ml-2" onClick={() => setDiff('')}>close</button></p>
            <pre className="whitespace-pre-wrap font-mono text-[11px] bg-muted/40 rounded p-2 max-h-64 overflow-y-auto lf-scroll">{diff}</pre>
          </div>
        )}
        <div>
          <p className="text-muted-foreground mb-1">Recent commits</p>
          <pre className="whitespace-pre-wrap font-mono text-[11px] bg-muted/40 rounded p-2 max-h-40 overflow-y-auto lf-scroll">{log || '—'}</pre>
        </div>
      </div>
    </div>
  );
}

export { languageFor };
