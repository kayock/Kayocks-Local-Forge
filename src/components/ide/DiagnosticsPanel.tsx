'use client';

// Technical diagnostics view (Phase 1.5 §6): what model/protocol is active,
// per-tool-call outcomes (parse/validation/execution/exit codes/loop events),
// steering delivery, companion version — plus an exportable troubleshooting
// log with sensitive information redacted. Purpose: let a user tell whether a
// defect originated in the model, the inference server, the IDE or the
// companion WITHOUT reading giant escaped JSON strings.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAgent } from '@/lib/store/agent';
import { useWorkspace } from '@/lib/store/workspace';
import { useSettings } from '@/lib/store/settings';
import { CompanionClient } from '@/lib/companion/client';
import { Download, RefreshCw } from 'lucide-react';

// Redact anything credential-shaped before export (spec §6 "handle sensitive
// information appropriately").
function redact(obj: unknown): unknown {
  const SECRET = /(api[-_]?key|authorization|token|password|secret|pairing)/i;
  const walk = (v: any, key?: string): any => {
    if (v == null) return v;
    if (typeof v === 'string') return key && SECRET.test(key) ? '[REDACTED]' : v;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = SECRET.test(k) ? '[REDACTED]' : walk(val, k);
      return out;
    }
    return v;
  };
  return walk(obj);
}

const statusBadge = (s?: string) => {
  const cls = s === 'ok' ? 'text-green-600 border-green-500/40' : s === 'error' || s === 'failed' ? 'text-destructive border-destructive/40' : s ? 'text-yellow-600 border-yellow-500/40' : 'text-muted-foreground';
  return <Badge variant="outline" className={`text-[9px] ${cls}`}>{s || '—'}</Badge>;
};

