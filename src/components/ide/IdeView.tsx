'use client';

// The IDE: connection gates, resizable layout, and the glue between the UI
// and the agent runtime.
//
// Forge upgrade responsibilities wired here:
//  - canonical workspace identity (Problem B): workspaceMeta resolved from
//    the companion's realpath tree root, machine label and platform;
//  - persistent task contracts (Problem C): get-or-create per project,
//    re-injected into every run, persisted across restarts;
//  - completion verdict (Problem D): final event carries the coordinator's
//    gate result, surfaced in the UI with a user override;
//  - model-switch handoffs (Problem E): continuing after a model change
//    replays a structured handoff packet built from the contract + journal;
//  - steering (Problem A): while a run is active, typed input is forwarded
//    to the runner and applied at the next turn boundary;
//  - live run timeline (Part 5): every operation is recorded in the runs
//    store (persisted) for the Live Runs view;
//  - dialect ledger (Part 2) and stall escalation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TopBar, type CompanionStatus } from './TopBar';
import { PairingGate, ProjectGate } from './Gates';
import { ExplorerPanel, GitPanel } from './ExplorerPanel';
import { EditorPane } from './EditorPane';
import { AgentPanel } from './AgentPanel';
import { TerminalPanel } from './TerminalPanel';
import { PreviewPanel } from './PreviewPanel';
import { ToolLogPanel } from './ToolLogPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { Stethoscope } from 'lucide-react';
import { CompanionClient } from '@/lib/companion/client';
import { useSettings } from '@/lib/store/settings';
import { useWorkspace } from '@/lib/store/workspace';
import { useAgent, type ToolMeta } from '@/lib/store/agent';
import { useRuns } from '@/lib/store/runs';
import { useProjects } from '@/lib/store/projects';
import { useRouter } from '@/lib/store/router';
import { useAuth } from '@/lib/store/auth';
import { useMesh } from '@/lib/store/mesh';
import { AgentRunner } from '@/lib/agent/runner';
import { PipelineRunner } from '@/lib/agent/orchestrator';
import { agentSystemPrompt, type WorkspaceContext } from '@/lib/agent/prompts';
import { CORE_TOOLS } from '@/lib/agent/tools';
import { createContract, contractPromptBlock, buildHandoffPacket, markSteeringApplied, recordProgress, setStatus as setContractStatus, waiveRequirement } from '@/lib/agent/task-contract';
import type { AgentEvent, AgentMessage, ToolProtocolMode, CompletionResult } from '@/lib/agent/types';
import { resolveInferenceParams } from '@/lib/types';
import { useTaskSessions } from '@/lib/store/task-sessions';
import type { TaskContract } from '@/lib/agent/task-contract';
import { toast } from '@/hooks/use-toast';

type BottomTab = 'terminal' | 'preview' | 'toollog' | 'diagnostics';
type LeftTab = 'explorer' | 'git';

