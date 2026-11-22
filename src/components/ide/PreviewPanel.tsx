'use client';

// Preview panel: serves the workspace's built/static app from the companion
// and renders it in an iframe. Also proxies a dev server port.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/lib/store/workspace';
import type { CompanionClient } from '@/lib/companion/client';
import { ExternalLink, MonitorPlay, RefreshCw } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

export function PreviewPanel({ client, active }: { client: CompanionClient; active: boolean }) {
  const ws = useWorkspace();
  const [url, setUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<'static' | 'dev'>('static');
  const [port, setPort] = useState('3000');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!ws.workspaceId) return;
    setLoading(true);
    try {
      if (mode === 'static') {
        await client.updateWorkspace(ws.workspaceId, { previewDir: ws.previewDir });
        const t = await client.previewToken(ws.workspaceId, ws.previewDir);
        setUrl(client.previewUrl(ws.workspaceId, t.token));
      } else {
        const t = await client.previewToken(ws.workspaceId, ws.previewDir);
        setUrl(client.buildUrl(`/p/${t.token}/${port}/`));
      }
    } catch (e: any) {
      toast({ title: 'Preview failed', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [client, mode, port, ws.previewDir, ws.workspaceId]);

  useEffect(() => {
    if (active && !url) refresh();
  }, [active, url, refresh]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b shrink-0">
        <MonitorPlay className="w-3.5 h-3.5 text-primary" />
        <Select value={mode} onValueChange={(v) => { setMode(v as any); setUrl(null); }}>
          <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="static">Static files</SelectItem>
            <SelectItem value="dev">Dev server</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'static' ? (
          <Input
            value={ws.previewDir}
            onChange={(e) => { ws.setPreviewDir(e.target.value); setUrl(null); }}
            className="h-7 flex-1 font-mono text-xs"
            title="Folder to serve (relative to workspace; e.g. . or dist)"
          />
        ) : (
          <Input
            value={port}
            onChange={(e) => { setPort(e.target.value); setUrl(null); }}
            className="h-7 w-24 font-mono text-xs"
            title="Dev server port on your machine"
          />
        )}
        <Button size="sm" variant="ghost" className="h-7" onClick={refresh} disabled={loading} title="Refresh preview">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0" title="Open in new tab">
            <Button size="sm" variant="ghost" className="h-7"><ExternalLink className="w-3.5 h-3.5" /></Button>
          </a>
        )}
      </div>
      <div className="flex-1 min-h-0 bg-white">
        {url ? (
          <iframe
            src={url}
            className="w-full h-full border-0"
            title="App preview"
            sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
            key={url}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground bg-background">
            No preview yet — click refresh after the agent (or you) creates files.
          </div>
        )}
      </div>
    </div>
  );
}