export function DiagnosticsPanel({ client }: { client: CompanionClient }) {
  const agent = useAgent();
  // Per-tool-call outcomes come from the agent store's tool log. Loop,
  // steering and mode-change events have no dedicated store slice in this
  // build, so those sections render their empty states; the view types below
  // document the shape they are designed to display.
  interface LoopEventView { at: number; tool: string; action: string; message: string }
  interface SteeringView { id: string; turn: number; deliveredAt?: number; queuedAt: number; text: string }
  interface ModeChangeView { at: number; from: string; to: string; reason: string }
  const diagnostics = {
    toolCalls: agent.toolLog,
    loopEvents: [] as LoopEventView[],
    steering: [] as SteeringView[],
    modeChanges: [] as ModeChangeView[],
  };
  const settings = useSettings();
  const ws = useWorkspace();
  const [companion, setCompanion] = useState<{ version?: string; buildId?: string; platform?: string } | null>(null);
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);

  useEffect(() => {
    let alive = true;
    const load = () => {
      client.health()
        .then((h) => { if (alive) setCompanion({ version: h.version, buildId: (h as any).buildId, platform: h.platform }); })
        .catch(() => { if (alive) setCompanion(null); });
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  const protocol = settings.effectiveProtocol(provider?.baseUrl ?? '', settings.model);

  const exportLog = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'LocalForge IDE',
      activeModel: { model: settings.model, provider: provider ? { kind: provider.kind, baseUrl: provider.baseUrl, label: provider.label } : null, toolProtocol: protocol },
      companion: companion,
      workspace: { id: ws.workspaceId, path: ws.workspacePath },
      toolCalls: diagnostics.toolCalls,
      loopEvents: diagnostics.loopEvents,
      steering: diagnostics.steering,
      modeChanges: diagnostics.modeChanges,
      usage: useAgent.getState().usageTotals,
    };
    const blob = new Blob([JSON.stringify(redact(payload), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `localforge-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="h-full overflow-y-auto lf-scroll text-xs p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">Technical diagnostics</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => client.health().then((h) => setCompanion({ version: h.version, buildId: (h as any).buildId, platform: h.platform })).catch(() => {})}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={exportLog}>
            <Download className="w-3 h-3 mr-1" /> Export log
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border p-2 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide text-[9px]">Session</p>
          <p>Model: <span className="font-mono">{settings.model || '—'}</span></p>
          <p>Provider: <span className="font-mono">{provider ? `${provider.label || provider.kind} (${provider.baseUrl})` : '—'}</span></p>
          <p>Tool protocol: <span className="font-mono">{protocol}</span></p>
          <p>Fallback active: <span className="font-mono">{diagnostics.modeChanges.length > 0 ? `yes (${diagnostics.modeChanges.length}×)` : 'no'}</span></p>
        </div>
        <div className="rounded-md border p-2 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide text-[9px]">Companion</p>
          <p>Version: <span className="font-mono">{companion?.version || '—'}</span></p>
          <p>Build ID: <span className="font-mono">{companion?.buildId || '—'}</span></p>
          <p>Platform: <span className="font-mono">{companion?.platform || '—'}</span></p>
          <p className="text-[10px] text-muted-foreground">An old version here means the running companion predates this build — restart it.</p>
        </div>
      </div>

      <div className="rounded-md border">
        <p className="px-2 py-1.5 text-muted-foreground uppercase tracking-wide text-[9px] border-b">Tool calls — parsing, validation, execution</p>
        {diagnostics.toolCalls.length === 0 && <p className="px-2 py-2 text-muted-foreground">No tool calls in this session yet.</p>}
        <div className="divide-y">
          {diagnostics.toolCalls.slice(-40).reverse().map((t) => (
            <div key={t.id} className="px-2 py-1.5 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono">{t.tool}</span>
                {statusBadge(t.status)}
                {statusBadge(t.parse)}
                {statusBadge(t.validation)}
                <span className="ml-auto text-muted-foreground">{t.durMs != null ? `${(t.durMs / 1000).toFixed(1)}s` : ''}</span>
              </div>
              {(t.exitCode != null || t.repeatBlocked || t.recoveryIssued || t.argsTruncated || t.argsError) && (
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  {t.exitCode != null && <p>exit code: {t.exitCode}</p>}
                  {t.argsTruncated && <p className="text-yellow-600">arguments were truncated by the model server (token limit)</p>}
                  {t.argsError && <p className="text-destructive">provider parse error: {t.argsError.slice(0, 160)}</p>}
                  {t.repeatBlocked && <p>repetition guard blocked an identical call</p>}
                  {t.recoveryIssued && <p>failure-loop recovery guidance issued</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {diagnostics.loopEvents.length > 0 && (
        <div className="rounded-md border">
          <p className="px-2 py-1.5 text-muted-foreground uppercase tracking-wide text-[9px] border-b">Loop detection / recovery</p>
          <div className="divide-y">
            {diagnostics.loopEvents.slice(-20).reverse().map((e, i) => (
              <p key={i} className="px-2 py-1.5">{new Date(e.at).toLocaleTimeString()} · {e.tool} · {e.action} — {e.message}</p>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-md border">
        <p className="px-2 py-1.5 text-muted-foreground uppercase tracking-wide text-[9px] border-b">Steering delivery</p>
        {diagnostics.steering.length === 0 && <p className="px-2 py-2 text-muted-foreground">No steering instructions in this session.</p>}
        <div className="divide-y">
          {diagnostics.steering.slice(-20).reverse().map((s) => (
            <p key={s.id} className="px-2 py-1.5">
              {s.deliveredAt ? `delivered turn ${s.turn} at ${new Date(s.deliveredAt).toLocaleTimeString()}` : `queued at ${new Date(s.queuedAt).toLocaleTimeString()}`} — <span className="text-muted-foreground">{s.text.slice(0, 120)}</span>
            </p>
          ))}
        </div>
      </div>

      {diagnostics.modeChanges.length > 0 && (
        <div className="rounded-md border">
          <p className="px-2 py-1.5 text-muted-foreground uppercase tracking-wide text-[9px] border-b">Protocol fallbacks</p>
          <div className="divide-y">
            {diagnostics.modeChanges.map((m, i) => (
              <p key={i} className="px-2 py-1.5">{new Date(m.at).toLocaleTimeString()} · {m.from} → {m.to} — {m.reason}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
