'use client';

// Structured tool-call / execution history log.
import { useState } from 'react';
import { useAgent } from '@/lib/store/agent';
import { CheckCircle2, ChevronDown, ChevronRight, XCircle, Loader2, Ban } from 'lucide-react';

export function ToolLogPanel() {
  const toolLog = useAgent((s) => s.toolLog);
  const [open, setOpen] = useState<Set<string>>(new Set());

  return (
    <div className="h-full overflow-y-auto lf-scroll p-2 space-y-1.5 text-xs">
      <div className="flex items-center justify-between px-1">
        <span className="text-muted-foreground">{toolLog.length} tool executions this session</span>
        <span className="text-muted-foreground">newest first</span>
      </div>
      {[...toolLog].reverse().map((e) => {
        const isOpen = open.has(e.id);
        return (
          <div key={e.id} className="rounded-md border bg-muted/20">
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5"
              onClick={() => {
                const next = new Set(open);
                if (isOpen) next.delete(e.id); else next.add(e.id);
                setOpen(next);
              }}
            >
              {e.status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />}
              {e.status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
              {e.status === 'error' && <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />}
              {e.status === 'denied' && <Ban className="w-3.5 h-3.5 text-yellow-500 shrink-0" />}
              <span className="font-medium">{e.tool}</span>
              <span className="text-muted-foreground truncate font-mono">{JSON.stringify(e.args).slice(0, 60)}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {e.endedAt ? `${((e.endedAt - e.startedAt) / 1000).toFixed(1)}s` : 'running…'}
              </span>
              {isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
            </button>
            {isOpen && (
              <div className="px-2 pb-2 space-y-1">
                <pre className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5 whitespace-pre-wrap break-all">{JSON.stringify(e.args, null, 1).slice(0, 2000)}</pre>
                {e.output && (
                  <pre className="font-mono text-[10px] bg-muted/50 rounded p-1.5 whitespace-pre-wrap max-h-56 overflow-y-auto lf-scroll">{e.output.slice(0, 6000)}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}
      {toolLog.length === 0 && (
        <p className="text-muted-foreground px-1 py-3">
          Every agent tool call and command execution is logged here — with arguments, output and duration.
        </p>
      )}
    </div>
  );
}
