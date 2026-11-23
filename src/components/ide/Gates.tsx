'use client';

// Connection gate: pairing + workspace authorization shown before the IDE.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompanionClient, CompanionError } from '@/lib/companion/client';
import { useSettings } from '@/lib/store/settings';
import { useWorkspace } from '@/lib/store/workspace';
import { useRouter } from '@/lib/store/router';
import { ArrowRight, Cable, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, Terminal, XCircle } from 'lucide-react';

// This same-origin endpoint selects the newest published GitHub Windows installer
// and falls back to the verified v0.5.0 RC4 asset if GitHub's API is unavailable.
const WINDOWS_INSTALLER_URL = '/api/downloads/windows-companion';

export interface GateProps {
  client: CompanionClient;
  onPaired: () => void;
  onWorkspaceReady: (wsId: string, path: string, name: string) => void;
}

export function PairingGate({ client, onPaired }: Omit<GateProps, 'onWorkspaceReady'>) {
  const settings = useSettings();
  const navigate = useRouter((s) => s.navigate);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.pair(code.trim().toUpperCase(), 'browser');
      settings.setToken(r.token);
      onPaired();
    } catch (e: any) {
      setError(e?.message || 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="flex items-center gap-2 mb-1">
            <Cable className="w-5 h-5 text-primary" />
            <CardTitle>Connect your computer</CardTitle>
          </div>
          <CardDescription>
            The IDE runs in your browser; your files, terminal and AI models live on your machine.
            The lightweight companion bridges them — install it once, no terminal needed on Windows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">1</span>
              <div className="flex-1">
                <p className="font-medium">Install and start the companion</p>
                <p className="text-muted-foreground mt-1">
                  On Windows 10/11: download the installer, run it (no terminal needed) and launch{' '}
                  <span className="font-medium">LocalForge Companion</span> from the Start Menu.
                </p>
                <a
                  href={WINDOWS_INSTALLER_URL}
                  className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download LocalForge Companion for Windows
                </a>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Windows 10/11 x64 · current GitHub release · no admin rights needed · your pairing code, workspaces and settings survive upgrades.
                  Not digitally signed — Windows SmartScreen may ask for confirmation (choose “More info” → “Run anyway”).
                </p>
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">Developer? Install via npm instead (any OS)</summary>
                  <pre className="mt-2 rounded-md bg-muted p-3 font-mono text-xs overflow-x-auto">npm install -g &#64;localforge/companion{"\n"}localforge-companion</pre>
                </details>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <p className="font-medium">Copy the pairing code it displays</p>
                <p className="text-muted-foreground">It looks like <span className="font-mono">ABCD2345</span> and stays valid until you restart the companion.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">3</span>
              <div className="flex-1">
                <p className="font-medium mb-2">Paste it here</p>
                <div className="flex gap-2">
                  <Input
                    className="font-mono tracking-widest uppercase"
                    placeholder="ABCDEFGH"
                    maxLength={8}
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && code.length === 8 && pair()}
                    aria-label="Pairing code"
                  />
                  <Button onClick={pair} disabled={code.length < 8 || busy}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    Pair
                  </Button>
                </div>
              </div>
            </li>
          </ol>
          {error && <p className="text-sm text-destructive flex items-center gap-1"><XCircle className="w-4 h-4" /> {error}</p>}
          <div className="border-t pt-4 flex items-center justify-between text-sm">
            <button className="text-muted-foreground hover:text-foreground underline" onClick={() => navigate('settings')}>
              Companion connection settings (LAN / gateway mode)
            </button>
            <Badge variant="secondary">{settings.companion.mode === 'direct' ? settings.companion.directUrl : `gateway :${settings.companion.gatewayPort}`}</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const TEMPLATES = [
  {
    id: 'static-site',
    name: 'Static site (HTML/CSS/JS)',
    description: 'A tiny website + a real test script. Perfect first target for the agent.',
    files: (name: string) => ({
      'index.html': `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${name}</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main>\n    <h1>${name}</h1>\n    <p>Edit this page or ask the agent to build something here.</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
      'styles.css': `body {\n  font-family: system-ui, sans-serif;\n  background: #17171c;\n  color: #e4e4e7;\n  display: grid;\n  place-items: center;\n  min-height: 100vh;\n  margin: 0;\n}\nmain { max-width: 640px; padding: 2rem; }\nh1 { color: #a78bfa; }\n`,
      'app.js': `console.log('${name} loaded');\n`,
      'test.js': `// Real verification script: syntax-checks and content checks.\nconst fs = require('fs');\nconst path = require('path');\nlet failed = 0;\nfunction check(name, fn) {\n  try { fn(); console.log('ok -', name); }\n  catch (e) { failed++; console.error('FAIL -', name, '-', e.message); }\n}\ncheck('index.html exists', () => fs.accessSync(path.join(__dirname, 'index.html')));\ncheck('index.html has title', () => { if (!fs.readFileSync('index.html', 'utf8').includes('<h1>')) throw new Error('missing <h1>'); });\ncheck('styles.css exists', () => fs.accessSync(path.join(__dirname, 'styles.css')));\ncheck('app.js syntax', () => new Function(fs.readFileSync('app.js', 'utf8')));\nprocess.exit(failed ? 1 : 0);\n`,
      'package.json': `{\n  "name": "${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n`,
    }),
  },
  {
    id: 'empty',
    name: 'Empty folder',
    description: 'Start from scratch — point the agent at any task.',
    files: (name: string) => ({
      'README.md': `# ${name}\n\nCreated with LocalForge IDE.\n`,
    }),
  },
] as const;

export function ProjectGate({ client, onWorkspaceReady }: Omit<GateProps, 'onPaired'>) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<'recent' | 'open' | 'new'>('recent');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('static-site');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ id: string; path: string; name: string }[]>([]);
  const openedRef = useRef(false);

  const refreshRecent = async () => {
    try {
      const r = await client.listWorkspaces();
      setRecent(r.workspaces);
    } catch { setRecent([]); }
  };

  useEffect(() => { refreshRecent(); }, []);

  const openPath = async (p: string, label?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.openWorkspace(p, label);
      onWorkspaceReady(r.workspace.id, r.workspace.path, r.workspace.name);
    } catch (e: any) {
      setError(e?.message || 'Could not open folder.');
    } finally {
      setBusy(false);
    }
  };

  const createProject = async () => {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      // create the directory via a scratch workspace in the parent
      const parent = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      const base = p.split('/').filter(Boolean).pop() || name || 'project';
      await client.openWorkspace(parent, base);
      const wsList = await client.listWorkspaces();
      const parentWs = wsList.workspaces.find((w) => w.path === parent);
      if (!parentWs) throw new Error('Could not register parent folder.');
      await client.mkdir(parentWs.id, base);
      const t = TEMPLATES.find((x) => x.id === template)!;
      const projName = name.trim() || base;
      const files = t.files(projName);
      for (const [fp, content] of Object.entries(files)) {
        await client.writeFile(parentWs.id, `${base}/${fp}`, content);
      }
      const r = await client.openWorkspace(p, base);
      onWorkspaceReady(r.workspace.id, r.workspace.path, r.workspace.name);
    } catch (e: any) {
      setError(e?.message || 'Could not create project.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2 mb-1">
            <FolderOpen className="w-5 h-5 text-primary" />
            <CardTitle>Authorize a workspace</CardTitle>
          </div>
          <CardDescription>
            Pick a folder on your computer for the agent to work in. File operations are jailed to this folder;
            commands run inside it. You can authorize different folders any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-1 mb-4 rounded-lg bg-muted p-1 w-fit">
            {(['recent', 'open', 'new'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm rounded-md capitalize ${tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
              >
                {t === 'recent' ? 'Recent' : t === 'open' ? 'Open folder' : 'New project'}
              </button>
            ))}
          </div>

          {tab === 'recent' && (
            <div className="space-y-2">
              {recent.length === 0 && <p className="text-sm text-muted-foreground">No recent folders. Use “Open folder”.</p>}
              {recent.map((w) => (
                <button
                  key={w.id}
                  disabled={busy || openedRef.current}
                  onClick={() => { openedRef.current = true; openPath(w.path, w.name); }}
                  className="w-full text-left rounded-lg border p-3 hover:border-primary transition-colors flex items-center justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{w.name}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{w.path}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </button>
              ))}
              <Button variant="ghost" size="sm" onClick={refreshRecent}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh</Button>
            </div>
          )}

          {tab === 'open' && (
            <div className="space-y-3">
              <Label htmlFor="ws-path">Absolute folder path on your computer</Label>
              <Input
                id="ws-path"
                className="font-mono text-sm"
                placeholder={navigator.userAgent.includes('Win') ? 'C:\\Users\\you\\projects\\my-app' : '/home/you/projects/my-app'}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && path.trim() && openPath(path.trim())}
              />
              <p className="text-xs text-muted-foreground">
                Tip: type a path that exists. The companion will verify it and remember it for next time.
              </p>
              <Button onClick={() => openPath(path.trim())} disabled={!path.trim() || busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FolderOpen className="w-4 h-4 mr-2" />}
                Open folder
              </Button>
            </div>
          )}

          {tab === 'new' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="np-name">Project name</Label>
                  <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-todo-app" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="np-template">Template</Label>
                  <Select value={template} onValueChange={setTemplate}>
                    <SelectTrigger id="np-template"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TEMPLATES.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-path">New folder path (will be created)</Label>
                <Input
                  id="np-path"
                  className="font-mono text-sm"
                  placeholder={navigator.userAgent.includes('Win') ? 'C:\\Users\\you\\projects\\my-app' : '/home/you/projects/my-app'}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">{TEMPLATES.find((t) => t.id === template)?.description}</p>
              <Button onClick={createProject} disabled={!path.trim() || busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Terminal className="w-4 h-4 mr-2" />}
                Create project
              </Button>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-destructive flex items-center gap-1"><XCircle className="w-4 h-4" /> {error}</p>}
          <div className="mt-4 pt-3 border-t text-xs text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
            Companion paired — folders and commands stay on your machine.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
