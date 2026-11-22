'use client';

// Monaco editor pane with tabs. Monaco is self-hosted from /public/monaco
// (no CDN dependency).
import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { useWorkspace } from '@/lib/store/workspace';
import type { CompanionClient } from '@/lib/companion/client';
import { Button } from '@/components/ui/button';
import { X, Save } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from '@/hooks/use-toast';
import { languageFor } from './ExplorerPanel';

loader.config({ paths: { vs: '/monaco/vs' } });

function defineThemes(monaco: Monaco) {
  monaco.editor.defineTheme('localforge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1d1d23',
      'editor.lineHighlightBackground': '#26262e',
      'editorLineNumber.foreground': '#55555f',
      'editorLineNumber.activeForeground': '#a78bfa',
      'editorCursor.foreground': '#a78bfa',
      'editor.selectionBackground': '#4c3a78aa',
      'editorGutter.background': '#1a1a20',
    },
  });
  monaco.editor.defineTheme('localforge-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#f4f4f6',
      'editorCursor.foreground': '#7c3aed',
      'editorLineNumber.activeForeground': '#7c3aed',
    },
  });
}

export function EditorPane({ client }: { client: CompanionClient }) {
  const ws = useWorkspace();
  const { resolvedTheme } = useTheme();
  const [saving, setSaving] = useState(false);
  const monacoRef = useRef<Monaco | null>(null);

  const active = ws.tabs.find((t) => t.path === ws.activeTab) || null;
  const dirty = active ? active.draft !== active.content : false;

  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(resolvedTheme === 'dark' ? 'localforge-dark' : 'localforge-light');
    }
  }, [resolvedTheme]);

  const save = async () => {
    if (!active || !ws.workspaceId) return;
    setSaving(true);
    try {
      await client.writeFile(ws.workspaceId, active.path, active.draft);
      ws.updateTabContent(active.path, active.draft);
      ws.markTreeDirty();
      toast({ title: 'Saved', description: active.path });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* tabs */}
      <div className="flex items-stretch border-b bg-card/60 overflow-x-auto lf-scroll-thin shrink-0">
        {ws.tabs.map((t) => (
          <button
            key={t.path}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs border-r whitespace-nowrap ${ws.activeTab === t.path ? 'bg-background' : 'text-muted-foreground hover:bg-accent/60'}`}
            onClick={() => ws.setActiveTab(t.path)}
          >
            <span className="font-mono">{t.path.split('/').pop()}</span>
            {t.draft !== t.content && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
            <X
              className="w-3 h-3 opacity-60 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); ws.closeTab(t.path); }}
            />
          </button>
        ))}
        <div className="flex-1 min-w-8" />
        {active && (
          <Button size="sm" variant="ghost" className="h-7 my-0.5 mr-1 self-center text-xs" onClick={save} disabled={!dirty || saving}>
            <Save className="w-3.5 h-3.5 mr-1" /> Save {dirty ? '•' : ''}
          </Button>
        )}
      </div>

      {/* editor */}
      <div className="flex-1 min-h-0">
        {active ? (
          <Editor
            key={active.path}
            height="100%"
            language={active.language || languageFor(active.path)}
            value={active.draft}
            theme={resolvedTheme === 'dark' ? 'localforge-dark' : 'localforge-light'}
            beforeMount={defineThemes}
            onMount={(_editor, monaco) => { monacoRef.current = monaco; }}
            onChange={(v) => ws.updateTabDraft(active.path, v ?? '')}
            options={{
              fontSize: 13,
              fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              renderWhitespace: 'selection',
            }}
            loading={<div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading editor…</div>}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2 p-8 text-center">
            <p className="text-sm">No file open</p>
            <p className="text-xs max-w-sm">
              Open a file from the explorer, or ask the agent to create one. Ctrl+S saves the current file to your workspace.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