export function IdeView() {
  const settings = useSettings();
  const ws = useWorkspace();
  const agent = useAgent();
  const runs = useRuns();
  const forgeProjects = useProjects();
  const navigate = useRouter((s) => s.navigate);
  const auth = useAuth();

  const [status, setStatus] = useState<CompanionStatus>('checking');
  const [platform, setPlatform] = useState<string>('');
  const [leftTab, setLeftTab] = useState<LeftTab>('explorer');
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [agentMode, setAgentMode] = useState<'chat' | 'task' | 'pipeline'>('task');
  const [projectGate, setProjectGate] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const runnerRef = useRef<AgentRunner | PipelineRunner | null>(null);
  const sessionRef = useRef<string | null>(null);
  const resumeSessionRef = useRef<string | null>(null);
  const toolMsgMap = useRef<Map<string, string>>(new Map()); // toolLogId -> chat msg id
  const runOpMap = useRef<Map<string, string>>(new Map());   // toolLogId -> run op id
  // message history of the last turn-limited run, for "Continue task"
  const resumeRef = useRef<AgentMessage[] | null>(null);
  // Forge (Problem E): the model that produced the preserved history — if
  // the user switched models, continuing uses a structured handoff packet.
  const resumeModelRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const contractRef = useRef<TaskContract | null>(null);

  const client = useMemo(() => new CompanionClient(() => settings.companion), [settings.companion]);
  const paired = !!settings.companion.token;

  // ---- health polling (with automatic direct→gateway fallback) ----
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const h = await client.health();
        if (!alive) return;
        setPlatform(h.platform);
        setStatus(paired ? 'paired' : 'unpaired');
      } catch {
        if (!alive) return;
        // Direct mode failed. Probe same-origin gateway transports (used on
        // hosted previews / locked-down networks): the Next rewrite proxy
        // first, then the XTransformPort gateway style.
        if (settings.companion.mode === 'direct' && !settings.companion.token) {
          const probes: { gatewayPath?: string }[] = [{ gatewayPath: '/lf-companion' }, {}];
          for (const probe of probes) {
            try {
              const gw = new CompanionClient(() => ({ mode: 'gateway', directUrl: settings.companion.directUrl, gatewayPort: settings.companion.gatewayPort, gatewayPath: probe.gatewayPath, token: null }));
              await gw.health();
              if (!alive) return;
              settings.setCompanion({ mode: 'gateway', gatewayPath: probe.gatewayPath });
              toast({
                title: 'Companion connected via gateway',
                description: 'This deployment routes companion traffic through the web server. On your own machine the IDE connects directly to 127.0.0.1.',
              });
              return;
            } catch { /* try next */ }
          }
        }
        setStatus(settings.companion.mode === 'gateway' && !paired ? 'unpaired' : 'offline');
      }
    };
    check();
    const t = setInterval(check, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [client, paired, settings.companion.mode, settings.companion.directUrl, settings.companion.gatewayPort, settings.companion.token, settings.setCompanion]);

  // ---- restore workspace ----
  useEffect(() => {
    if (status !== 'paired') return;
    auth.load();
    if (!ws.workspaceId) {
      setProjectGate(true);
      return;
    }
    // verify the workspace still exists on the companion
    client.listWorkspaces()
      .then((r) => {
        const found = r.workspaces.find((w) => w.id === ws.workspaceId);
        if (!found) {
          setProjectGate(true);
          toast({ title: 'Workspace not authorized', description: 'Open a folder to continue.' });
        } else {
          ws.markTreeDirty();
        }
      })
      .catch(() => {});

  }, [status]);

  // ---- tree loading + canonical workspace root (Problem B) ----
  useEffect(() => {
    if (!ws.workspaceId || !(status === 'paired')) return;
    if (!ws.treeDirty) return;
    client.tree(ws.workspaceId, 4)
      .then((r) => {
        ws.setTree(r.entries.map((e) => ({ path: e.path, type: e.type, size: e.size })));
        // The companion reports the canonical realpath of the workspace root
        // — this is the single source of truth for where the agent works.
        if (r.root) setWorkspaceRoot(r.root);
      })
      .catch(() => {});

  }, [ws.workspaceId, ws.treeDirty, status]);

  const onWorkspaceReady = useCallback((wsId: string, path: string, name: string) => {
    ws.setWorkspace(wsId, path);
    ws.upsertProject({
      id: `proj_${wsId}`,
      name,
      path,
      workspaceId: wsId,
      companionLabel: 'companion',
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    });
    ws.markTreeDirty();
    setProjectGate(false);
    // sync project metadata to the hosted backend (metadata only)
    if (auth.user) {
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, localPath: path, companionLabel: 'companion' }),
      }).then((r) => r.json()).then((r) => {
        if (r?.project?.id) {
          ws.upsertProject({ id: `proj_${wsId}`, name, path, workspaceId: wsId, hostedId: r.project.id, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() });
        }
      }).catch(() => {});
      fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'project_open' }) }).catch(() => {});
    }
  }, [ws, auth.user]);

  // ---- agent glue ----
  const buildWorkspaceContext = useCallback(async (): Promise<WorkspaceContext> => {
    let tree = '';
    let pkg = '';
    let root = '';
    try {
      const t = await client.tree(ws.workspaceId!, 2);
      root = t.root || '';
      tree = t.entries.slice(0, 50).map((e) => (e.type === 'dir' ? `${e.path}/` : e.path)).join('\n');
    } catch { /* ignore */ }
    try {
      const f = await client.readFile(ws.workspaceId!, 'package.json');
      const p = JSON.parse(f.content);
      pkg = `name=${p.name} scripts=${Object.keys(p.scripts || {}).join(', ')}`;
    } catch { /* no package.json */ }
    if (root) setWorkspaceRoot(root);
    return { platform: platform || 'unknown', workspacePath: root || ws.workspacePath, tree, packageInfo: pkg };
  }, [client, ws.workspaceId, ws.workspacePath, platform]);

  // ---- Forge run plumbing ----
  const activeForgeProject = forgeProjects.projects.find((p) => p.id === forgeProjects.activeForgeProjectId) || null;

  const getOrCreateContract = useCallback((task: string): TaskContract => {
    // reuse the active contract while its task is not superseded by a new
    // request; a brand-new task (different from the contract's request)
    // starts a new contract
    const existing = contractRef.current ?? activeForgeProject?.contract ?? null;
    if (existing && existing.status === 'ACTIVE' && existing.originalRequest.trim() === task.trim()) {
      contractRef.current = existing;
      return existing;
    }
    const c = createContract(task, {
      workspaceId: ws.workspaceId,
      path: workspaceRoot || ws.workspacePath,
      machineLabel: settings.machineLabel || 'This computer',
    });
    contractRef.current = c;
    agent.setContract(c);
    if (activeForgeProject) forgeProjects.saveContract(activeForgeProject.id, c);
    return c;
  }, [activeForgeProject, ws.workspaceId, ws.workspacePath, workspaceRoot, settings.machineLabel, agent, forgeProjects]);

  const persistContract = useCallback((c: TaskContract) => {
    contractRef.current = c;
    agent.setContract(c);
    if (activeForgeProject) forgeProjects.saveContract(activeForgeProject.id, c);
  }, [activeForgeProject, agent, forgeProjects]);

  const resolveWorkspaceMeta = useCallback(async () => {
    let rootPath = workspaceRoot;
    if (!rootPath) {
      try { rootPath = (await client.tree(ws.workspaceId!, 1)).root || ws.workspacePath; } catch { rootPath = ws.workspacePath; }
      if (rootPath) setWorkspaceRoot(rootPath);
    }
    return {
      id: ws.workspaceId!,
      rootPath: rootPath || '(unresolved)',
      machineLabel: settings.machineLabel || 'This computer',
      platform: platform || 'unknown',
    };
  }, [client, ws.workspaceId, ws.workspacePath, workspaceRoot, settings.machineLabel, platform]);

  const escalateTarget = useCallback(() => {
    if (!settings.autoEscalate) return null;
    const others = settings.providers.filter((p) => p.id !== settings.activeProviderId && (p.models?.length || p.baseUrl));
    for (const p of others) {
      const model = p.models?.[0]?.id;
      if (model) return { provider: { kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, label: p.label, chatTimeoutSec: p.chatTimeoutSec }, model, label: p.label || p.baseUrl };
    }
    return null;
  }, [settings.autoEscalate, settings.providers, settings.activeProviderId]);

  const runAgent = useCallback(async (task: string, optsIn?: { resumeMessages?: AgentMessage[]; resumeModel?: string | null; resumeSessionId?: string }) => {
    let opts: { resumeMessages?: AgentMessage[]; resumeModel?: string | null; resumeSessionId?: string } = optsIn ?? {};
    if (!ws.workspaceId) return;
    // Durable session resume: seed the recorded history as context.
    if (opts?.resumeSessionId) {
      resumeSessionRef.current = opts.resumeSessionId;
      const prior = useTaskSessions.getState().sessions.find((x) => x.id === opts.resumeSessionId);
      if (prior?.messages.length && !opts.resumeMessages) {
        opts = {
          ...opts,
          resumeMessages: prior.messages.slice(-10).map((m) => ({ role: m.role as any, content: m.content })) as AgentMessage[],
        };
      }
    } else {
      resumeSessionRef.current = null;
    }
    if (!settings.providers.find((p) => p.id === settings.activeProviderId) || !settings.model) {
      toast({ title: 'No model selected', description: 'Open Settings → Discover providers, then pick a model.', variant: 'destructive' });
      return;
    }
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId)!;
    const activeProviderCfg = { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey, label: provider.label, chatTimeoutSec: provider.chatTimeoutSec };
    const policy = settings.policy;
    const allowedPatterns = new Set<string>();
    const resumeMessages = opts?.resumeMessages?.length ? opts.resumeMessages : undefined;
    const runId = runs.startRun({
      projectId: activeForgeProject?.id ?? null,
      projectName: activeForgeProject?.name,
      model: settings.model,
      providerLabel: provider.label || provider.baseUrl,
      mode: agentMode,
      task: resumeMessages ? '(continued run)' : task,
    });
    runIdRef.current = runId;
    if (activeForgeProject) forgeProjects.attachRun(activeForgeProject.id, runId);

    agent.setRunning(true);
    agent.addMessage({
      role: 'user',
      content: resumeMessages
        ? (opts?.resumeModel && opts.resumeModel !== settings.model
          ? `↻ Continue task with ${settings.model} (switched from ${opts.resumeModel}) — resuming from the handoff packet with the original requirements and verified progress.`
          : '↻ Continue task — resuming with the preserved conversation, tool results and modified files.')
        : task,
      stage: agentMode,
    });
    runs.addOp(runId, { kind: resumeMessages ? 'handoff' : 'task', summary: resumeMessages ? `Resumed on ${settings.model}` : `Task: ${task.slice(0, 160)}` });

    // approver per execution policy
    const approver = async (req: { tool: string; args: Record<string, unknown>; danger: string; summary: string }) => {
      if (policy === 'auto' && req.danger !== 'destructive') return 'allow';
      if (policy === 'confirm-commands' && req.danger === 'safe') return 'allow';
      runs.addOp(runId, { kind: 'approval', tool: req.tool, summary: req.summary, status: 'running' });
      return new Promise<'allow' | 'allow-always' | 'deny'>((resolve) => {
        agent.setPendingApproval({
          id: `${Date.now()}`,
          ...req,
          resolve: (d) => {
            agent.setPendingApproval(null);
            runs.addOp(runId, { kind: 'approval', tool: req.tool, summary: `${d}: ${req.summary}`.slice(0, 200), status: d === 'deny' ? 'denied' : 'ok' });
            resolve(d);
          },
        });
      });
    };

    // wrapper: agent store events need a mutable assistantId per turn
    let assistantId: string | null = null;
    const wrappedOnEvent = (e: AgentEvent & { stage?: string }) => {
      if (e.type === 'turn_start') assistantId = null;
      if (e.type === 'text_delta' && !assistantId) {
        assistantId = agent.addMessage({
          role: 'assistant',
          content: e.v,
          streaming: true,
          stage: (e as any).stage ?? (agentMode === 'pipeline' ? agent.currentStage : undefined),
        });
        return;
      }
      if (e.type === 'text_delta' && assistantId) {
        agent.appendToMessage(assistantId, e.v);
        return;
      }
      if (e.type === 'text_final' && assistantId) {
        agent.finalizeMessage(assistantId);
        return;
      }
      if (e.type === 'tool_start') {
        const id = agent.addMessage({
          role: 'tool',
          content: '',
          toolCallId: e.call.id,
          stage: (e as any).stage,
          toolMeta: {
            tool: e.call.name,
            status: 'running',
            summary: summarizeArgs(e.call.args ?? undefined),
            argsPreview: JSON.stringify(e.call.args ?? {}, null, 1)?.slice(0, 800),
          },
        });
        toolMsgMap.current.set(`start:${e.call.id}`, id);
        const opId = genOpId();
        runOpMap.current.set(`start:${e.call.id}`, opId);
        runs.addOp(runId, { id: opId, kind: 'tool', tool: e.call.name, summary: `${e.call.name} ${summarizeArgs(e.call.args ?? undefined)}`.slice(0, 200), status: 'running', machine: settings.machineLabel });
        return;
      }
      if (e.type === 'tool_end') {
        const startId = toolMsgMap.current.get(`start:${e.call.id}`);
        if (startId) {
          useAgent.setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === startId
                ? {
                    ...m,
                    toolMeta: {
                      ...(m.toolMeta || { tool: e.entry.tool }),
                      tool: e.entry.tool,
                      status: e.entry.status,
                      output: e.entry.output,
                      durMs: e.entry.endedAt ? e.entry.endedAt - e.entry.startedAt : undefined,
                      // Milestone 1: structured write/edit results
                      diff: e.entry.diff,
                      diffPath: e.entry.diffPath,
                      changedFile: e.entry.changedFile,
                      workspaceRevision: e.entry.workspaceRevision ?? undefined,
                    },
                  }
                : m
            ),
          }));
        }
        agent.upsertToolLog(e.entry);
        const opId = runOpMap.current.get(`start:${e.call.id}`);
        if (opId) {
          runs.updateOp(runId, opId, {
            status: e.entry.status === 'running' ? 'ok' : (e.entry.status as any),
            detail: e.entry.output?.slice(0, 2000),
            durMs: e.entry.endedAt ? e.entry.endedAt - e.entry.startedAt : undefined,
            exitCode: e.entry.exitCode,
          });
        } else {
          runs.addOp(runId, { kind: 'tool', tool: e.entry.tool, summary: `${e.entry.tool} ${summarizeArgs(e.entry.args)}`.slice(0, 200), status: e.entry.status as any, detail: e.entry.output?.slice(0, 2000), durMs: e.entry.endedAt ? e.entry.endedAt - e.entry.startedAt : undefined, machine: e.entry.machine });
        }
        return;
      }
      if (e.type === 'notice') {
        agent.addMessage({ role: 'system', content: `ℹ ${e.message}` });
        runs.addOp(runId, { kind: 'notice', summary: e.message.slice(0, 200) });
        return;
      }
      if (e.type === 'mode_change') {
        // persist the per-model protocol decision (spec §3.2) and tell the user why
        settings.recordModelProtocol(activeProviderCfg.baseUrl, settings.model, e.to as ToolProtocolMode, e.reason);
        agent.addMessage({ role: 'system', content: `⚙ Tool protocol: ${e.from} → ${e.to} — ${e.reason}` });
        runs.addOp(runId, { kind: 'notice', summary: `Tool protocol ${e.from} → ${e.to}` });
        return;
      }
      if (e.type === 'loop_detected') {
        agent.addMessage({ role: 'system', content: `ℹ ${e.message}` });
        runs.addOp(runId, { kind: 'recovery', summary: e.message.slice(0, 200), status: 'blocked' });
        return;
      }
      if (e.type === 'steering_applied') {
        runs.addOp(runId, { kind: 'steering', summary: e.message.slice(0, 200) });
        return;
      }
      if (e.type === 'stall_detected') {
        runs.addOp(runId, { kind: 'recovery', summary: e.message.slice(0, 200), status: 'blocked' });
        return;
      }
      if ((e as any).type === 'recovery_action') {
        const ra = e as any;
        agent.addMessage({ role: 'system', content: `♻ Recovery ${ra.step}/2 (${ra.action}) after ${ra.stallClass} stall` });
        runs.addOp(runId, { kind: 'recovery', summary: `Recovery ${ra.step}/2: ${ra.action} (${ra.stallClass} stall)`, status: 'blocked' });
        return;
      }
      if ((e as any).type === 'stalled') {
        runs.addOp(runId, { kind: 'recovery', summary: 'STALLED — run stopped honestly, progress preserved', status: 'error' });
        return;
      }
      if (e.type === 'diff_preview') {
        // Milestone 1: file writes/edits show a diff in the timeline (the full
        // unified diff lives on the tool card; the op carries the summary).
        const first = e.diff.split('\n').find((l) => l.startsWith('@@')) || '';
        runs.addOp(runId, { kind: 'tool', tool: 'diff', summary: `diff: ${e.path} ${first.slice(0, 120)}`, status: 'ok', detail: e.diff.slice(0, 4000) });
        return;
      }
      if (e.type === 'escalation') {
        const msg = `Escalation ${e.fromModel} → ${e.toModel ?? '(next configured model)'}: ${e.reason}`;
        agent.addMessage({ role: 'system', content: `🔀 ${msg}` });
        runs.addOp(runId, { kind: 'handoff', summary: msg.slice(0, 200) });
        return;
      }
      if (e.type === 'dialect_learned') {
        settings.recordModelDialect(activeProviderCfg.baseUrl, e.model || settings.model, e.dialect);
        return;
      }
      if (e.type === 'completion_gate') {
        runs.addOp(runId, { kind: 'gate', summary: `Completion gate: ${e.status}${e.missing?.length ? ` — missing ${e.missing.length} item(s)` : ''}`, status: e.status === 'COMPLETE' ? 'ok' : 'error', detail: [e.detail, ...(e.missing || [])].join('\n').slice(0, 2000) });
        return;
      }
      if (e.type === 'model_error') {
        agent.setLastError(e.message);
        runs.addOp(runId, { kind: 'error', summary: e.message.slice(0, 200), status: 'error', detail: e.message.slice(0, 2000) });
        toast({ title: 'Model error', description: e.message.slice(0, 240), variant: 'destructive' });
        return;
      }
      if (e.type === 'usage') {
        agent.addUsage(e.usage);
        return;
      }
      if (e.type === 'stage') {
        agent.setStage(e.stage || null);
        runs.addOp(runId, { kind: 'stage', summary: `Stage: ${e.stage}` });
        return;
      }
      if (e.type === 'final') {
        if (assistantId) agent.finalizeMessage(assistantId);
        if (e.content) agent.addMessage({ role: 'assistant', content: e.content, stage: (e as any).stage });
        if (e.note) agent.addMessage({ role: 'system', content: `ℹ ${e.note}` });
        // durable session: record the outcome honestly (paused/done/failed)
        if (sessionRef.current) {
          const ss = useTaskSessions.getState();
          const sid = sessionRef.current;
          ss.appendMessage(sid, 'assistant', String(e.content || e.note || '').slice(0, 2000));
          const note = String(e.note || '');
          const status = /Paused|paused/.test(note) ? 'paused' : /STALLED|stopped/i.test(note) ? 'failed' : (e.content ? 'done' : 'paused');
          const contractSnap = contractRef.current ? { status: contractRef.current.status, statusNote: contractRef.current.statusNote, requirements: (contractRef.current.requirements ?? []).map((r: any) => ({ text: r.text, met: !!r.met })) } : null;
          ss.updateSession(sid, { status, contract: contractSnap });
        }
        // Problem D: the coordinator verdict, not the model's claim
        const completion = (e as any).completion as CompletionResult | undefined;
        if (completion) {
          agent.setLastCompletion({ ...completion, canOverride: true });
          runs.addOp(runId, { kind: 'gate', summary: `Final status: ${completion.status}`, status: completion.status === 'COMPLETE' ? 'ok' : 'error', detail: completion.reasons.join('\n').slice(0, 2000) });
          runs.endRun(runId, completion.status === 'COMPLETE' ? 'done' : 'paused', { status: completion.status, missing: completion.missingCriteria, reasons: completion.reasons });
        } else {
          runs.endRun(runId, e.note?.includes('Stopped by user') ? 'stopped' : e.canContinue ? 'paused' : 'done');
        }
        agent.setRunning(false);
        agent.setStage(null);
        fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent_run', meta: { model: settings.model, mode: agentMode, turns: e.turns } }) }).catch(() => {});
        return;
      }
    };

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const wsCtx = await buildWorkspaceContext();
      const workspaceMeta = await resolveWorkspaceMeta();
      const contract = agentMode === 'chat' ? null : getOrCreateContract(resumeMessages ? (contractRef.current?.originalRequest ?? task) : task);

      // Problem C: the contract block leads every non-chat system prompt —
      // requirements survive compaction because the block is re-sent each run.
      const basePrompt = agentSystemPrompt(wsCtx, agentMode === 'chat' ? 'chat' : 'task', settings.agentDevMode);
      const systemPrompt = contract ? `${contractPromptBlock(contract, { role: agentMode === 'pipeline' ? 'pipeline stage' : 'task agent' })}\n\n=== RUNTIME ===\n${basePrompt}` : basePrompt;
      if (contract) persistContract(contract);

      // Durable task session (RC3): every run is recorded and resumable.
      const sessions = useTaskSessions.getState();
      let session = sessions.createSession(ws.workspaceId, task);
      if (resumeSessionRef.current) {
        sessions.updateSession(resumeSessionRef.current, { status: 'active' });
        const existing = sessions.sessions.find((x) => x.id === resumeSessionRef.current);
        if (existing) session = existing;
      }
      if (session) {
        sessionRef.current = session.id;
        sessions.updateSession(session.id, { contract: contract ? { status: contract.status, statusNote: contract.statusNote, requirements: contract.requirements.map((r) => ({ text: r.text, met: (r as any).status ? (r as any).status === 'met' : false })) } : null, modelsUsed: [...new Set([...session.modelsUsed, settings.model])] });
        sessions.appendMessage(session.id, 'user', task);
      }
      // Safety checkpoint before the first mutating run (shadow git, honest no-op when git is missing)
      try {
        const cp = await client.createCheckpoint(ws.workspaceId, `before: ${task.slice(0, 60)}`);
        if (cp?.available && cp.checkpoint && session) useTaskSessions.getState().addCheckpoint(session.id, cp.checkpoint);
      } catch { /* checkpoints unavailable — workspace files untouched */ }

      if (agentMode === 'pipeline') {
        const pipeline = new PipelineRunner({
          companion: client,
          workspaceId: ws.workspaceId,
          provider: activeProviderCfg,
          model: settings.model,
          stageModels: settings.pipelineModels as any,
          params: resolveInferenceParams(settings.inference),
          task: contract ? `${contractPromptBlock(contract, { role: 'pipeline' })}\n\n=== USER TASK ===\n${task}` : task,
          workspaceContext: wsCtx,
          maxTurnsPerStage: 25,
          reworkPasses: 1,
          toolProtocol: settings.effectiveProtocol(activeProviderCfg.baseUrl, settings.model),
          onEvent: wrappedOnEvent,
          approver,
          allowedPatterns,
          signal: ac.signal,
        });
        runnerRef.current = pipeline;
        await pipeline.run();
      } else {
        const runner = new AgentRunner({
          companion: client,
          workspaceId: ws.workspaceId,
          provider: activeProviderCfg,
          model: settings.model,
          params: resolveInferenceParams(settings.inference),
          devMode: settings.agentDevMode,
          systemPrompt,
          task: resumeMessages ? 'Continue the task from exactly where you left off. Do not redo work that already succeeded; verify remaining work, then call finish.' : task,
          contextMessages: resumeMessages,
          tools: CORE_TOOLS,
          // explicit user choice wins; auto runs that fell back keep their
          // recorded per-model mode (persisted in settings)
          toolProtocol: settings.effectiveProtocol(activeProviderCfg.baseUrl, settings.model),
          maxTurns: agentMode === 'chat' ? 15 : settings.agentTurns ?? 40,
          onEvent: wrappedOnEvent,
          approver,
          allowedPatterns,
          signal: ac.signal,
          // ---- Forge upgrade wiring ----
          workspaceMeta,
          contract: contract ?? undefined,
          onContractUpdate: persistContract,
          // Milestone 1: surface the workspace revision in FS-write tool
          // results (cached briefly — the revision walks the whole workspace).
          fetchWorkspaceRevision: (() => {
            let cached: { rev: string; at: number } | null = null;
            const wsId = String(ws.workspaceId || '');
            return async () => {
              if (!wsId) return null;
              if (cached && Date.now() - cached.at < 10_000) return cached.rev;
              try {
                const mc = useMesh.getState().client();
                const r = await mc.workspaceRevision(wsId);
                cached = { rev: r.revision, at: Date.now() };
                return r.revision;
              } catch { return null; }
            };
          })(),
          onDialectLearned: (dialect, model) => settings.recordModelDialect(activeProviderCfg.baseUrl, model, dialect),
          escalateTo: escalateTarget,
          companionBrowser: {
            open: (id, o) => client.browserOpen(id, o),
            navigate: (id, url) => client.browserNavigate(id, url),
            eval: (id, expression) => client.browserEval(id, expression),
            verify: (id, o) => client.browserVerify(id, o as any),
            close: (id) => client.browserClose(id),
            status: (id) => client.browserStatus(id),
          },
        });
        runnerRef.current = runner;
        const r = await runner.run();
        if (r.hitTurnLimit) {
          // keep the full message history so the task can resume without loss
          resumeRef.current = r.messages;
          resumeModelRef.current = settings.model;
          agent.setLastSession({ note: r.note, turns: r.turns });
        } else {
          resumeRef.current = null;
          resumeModelRef.current = null;
          agent.setLastSession(null);
        }
        if (r.completion) agent.setLastCompletion({ ...r.completion, canOverride: true });
      }
    } catch (e: any) {
      toast({ title: 'Agent failed', description: String(e.message || e).slice(0, 240), variant: 'destructive' });
      if (runIdRef.current) runs.endRun(runIdRef.current, 'failed');
    } finally {
      agent.setRunning(false);
      agent.setPendingApproval(null);
      agent.setStage(null);
      ws.markTreeDirty();
      abortRef.current = null;
      runnerRef.current = null;
    }
  }, [ws, settings, agent, runs, forgeProjects, client, agentMode, buildWorkspaceContext, resolveWorkspaceMeta, getOrCreateContract, persistContract, escalateTarget, activeForgeProject]);

  const stopAgent = () => {
    abortRef.current?.abort();
    agent.setPendingApproval(null);
    if (runIdRef.current) runs.endRun(runIdRef.current, 'stopped');
  };

  // user steering while a run is active (Problem A): applied at the next
  // turn boundary — never lost behind retries
  const steerAgent = useCallback((text: string) => {
    const r = runnerRef.current;
    if (r && 'steer' in r && typeof (r as AgentRunner).steer === 'function') {
      (r as AgentRunner).steer(text);
      agent.addMessage({ role: 'user', content: text });
      if (runIdRef.current) runs.addOp(runIdRef.current, { kind: 'steering', summary: `Steering: ${text.slice(0, 160)}` });
      return true;
    }
    return false;
  }, [agent, runs]);

  // resume a run that hit its turn limit: replay the preserved history.
  // Problem E: if the model changed since the paused run, lead with the
  // structured handoff packet (original requirements + verified state) and
  // then replay the history.
  const continueAgent = useCallback(() => {
    const msgs = resumeRef.current;
    if (!msgs || agent.running) return;
    const switched = resumeModelRef.current && resumeModelRef.current !== settings.model;
    const fromModel = resumeModelRef.current;
    let contextMessages = msgs;
    if (switched && contractRef.current) {
      const packet = buildHandoffPacket(contractRef.current, {
        fromModel: resumeModelRef.current || 'the previous model',
        toModel: settings.model,
        filesTouched: [],
        testsRun: [],
        blockers: [],
        lastSuccessfulOperation: 'see conversation tail below',
        remainingWork: contractRef.current.requirements.filter((r) => r.status === 'open' && r.source === 'user').map((r) => r.text),
      });
      contextMessages = [{ role: 'user', content: packet }, ...msgs];
    }
    resumeRef.current = null;
    resumeModelRef.current = null;
    agent.setLastSession(null);
    if (contractRef.current) {
      let c = contractRef.current;
      for (let i = 0; i < c.steering.length; i++) if (!c.steering[i].appliedAt) c = markSteeringApplied(c, i);
      c = recordProgress(c, `Resumed${switched ? ` on ${settings.model} (handoff packet replayed)` : ''}`, 'coordinator');
      persistContract(c);
    }
    runAgent('Continue the task from exactly where you left off. Do not redo work that already succeeded; verify remaining work, then call finish.', { resumeMessages: contextMessages, resumeModel: switched ? fromModel : null });
  }, [runAgent, agent, ws.workspaceId, settings.model, persistContract]);

  // Problem D: user override — recorded as a manual decision, evidence and
  // gate records stay untouched.
  const overrideCompletion = useCallback(() => {
    const c = contractRef.current ?? activeForgeProject?.contract;
    if (!c) return;
    setContractStatus(c, 'COMPLETE', 'overridden by user — gate verdict and evidence records unchanged');
    persistContract(c);
    agent.setLastCompletion({ status: 'COMPLETE', missingCriteria: [], reasons: ['Status overridden by the user; verification evidence is preserved as recorded.'], evidence: c.evidence, overriddenByUser: true, canOverride: false });
    toast({ title: 'Status overridden to COMPLETE', description: 'Recorded as a manual user decision; verification evidence unchanged.' });
  }, [agent, activeForgeProject, persistContract]);

  // Problem C: waive a requirement (user action only)
  const waiveReq = useCallback((reqId: string) => {
    const c = contractRef.current ?? activeForgeProject?.contract;
    if (!c) return;
    waiveRequirement(c, reqId, 'waived by user');
    persistContract(c);
  }, [activeForgeProject, persistContract]);

  // Part 5: register the control bus so the Live Runs view can steer /
  // stop / continue while a run is alive. Latest callbacks are read through
  // refs and the registration runs ONCE via getState() — writing to the
  // agent store from an effect that re-fires on store identity changes
  // would loop forever (Maximum update depth exceeded).
  const steerRef = useRef(steerAgent);
  const continueRef = useRef(continueAgent);
  steerRef.current = steerAgent;
  continueRef.current = continueAgent;
  useEffect(() => {
    useAgent.getState().setControls({
      steer: (t: string) => steerRef.current(t),
      stop: () => {
        abortRef.current?.abort();
        useAgent.getState().setPendingApproval(null);
        if (runIdRef.current) useRuns.getState().endRun(runIdRef.current, 'stopped');
      },
      continue: () => continueRef.current(),
    });
    return () => useAgent.getState().setControls(null);
  }, []);

  // ---- gates ----
  if (status === 'offline' || status === 'unpaired') {
    return <PairingGate client={client} onPaired={() => { setStatus('checking'); }} />;
  }
  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary lf-pulse-dot" /> Looking for the companion…
        </div>
      </div>
    );
  }
  if (projectGate || !ws.workspaceId) {
    return <ProjectGate client={client} onWorkspaceReady={onWorkspaceReady} />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar status={status} modelReady={!!(settings.activeProviderId && settings.model)} onOpenProject={() => setProjectGate(true)} />

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal">
          {/* left dock */}
          <ResizablePanel defaultSize={20} minSize={12} maxSize={40} className="bg-card/40">
            <Tabs value={leftTab} onValueChange={(v) => setLeftTab(v as LeftTab)} className="h-full flex flex-col">
              <TabsList className="w-full shrink-0 rounded-none border-b bg-transparent justify-start h-8 p-0 gap-0">
                <TabsTrigger value="explorer" className="rounded-none h-8 px-3 text-xs data-[state=active]:bg-card">Explorer</TabsTrigger>
                <TabsTrigger value="git" className="rounded-none h-8 px-3 text-xs data-[state=active]:bg-card">Git</TabsTrigger>
              </TabsList>
              <div className="flex-1 min-h-0">
                {leftTab === 'explorer' ? <ExplorerPanel client={client} /> : <GitPanel client={client} />}
              </div>
            </Tabs>
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* center: editor + bottom dock */}
          <ResizablePanel defaultSize={55} minSize={25}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={62} minSize={20}>
                <EditorPane client={client} />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={38} minSize={10}>
                <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as BottomTab)} className="h-full flex flex-col">
                  <TabsList className="w-full shrink-0 rounded-none border-b bg-transparent justify-start h-8 p-0 gap-0">
                    <TabsTrigger value="terminal" className="rounded-none h-8 px-3 text-xs data-[state=active]:bg-card">Terminal</TabsTrigger>
                    <TabsTrigger value="preview" className="rounded-none h-8 px-3 text-xs data-[state=active]:bg-card">Preview</TabsTrigger>
                    <TabsTrigger value="toollog" className="rounded-none h-8 px-3 text-xs data-[state=active]:bg-card">Tool log</TabsTrigger>
                    <TabsTrigger value="diagnostics" className="gap-1.5 text-xs"><Stethoscope className="w-3.5 h-3.5" /> Diagnostics</TabsTrigger>
                  </TabsList>
                  <div className="flex-1 min-h-0">
                    {bottomTab === 'terminal' && <TerminalPanel client={client} active={bottomTab === 'terminal'} />}
                    {bottomTab === 'preview' && <PreviewPanel client={client} active={bottomTab === 'preview'} />}
                    {bottomTab === 'toollog' && <ToolLogPanel />}
                    {bottomTab === 'diagnostics' && <DiagnosticsPanel client={client} />}
                  </div>
                </Tabs>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* right dock: agent */}
          <ResizablePanel defaultSize={25} minSize={18} maxSize={50} className="bg-card/40">
            <AgentPanel
              onRun={runAgent}
              onContinue={continueAgent}
              onStop={stopAgent}
              onSteer={steerAgent}
              onOverrideComplete={overrideCompletion}
              onWaiveRequirement={waiveReq}
              mode={agentMode}
              setMode={setAgentMode}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

let opSeq = 0;
const genOpId = () => `uop_${Date.now().toString(36)}_${++opSeq}`;

function summarizeArgs(args: Record<string, unknown> | string | undefined): string {
  if (!args) return '';
  // Some providers deliver tool arguments as a JSON string instead of an object.
  if (typeof args === 'string') {
    try { return summarizeArgs(JSON.parse(args) as Record<string, unknown>); } catch { return args.slice(0, 60); }
  }
  const a = args as any;
  if (a.path) return a.path;
  if (a.command) return String(a.command).slice(0, 60);
  if (a.query) return `"${a.query}"`;
  return Object.entries(args)[0]?.[1]?.toString().slice(0, 40) || '';
}
