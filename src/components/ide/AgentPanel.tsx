'use client';

// Agent conversation panel: streaming chat, tool-call cards, inline approvals,
// pipeline stage indicator.
//
// Forge upgrade additions:
//  - steering: while a run is active the input stays enabled and forwards
//    user steering to the runner (applied at the next turn boundary);
//  - completion verdict card: shows the coordinator's evidence-gated status
//    (NOT the model's claim) with a user override that is recorded without
//    touching verification records;
//  - contract summary: requirements checklist with waive buttons (user-only).
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgent, type ChatMessageView } from '@/lib/store/agent';
import { useSettings } from '@/lib/store/settings';
import { CheckCircle2, ChevronDown, ChevronRight, GitCompare, Loader2, Play, Send, ShieldCheck, Square, XCircle, Wrench, User, Bot, Workflow, Flag } from 'lucide-react';

function DiffView({ diff, path }: { diff: string; path?: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split('\n');
  const shown = expanded ? lines : lines.slice(0, 40);
  return (
    <div className="rounded border border-white/10 overflow-hidden" data-diff-preview={path || ''}>
      <div className="flex items-center gap-2 px-2 py-1 bg-emerald-500/10 text-[10px] text-emerald-300">
        <GitCompare className="w-3 h-3" />
        <span className="font-medium">unified diff{path ? ` — ${path}` : ''}</span>
        <span className="text-emerald-400/70">{lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length}+ / {lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}-</span>
        {lines.length > 40 && !expanded && (
          <button className="ml-auto underline" onClick={() => setExpanded(true)}>show all {lines.length} lines</button>
        )}
      </div>
      <pre className="font-mono text-[10px] leading-tight bg-black/40 p-1.5 overflow-x-auto lf-scroll max-h-64 whitespace-pre">
        {shown.map((l, i) => (
          <div key={i} className={
            l.startsWith('+') && !l.startsWith('+++') ? 'text-emerald-400 bg-emerald-500/10'
            : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400 bg-red-500/10'
            : l.startsWith('@@') ? 'text-violet-300'
            : 'text-zinc-400'
          }>{l || ' '}</div>
        ))}
      </pre>
    </div>
  );
}

function ToolCard({ msg }: { msg: ChatMessageView }) {
  const [open, setOpen] = useState(false);
  const entry = msg.toolMeta;
  const status = entry?.status || 'running';
  return (
    <div className="rounded-lg border bg-muted/30 text-xs overflow-hidden">
      <button className="w-full flex items-center gap-2 px-2.5 py-1.5" onClick={() => setOpen(!open)}>
        {status === 'running' && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />}
        {status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
        {status === 'error' && <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />}
        {status === 'denied' && <XCircle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />}
        <span className="font-medium flex items-center gap-1.5"><Wrench className="w-3 h-3 text-muted-foreground" />{entry?.tool || msg.toolCallId}</span>
        <span className="text-muted-foreground truncate">{entry?.summary}</span>
        {entry?.diff && <Badge variant="outline" className="text-[9px] text-emerald-400 border-emerald-500/40 shrink-0">diff</Badge>}
        <span className="ml-auto text-muted-foreground shrink-0">{entry?.durMs != null ? `${(entry.durMs / 1000).toFixed(1)}s` : ''}</span>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {entry?.argsPreview && <pre className="font-mono text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5 overflow-x-auto">{entry.argsPreview}</pre>}
          {entry?.diff && <DiffView diff={entry.diff} path={entry.diffPath} />}
          {entry?.output && <pre className="font-mono text-[10px] bg-muted/50 rounded p-1.5 overflow-x-auto max-h-48 lf-scroll whitespace-pre-wrap">{entry.output.slice(0, 4000)}</pre>}
          {(entry?.changedFile || entry?.workspaceRevision) && (
            <div className="text-[10px] text-muted-foreground">
              {entry?.changedFile && <span>changed: <span className="font-mono">{entry.changedFile}</span></span>}
              {entry?.changedFile && entry?.workspaceRevision && <span className="mx-1">·</span>}
              {entry?.workspaceRevision && <span>workspace revision <span className="font-mono">{entry.workspaceRevision}</span></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessageView }) {
  if (msg.role === 'tool') return <ToolCard msg={msg} />;
  if (msg.role === 'user') {
    const steering = msg.content.startsWith('[USER STEERING');
    return (
      <div className="flex gap-2 justify-end">
        <div className={`rounded-lg rounded-tr-sm px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap lf-anim-in ${steering ? 'bg-amber-500/90 text-amber-950' : 'bg-primary text-primary-foreground'}`}>
          {steering ? '⚡ ' : ''}{msg.content}
        </div>
      </div>
    );
  }
  // assistant / system
  const stageLabel = msg.stage && msg.stage !== 'chat' ? <Badge variant="outline" className="text-[10px]">{msg.stage}</Badge> : null;
  return (
    <div className="flex gap-2">
      <div className="shrink-0 w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
        <Bot className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1 lf-anim-in">
        {stageLabel}
        <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed break-words [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_code]:text-xs">
          <ReactMarkdown>{msg.content || (msg.streaming ? '…' : '')}</ReactMarkdown>
        </div>
        {msg.streaming && msg.content && <span className="lf-caret" />}
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETE: 'bg-green-500/15 text-green-600 border-green-500/40',
  PARTIAL: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/40',
  BLOCKED: 'bg-orange-500/15 text-orange-600 border-orange-500/40',
  FAILED: 'bg-red-500/15 text-red-600 border-red-500/40',
  UNVERIFIED: 'bg-blue-500/15 text-blue-600 border-blue-500/40',
};

export function AgentPanel({
  onRun,
  onContinue,
  onStop,
  onSteer,
  onOverrideComplete,
  onWaiveRequirement,
  mode,
  setMode,
}: {
  onRun: (task: string) => void;
  onContinue?: () => void;
  onStop: () => void;
  onSteer?: (text: string) => boolean;
  onOverrideComplete?: () => void;
  onWaiveRequirement?: (reqId: string) => void;
  mode: 'chat' | 'task' | 'pipeline';
  setMode: (m: 'chat' | 'task' | 'pipeline') => void;
}) {
  const { messages, pendingApproval, running, currentStage, toolLog, lastSession, contract, lastCompletion } = useAgent();
  const settings = useSettings();
  const [input, setInput] = useState('');
  const [showContract, setShowContract] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId);
  const modelReady = !!(activeProvider && settings.model);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    if (running) {
      // Forge (Problem A): input during an active run is user steering —
      // applied promptly, never lost behind tool retries.
      const ok = onSteer?.(text);
      if (ok) setInput('');
      return;
    }
    onRun(text);
    setInput('');
  };

  const decide = (d: 'allow' | 'allow-always' | 'deny') => {
    pendingApproval?.resolve(d);
  };

  const openReqs = contract?.requirements.filter((r) => r.source === 'user' && r.status === 'open') ?? [];
  const doneReqs = contract?.requirements.filter((r) => r.status !== 'open') ?? [];
  const verdict = lastCompletion;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="px-3 py-2 border-b space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">AI Agent</span>
          <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
            <TabsList className="h-6 p-0.5 bg-muted">
              <TabsTrigger value="chat" className="h-5 text-[11px] px-2 py-0">Chat</TabsTrigger>
              <TabsTrigger value="task" className="h-5 text-[11px] px-2 py-0">Agent</TabsTrigger>
              <TabsTrigger value="pipeline" className="h-5 text-[11px] px-2 py-0"><Workflow className="w-3 h-3" /> Pipeline</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono truncate">{modelReady ? `${activeProvider!.label || activeProvider!.baseUrl} · ${settings.model}` : 'No model selected'}</span>
          {mode === 'pipeline' && currentStage && (
            <Badge variant="outline" className="text-[10px] lf-pulse-dot">{currentStage} running</Badge>
          )}
        </div>
        {/* Forge (Problem C): contract strip */}
        {contract && mode !== 'chat' && (
          <button
            className="w-full flex items-center gap-2 text-[11px] rounded-md border bg-muted/30 px-2 py-1.5 hover:border-primary/60"
            onClick={() => setShowContract(!showContract)}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="truncate">Contract: {openReqs.length} open / {doneReqs.length} settled requirement{doneReqs.length === 1 ? '' : 's'}</span>
            <Badge variant="outline" className="text-[9px] ml-auto shrink-0">{contract.status}</Badge>
            {showContract ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
          </button>
        )}
        {showContract && contract && (
          <div className="rounded-md border bg-muted/20 p-2 space-y-1.5 text-[11px] max-h-48 overflow-y-auto lf-scroll">
            <p className="text-muted-foreground italic line-clamp-3">“{contract.originalRequest}”</p>
            {contract.requirements.filter((r) => r.source === 'user').map((r) => (
              <div key={r.id} className="flex items-start gap-1.5">
                {r.status === 'open' ? <span className="mt-0.5 w-3 h-3 rounded border shrink-0" /> : r.status === 'done' ? <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0 mt-0.5" /> : r.status === 'waived' ? <XCircle className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" /> : <Flag className="w-3 h-3 text-orange-500 shrink-0 mt-0.5" />}
                <span className={`flex-1 ${r.status === 'waived' ? 'line-through text-muted-foreground' : ''}`}>{r.text}</span>
                {r.status === 'open' && onWaiveRequirement && (
                  <button className="text-[9px] text-muted-foreground hover:text-destructive shrink-0 underline" onClick={() => onWaiveRequirement(r.id)}>waive</button>
                )}
              </div>
            ))}
            {contract.steering.filter((s) => !s.appliedAt).length > 0 && (
              <p className="text-amber-600 pt-1 border-t">⚡ {contract.steering.filter((s) => !s.appliedAt).length} pending steering note(s) — will be applied on the next turn.</p>
            )}
          </div>
        )}
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto lf-scroll px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-xs space-y-2 pt-6">
            <p className="font-medium text-sm text-foreground">Give the agent a task</p>
            <p>
              {mode === 'pipeline'
                ? 'The pipeline runs planner → coder → tester → reviewer, each with its own tools.'
                : mode === 'task'
                  ? 'The agent reads files, writes code, runs builds/tests and fixes failures until done. A task contract keeps the original requirements; completion is verified with evidence.'
                  : 'Ask questions about the project or request small changes.'}
            </p>
            <div className="pt-2 space-y-1.5 text-left max-w-xs mx-auto">
              {[
                'Build a todo app with add, complete and delete; write a test and make it pass',
                'Add a dark-mode toggle to index.html',
                'Why does test.js fail? Fix it.',
              ].map((s) => (
                <button key={s} className="w-full text-left rounded-md border px-2.5 py-1.5 hover:border-primary text-[11px]" onClick={() => setInput(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}

        {/* Forge (Problem D): completion verdict card */}
        {verdict && !running && (
          <div className={`rounded-lg border-2 p-3 text-sm space-y-2 lf-anim-in ${STATUS_COLORS[verdict.status] ?? 'border-border'}`}>
            <p className="font-medium flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Coordinator verdict: {verdict.status}
              {verdict.overriddenByUser && <Badge variant="outline" className="text-[9px]">user-override</Badge>}
            </p>
            <ul className="text-xs space-y-1 text-muted-foreground">
              {verdict.reasons.slice(0, 4).map((r, i) => <li key={i}>• {r}</li>)}
            </ul>
            {verdict.status !== 'COMPLETE' && onOverrideComplete && (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={onOverrideComplete} title="Record this task as COMPLETE by user decision. The gate verdict and evidence records are preserved unchanged.">
                  Override to COMPLETE
                </Button>
                <span className="text-[10px] text-muted-foreground">Records your decision; evidence stays as captured.</span>
              </div>
            )}
          </div>
        )}

        {/* approval card */}
        {pendingApproval && (
          <div className="rounded-lg border-2 border-primary/50 bg-primary/5 p-3 text-sm space-y-2 lf-anim-in">
            <p className="font-medium flex items-center gap-2"><User className="w-4 h-4 text-primary" /> Approval required</p>
            <p className="text-xs text-muted-foreground">{pendingApproval.summary}</p>
            {pendingApproval.args && typeof pendingApproval.args === 'object' && (pendingApproval.args as Record<string, unknown>).command ? (
              <pre className="font-mono text-[11px] bg-muted rounded p-1.5 whitespace-pre-wrap">{String((pendingApproval.args as Record<string, unknown>).command)}</pre>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => decide('allow')}>Allow once</Button>
              <Button size="sm" variant="outline" onClick={() => decide('allow-always')}>Always allow</Button>
              <Button size="sm" variant="destructive" onClick={() => decide('deny')}>Deny</Button>
            </div>
          </div>
        )}
      </div>

      {/* input */}
      <div className="p-2.5 border-t space-y-2 shrink-0">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={running ? 'Agent is working — type here to STEER it (sent immediately)…' : 'Describe the task… (Enter to send, Shift+Enter for newline)'}
          className="min-h-[64px] text-sm resize-none"
        />
        <div className="flex items-center gap-2">
          {running ? (
            <>
              <Button size="sm" variant="secondary" onClick={submit} disabled={!input.trim()} title="Send steering to the running agent — applied at the next turn">
                <Send className="w-3.5 h-3.5 mr-1" /> Steer
              </Button>
              <Button variant="destructive" size="sm" onClick={onStop} className="ml-auto">
                <Square className="w-3.5 h-3.5 mr-1" /> Stop
              </Button>
            </>
          ) : (
            <>
              {lastSession && onContinue && (
                <Button size="sm" variant="secondary" onClick={onContinue} title={lastSession.note || 'Resume the paused task with its full preserved context'}>
                  <Play className="w-3.5 h-3.5 mr-1" /> Continue task
                  {lastSession.turns ? <span className="ml-1 text-[10px] text-muted-foreground">({lastSession.turns} turns kept)</span> : null}
                </Button>
              )}
              <Button size="sm" onClick={submit} disabled={!input.trim() || !modelReady} className="ml-auto">
                <Send className="w-3.5 h-3.5 mr-1" /> Run
              </Button>
            </>
          )}
        </div>
        {running && (
          <p className="text-[11px] text-muted-foreground">
            {currentStage ? `${currentStage} · ` : ''}tool calls: {toolLog.length}
          </p>
        )}
      </div>
    </div>
  );
}
