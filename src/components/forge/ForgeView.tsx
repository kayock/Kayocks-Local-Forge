'use client';

// Forge Control (Forge upgrade — Parts 3, 4, 5): the graphical surfaces that
// make the reliability capabilities visible and manageable without terminal
// commands.
//
//  - Projects Hub: create/open/switch/resume projects bound to a workspace
//    host + directory, with participating models, persistent task contract,
//    run history and status. Projects reference workspaces; source files are
//    never duplicated.
//  - Fleet Map: lightweight SVG graph of the machine network (Station /
//    Portable / Windows / paired machines) with honest states: unreachable →
//    discovered → paired → inference-ready. Refresh is on demand — no
//    polling loops, no continuous animation (older hardware friendly).
//  - Live Runs: the actual operation timeline of each run — tool calls,
//    errors, recoveries, gates, handoffs — with failure inspection and the
//    pause/resume/stop/steer controls. Persisted across app restarts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useProjects, type ForgeProject } from '@/lib/store/projects';
import { useFleet, type FleetMachine } from '@/lib/store/fleet';
import { useRuns, type LiveRun } from '@/lib/store/runs';
import { useAgent } from '@/lib/store/agent';
import { useWorkspace } from '@/lib/store/workspace';
import { useSettings } from '@/lib/store/settings';
import { useRouter } from '@/lib/store/router';
import { useMesh } from '@/lib/store/mesh';
import { CompanionClient } from '@/lib/companion/client';
import { contractPromptBlock } from '@/lib/agent/task-contract';
import {
  Activity, ChevronDown, ChevronRight, FolderOpen, Network, Plus, Radar, RefreshCw,
  Rocket, Send, Server, Square, Trash2, Play, Wrench, AlertTriangle, ShieldCheck,
  GitBranch, Loader2, Link2, XCircle,
} from 'lucide-react';

type ForgeTab = 'projects' | 'fleet' | 'runs';

const PROJECT_STATUS_COLORS: Record<string, string> = {
  NEW: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40',
  ACTIVE: 'bg-blue-500/15 text-blue-500 border-blue-500/40',
  PAUSED: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/40',
  COMPLETE: 'bg-green-500/15 text-green-500 border-green-500/40',
  PARTIAL: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
  BLOCKED: 'bg-orange-500/15 text-orange-500 border-orange-500/40',
  FAILED: 'bg-red-500/15 text-red-500 border-red-500/40',
};

const MACHINE_STATE_COLORS: Record<string, string> = {
  unreachable: '#71717a',
  discovered: '#3b82f6',
  paired: '#22c55e',
  'inference-ready': '#a855f7',
};

export function ForgeView() {
  const [tab, setTab] = useState<ForgeTab>('projects');
  const navigate = useRouter((s) => s.navigate);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b bg-card/60">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center"><Network className="w-5 h-5 text-primary" /></div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Forge Control</h1>
              <p className="text-xs text-muted-foreground">Projects · Fleet · Live runs — no terminal required</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as ForgeTab)}>
              <TabsList>
                <TabsTrigger value="projects">Projects</TabsTrigger>
                <TabsTrigger value="fleet">Fleet</TabsTrigger>
                <TabsTrigger value="runs">Live Runs</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button size="sm" variant="outline" onClick={() => navigate('ide')}>Back to IDE</Button>
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-6 py-6">
        {tab === 'projects' && <ProjectsHub />}
        {tab === 'fleet' && <FleetMap />}
        {tab === 'runs' && <LiveRuns />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects Hub (Part 3)
// ---------------------------------------------------------------------------

function ProjectsHub() {
  const projects = useProjects();
  const wsStore = useWorkspace();
  const navigate = useRouter((s) => s.navigate);
  const runs = useRuns();
  const settings = useSettings();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', path: '', host: 'This computer' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ id: string; path: string; name: string }[]>([]);
  const client = useMemo(() => new CompanionClient(() => settings.companion), [settings.companion]);

  const refreshRecent = useCallback(() => {
    client.listWorkspaces().then((r) => setRecent(r.workspaces)).catch(() => setRecent([]));
  }, [client]);
  useEffect(() => { refreshRecent(); }, [refreshRecent]);

  const openInIde = async (p: ForgeProject) => {
    setBusy(true);
    setError(null);
    try {
      if (p.workspaceId && p.workspaceId === wsStore.workspaceId) {
        // already authorized — just switch
      } else {
        const r = await client.openWorkspace(p.workspacePath || p.workspacePath, p.name);
        wsStore.setWorkspace(r.workspace.id, r.workspace.path);
        wsStore.upsertProject({ id: `proj_${r.workspace.id}`, name: p.name, path: r.workspace.path, workspaceId: r.workspace.id, companionLabel: 'companion', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() });
        projects.updateProject(p.id, { workspaceId: r.workspace.id });
      }
      projects.setActiveProject(p.id);
      projects.touch(p.id);
      navigate('ide');
    } catch (e: any) {
      setError(e?.message || 'Could not open the workspace on this host.');
    } finally {
      setBusy(false);
    }
  };

  const bindRecent = async (w: { id: string; path: string; name: string }) => {
    const p = projects.createProject({ name: w.name, description: '', workspacePath: w.path, hostLabel: settings.machineLabel || 'This computer' });
    projects.updateProject(p.id, { workspaceId: w.id });
    setCreating(false);
  };

  const createProject = async () => {
    if (!form.name.trim() || !form.path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // authorize the folder on the companion (creates the workspace entry)
      const r = await client.openWorkspace(form.path.trim(), form.name.trim());
      const p = projects.createProject({
        name: form.name.trim(),
        description: form.description.trim(),
        workspacePath: r.workspace.path,
        hostLabel: form.host,
        model: settings.model,
        workspaceId: r.workspace.id,
        status: 'NEW',
      });
      wsStore.upsertProject({ id: `proj_${r.workspace.id}`, name: p.name, path: r.workspace.path, workspaceId: r.workspace.id, companionLabel: 'companion', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() });
      setCreating(false);
      setForm({ name: '', description: '', path: '', host: 'This computer' });
    } catch (e: any) {
      setError(e?.message || 'Could not create the project (is the path correct and the companion paired?).');
    } finally {
      setBusy(false);
    }
  };

  const active = projects.projects.find((p) => p.id === projects.activeForgeProjectId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Projects bind a workspace (host + directory), participating models, the persistent task contract and run history.
          Active: <span className="font-medium text-foreground">{active?.name ?? 'none'}</span>
        </p>
        <Button size="sm" onClick={() => setCreating(!creating)}><Plus className="w-3.5 h-3.5 mr-1" /> New project</Button>
      </div>

      {creating && (
        <Card>
          <CardHeader><CardTitle className="text-sm">New Forge project</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="calculator" /></div>
              <div className="space-y-1"><Label>Host machine label</Label><Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="Station / Portable / Windows Dell" /></div>
            </div>
            <div className="space-y-1"><Label>Workspace directory (absolute path on that host)</Label><Input className="font-mono text-sm" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/home/you/projects/calculator" /></div>
            <div className="space-y-1"><Label>Description / goal (becomes the task contract seed)</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="A graphical scientific calculator with a number base converter" className="min-h-[56px]" /></div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={createProject} disabled={busy || !form.name.trim() || !form.path.trim()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <FolderOpen className="w-3.5 h-3.5 mr-1" />} Create & authorize</Button>
              <p className="text-[11px] text-muted-foreground">The folder must exist on the companion machine. Files are never duplicated.</p>
            </div>
            {recent.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground mb-2">…or bind an already-authorized folder:</p>
                <div className="flex flex-wrap gap-2">
                  {recent.map((w) => (
                    <button key={w.id} className="text-[11px] rounded-md border px-2 py-1 hover:border-primary font-mono" onClick={() => bindRecent(w)}>{w.path}</button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {projects.projects.length === 0 && <p className="text-sm text-muted-foreground">No Forge projects yet. Create one to bind a workspace, a task contract and run history together.</p>}
        {projects.projects.map((p) => {
          const openRuns = runs.runs.filter((r) => r.projectId === p.id);
          const contractReqs = p.contract?.requirements.filter((r) => r.source === 'user') ?? [];
          return (
            <Card key={p.id} className={p.id === projects.activeForgeProjectId ? 'border-primary/60' : ''}>
              <CardContent className="py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm truncate">{p.name}</p>
                      <Badge variant="outline" className={`text-[10px] ${PROJECT_STATUS_COLORS[p.status] ?? ''}`}>{p.status}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{p.hostLabel}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{p.workspacePath || '(no workspace bound)'}</p>
                    <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-muted-foreground">
                      <span>model: <span className="font-mono text-foreground">{p.model || '—'}</span></span>
                      <span>runs: {openRuns.length}</span>
                      {contractReqs.length > 0 && (
                        <span>requirements: {contractReqs.filter((r) => r.status !== 'open').length}/{contractReqs.length} settled</span>
                      )}
                      {p.contract && <span>contract v{p.contract.version}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => openInIde(p)} disabled={busy} title="Authorize (if needed) and open this workspace in the IDE">
                      {p.status === 'PAUSED' ? <Play className="w-3.5 h-3.5 mr-1" /> : <Rocket className="w-3.5 h-3.5 mr-1" />}
                      {p.status === 'PAUSED' ? 'Resume' : 'Open'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => projects.removeProject(p.id)} title="Remove the project entry (never touches files on disk)">
                      <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fleet Map (Part 4)
// ---------------------------------------------------------------------------

function FleetMap() {
  const fleet = useFleet();
  const settings = useSettings();
  const wsStore = useWorkspace();
  const runs = useRuns();
  const agent = useAgent();
  const mesh = useMesh();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', role: '', url: 'http://' });
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Milestone 2: mDNS discovery (advertisement + browse; pairing stays manual)
  const [discovery, setDiscovery] = useState<any>(null);
  const [discovering, setDiscovering] = useState(false);
  const [pairCodeFor, setPairCodeFor] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [fleetTasks, setFleetTasks] = useState<any[] | null>(null);

  const runDiscovery = useCallback(async () => {
    setDiscovering(true);
    try {
      const mc = mesh.client();
      const d = await mc.discover();
      setDiscovery(d);
    } catch (e: any) {
      setDiscovery({ available: false, reason: String(e?.message || e).slice(0, 160), discovered: [] });
    }
    setDiscovering(false);
  }, [mesh]);

  // Milestone 2: fleet task packets for the active workspace
  const refreshFleetTasks = useCallback(async () => {
    if (!wsStore.workspaceId) { setFleetTasks(null); return; }
    try {
      const mc = mesh.client();
      const r = await mc.listTasks(wsStore.workspaceId);
      setFleetTasks(r.tasks.slice(0, 20));
    } catch { setFleetTasks(null); }
  }, [mesh, wsStore.workspaceId]);

  const connectDiscovered = useCallback(async (url: string, code?: string) => {
    try {
      const mc = mesh.client();
      const r = await mc.connectPeer(url, { name: undefined, code, deviceLabel: 'LocalForge Fleet Map' });
      await mesh.refreshMesh();
      // add to the map as a paired machine
      const existing = fleet.machines.find((m) => m.url === url);
      if (!existing) {
        fleet.addMachine({ label: r.peer.name || url, role: 'paired LAN companion (mesh)', url, hasToken: true, state: 'paired' });
      } else {
        fleet.updateMachine(existing.id, { state: 'paired', hasToken: true });
      }
      setPairCodeFor(null);
      setPairCode('');
      return true;
    } catch {
      return false;
    }
  }, [mesh, fleet]);

  // seed with this machine on first load
  useEffect(() => {
    if (fleet.machines.length === 0) {
      fleet.addMachine({ label: settings.machineLabel || 'This computer', role: 'companion currently paired with this IDE', url: settings.companion.mode === 'remote' ? settings.companion.remoteUrl || settings.companion.directUrl : settings.companion.directUrl, hasToken: !!settings.companion.token, state: 'paired' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const probe = useCallback(async (m: FleetMachine) => {
    const client = new CompanionClient(() => ({ mode: 'direct', directUrl: m.url, remoteUrl: m.url, gatewayPort: settings.companion.gatewayPort, token: m.hasToken ? settings.companion.token : null }));
    try {
      const h = await client.health();
      const updated: Partial<FleetMachine> = {
        companionVersion: h.version,
        platform: h.platform,
        hostname: h.resources?.hostname,
        resources: h.resources,
        workspaces: h.workspaces,
        error: undefined,
        lastCheckedAt: Date.now(),
      };
      if (m.hasToken && settings.companion.token) {
        // inference readiness: probe model providers through the companion
        try {
          const disc = await client.discoverProviders();
          updated.modelCount = disc.providers?.length ?? 0;
          fleet.setState(m.id, (disc.providers?.length ?? 0) > 0 ? 'inference-ready' : 'paired', updated);
        } catch {
          fleet.setState(m.id, 'paired', updated);
        }
      } else {
        fleet.setState(m.id, 'discovered', updated);
      }
    } catch (e: any) {
      fleet.setState(m.id, 'unreachable', { error: String(e?.message || e).slice(0, 160), lastCheckedAt: Date.now() });
    }
  }, [fleet, settings.companion, settings.companion.token]);

  const refreshAll = async () => {
    setChecking(true);
    await Promise.allSettled(fleet.machines.map(probe));
    setChecking(false);
  };

  const addMachine = () => {
    if (!form.label.trim() || !form.url.trim()) return;
    fleet.addMachine({ label: form.label.trim(), role: form.role.trim(), url: form.url.trim() });
    setForm({ label: '', role: '', url: 'http://' });
    setAdding(false);
  };

  const activeRun = runs.runs.find((r) => r.status === 'running');
  const handoffs = runs.runs.flatMap((r) => r.ops.filter((o) => o.kind === 'handoff')).length;
  const sel = fleet.machines.find((m) => m.id === selected);

  // lightweight static SVG — refresh on demand, no animation loops
  const n = fleet.machines.length;
  const layout = fleet.machines.map((m, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(n, 1) - Math.PI / 2;
    const r = n <= 1 ? 120 : 110;
    return { m, x: 220 + r * Math.cos(angle), y: 165 + r * Math.sin(angle) };
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          States: <span style={{ color: MACHINE_STATE_COLORS.unreachable }}>unreachable</span> → <span style={{ color: MACHINE_STATE_COLORS.discovered }}>discovered</span> → <span style={{ color: MACHINE_STATE_COLORS.paired }}>paired</span> → <span style={{ color: MACHINE_STATE_COLORS['inference-ready'] }}>inference-ready</span>.
          {activeRun && <> Active run on <span className="text-foreground font-medium">{activeRun.providerLabel ?? 'this machine'}</span>.</>}
          {' '}Handoffs recorded: {handoffs}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setAdding(!adding); runDiscovery(); }}><Radar className="w-3.5 h-3.5 mr-1" /> Discover LAN</Button>
          <Button size="sm" variant="outline" onClick={() => setAdding(!adding)}><Plus className="w-3.5 h-3.5 mr-1" /> Add machine</Button>
          <Button size="sm" onClick={refreshAll} disabled={checking}>{checking ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />} Refresh</Button>
        </div>
      </div>

      {discovery && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm flex items-center gap-2"><Radar className="w-4 h-4 text-violet-400" /> LAN discovery (mDNS)</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-2">
            {!discovery.available && <p className="text-muted-foreground">Discovery unavailable: {discovery.reason || 'mDNS not supported here'} — manual IP entry below keeps working.</p>}
            {discovery.available && (
              <p className="text-muted-foreground">
                Advertising: <span className={discovery.self?.advertising ? 'text-green-500' : 'text-yellow-500'}>{discovery.self?.advertising ? 'yes' : 'no'}</span>
                {' '}· self: <span className="font-mono">{discovery.self?.name} #{discovery.self?.port}</span>
                {' '}· found {discovery.discovered?.length ?? 0} other companion(s). Discovery never pairs automatically — connecting asks for the peer's pairing code.
              </p>
            )}
            {!!discovery.discovered?.length && (
              <div className="space-y-1.5">
                {discovery.discovered.map((d: any) => (
                  <div key={d.instanceId} className="flex items-center gap-2 rounded border border-white/10 px-2 py-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${d.online ? 'bg-green-500' : 'bg-zinc-600'}`} title={d.online ? 'online' : `last seen ${d.secondsSinceSeen}s ago`} />
                    <span className="font-medium">{d.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground truncate">{d.host}:{d.port}</span>
                    {d.version && <Badge variant="outline" className="text-[9px] shrink-0">v{d.version}</Badge>}
                    {d.platform && <Badge variant="outline" className="text-[9px] shrink-0">{d.platform}</Badge>}
                    <span className="ml-auto flex gap-1 shrink-0">
                      {pairCodeFor === d.instanceId ? (
                        <>
                          <Input value={pairCode} onChange={(e) => setPairCode(e.target.value.toUpperCase())} placeholder="PAIRING CODE" className="h-6 w-36 text-[11px] font-mono" />
                          <Button size="sm" className="h-6 px-2 text-[10px]" onClick={() => connectDiscovered(d.url, pairCode)}><Link2 className="w-3 h-3 mr-1" /> Pair</Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => { setPairCodeFor(null); setPairCode(''); }}><XCircle className="w-3 h-3" /></Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => { setForm({ ...form, url: d.url }); setAdding(true); }}>Use URL</Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setPairCodeFor(d.instanceId)}><Link2 className="w-3 h-3 mr-1" /> Connect</Button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {adding && (
        <Card>
          <CardContent className="py-3 grid grid-cols-3 gap-3 items-end">
            <div className="space-y-1"><Label>Label</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Portable" /></div>
            <div className="space-y-1"><Label>Companion URL</Label><Input className="font-mono text-sm" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://192.168.1.20:7337" /></div>
            <div className="space-y-1"><Label>Role</Label><Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="on-demand GPU resources" /></div>
            <Button size="sm" onClick={addMachine} className="col-span-3 w-fit">Add</Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="rounded-xl border bg-card/40 p-4">
          <svg viewBox="0 0 440 330" className="w-full" style={{ maxHeight: 380 }}>
            {layout.map(({ m, x, y }) => (
              <g key={m.id} onClick={() => setSelected(m.id === selected ? null : m.id)} style={{ cursor: 'pointer' }}>
                <line x1={220} y1={165} x2={x} y2={y} stroke={m.id === selected ? '#a78bfa' : '#52525b'} strokeDasharray={m.state === 'unreachable' ? '4 3' : undefined} strokeWidth={m.id === selected ? 2 : 1} />
              </g>
            ))}
            <g>
              <circle cx={220} cy={165} r={26} fill="#a78bfa22" stroke="#a78bfa" strokeWidth={1.5} />
              <text x={220} y={160} textAnchor="middle" fill="currentColor" fontSize={11} className="fill-foreground">IDE</text>
              <text x={220} y={175} textAnchor="middle" fill="#a1a1aa" fontSize={8}>{wsStore.workspaceId ? 'workspace active' : 'no workspace'}</text>
            </g>
            {layout.map(({ m, x, y }) => (
              <g key={m.id}>
                <circle cx={x} cy={y} r={m.id === selected ? 17 : 14} fill={`${MACHINE_STATE_COLORS[m.state]}22`} stroke={MACHINE_STATE_COLORS[m.state]} strokeWidth={1.5} />
                <text x={x} y={y + 30} textAnchor="middle" fontSize={10} className="fill-foreground">{m.label}</text>
                <text x={x} y={y + 42} textAnchor="middle" fontSize={8} fill="#a1a1aa">{m.state}</text>
              </g>
            ))}
          </svg>
          <p className="text-[11px] text-muted-foreground text-center">Click a machine for details · refresh is manual (no background polling)</p>
        </div>

        <div className="space-y-3">
          {sel ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between">
                  {sel.label}
                  <Badge variant="outline" style={{ color: MACHINE_STATE_COLORS[sel.state], borderColor: MACHINE_STATE_COLORS[sel.state] }} className="text-[10px]">{sel.state}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs space-y-1.5">
                <p className="text-muted-foreground">{sel.role || '(no role set)'}</p>
                <p className="font-mono text-[11px] break-all">{sel.url}</p>
                {sel.hostname && <p>hostname: <span className="font-mono">{sel.hostname}</span></p>}
                {sel.companionVersion && <p>companion: v{sel.companionVersion} ({sel.platform})</p>}
                {sel.resources && (
                  <p>resources: {sel.resources.cpus} CPUs · load {sel.resources.load1?.toFixed(2)} · {Math.round((1 - sel.resources.memFree / sel.resources.memTotal) * 100)}% memory used</p>
                )}
                {sel.modelCount != null && <p>providers: {sel.modelCount}</p>}
                {sel.workspaces?.length ? <p>workspaces: {sel.workspaces.map((w) => w.name).join(', ')}</p> : null}
                {sel.error && <p className="text-destructive">{sel.error}</p>}
                {activeRun && activeRun.providerLabel === sel.url && <p className="text-primary">▶ active run: {activeRun.task.slice(0, 60)}</p>}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={() => probe(sel)}><RefreshCw className="w-3 h-3 mr-1" /> Probe</Button>
                  <Button size="sm" variant="ghost" onClick={() => fleet.updateMachine(sel.id, { hasToken: !sel.hasToken })} title="Toggle whether the paired token is reused for this machine">
                    {sel.hasToken ? 'token: on' : 'token: off'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { fleet.removeMachine(sel.id); setSelected(null); }}><Trash2 className="w-3 h-3" /></Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-4 text-xs text-muted-foreground">
                Select a machine node to inspect connection, companion, resources, workspaces and live activity.
                Machine labels and roles are yours to edit; states come only from real probes.
              </CardContent>
            </Card>
          )}

          {/* Milestone 2: fleet task packets on the active workspace */}
          {wsStore.workspaceId && (
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm flex items-center justify-between">
                  Fleet tasks
                  <Button size="sm" variant="ghost" className="h-6 px-2" onClick={refreshFleetTasks}><RefreshCw className="w-3 h-3 mr-1" /> refresh</Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs space-y-1.5">
                {fleetTasks === null && <p className="text-muted-foreground">Press refresh to load task packets for this workspace.</p>}
                {fleetTasks?.length === 0 && <p className="text-muted-foreground">No task packets yet — distributed fan-out creates them here.</p>}
                {fleetTasks?.map((t: any) => (
                  <div key={t.id} className="flex items-center gap-2 rounded border border-white/10 px-2 py-1">
                    <Badge variant="outline" className={`text-[9px] shrink-0 ${t.status === 'completed' ? 'text-green-500 border-green-500/40' : t.status === 'failed' ? 'text-red-500 border-red-500/40' : t.status === 'cancelled' ? 'text-zinc-500' : 'text-blue-400 border-blue-500/40'}`}>{t.status}</Badge>
                    <span className="truncate">{t.title}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{t.assignedMachine || t.machineId || 'unassigned'} · {t.progress?.length ?? 0} updates</span>
                    {['queued', 'acknowledged', 'in-progress'].includes(t.status) && (
                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] text-red-400 shrink-0" onClick={async () => { try { await mesh.client().cancelTask(wsStore.workspaceId!, t.id, { reason: 'cancelled from Fleet Map' }); refreshFleetTasks(); } catch { /* ignore */ } }}>cancel</Button>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Runs (Part 5)
// ---------------------------------------------------------------------------

const OP_ICONS: Record<string, any> = {
  task: Rocket, stage: GitBranch, tool: Wrench, notice: Activity, error: AlertTriangle,
  steering: Send, recovery: RefreshCw, gate: ShieldCheck, handoff: GitBranch,
  approval: Square, final: ShieldCheck,
};

function LiveRuns() {
  const runs = useRuns();
  const agent = useAgent();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openOp, setOpenOp] = useState<string | null>(null);
  const [steerText, setSteerText] = useState('');

  const selected = runs.runs.find((r) => r.id === selectedId) ?? runs.runs[0] ?? null;
  const running = selected?.status === 'running';

  const dur = (r: LiveRun) => ((r.endedAt ?? Date.now()) - r.startedAt);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      {/* run list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Runs</p>
          <Button size="sm" variant="ghost" onClick={() => runs.clearRuns()}><Trash2 className="w-3.5 h-3.5" /></Button>
        </div>
        {runs.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs recorded yet. Start a task in the IDE.</p>}
        {runs.runs.map((r) => (
          <button
            key={r.id}
            onClick={() => { setSelectedId(r.id); setOpenOp(null); }}
            className={`w-full text-left rounded-lg border p-2.5 hover:border-primary/60 ${selected?.id === r.id ? 'border-primary bg-primary/5' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`text-[9px] ${PROJECT_STATUS_COLORS[r.status === 'done' ? 'COMPLETE' : r.status === 'running' ? 'ACTIVE' : r.status === 'paused' ? 'PAUSED' : r.status === 'failed' ? 'FAILED' : r.status === 'stopped' ? 'BLOCKED' : 'NEW'] ?? ''}`}>{r.status}</Badge>
              <span className="text-xs font-medium truncate flex-1">{r.task.slice(0, 42) || '(continued run)'}</span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 flex gap-2 flex-wrap">
              <span>{new Date(r.startedAt).toLocaleTimeString()}</span>
              <span>{(dur(r) / 1000).toFixed(0)}s</span>
              <span className="font-mono truncate max-w-[120px]">{r.model}</span>
              {r.completion && <span className="text-foreground">· {r.completion.status}</span>}
            </div>
          </button>
        ))}
      </div>

      {/* timeline */}
      <div className="space-y-3">
        {selected ? (
          <>
            <Card>
              <CardContent className="py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{selected.task || '(continued run)'}</p>
                    <p className="text-[11px] text-muted-foreground">{selected.mode} · {selected.providerLabel ?? ''} · <span className="font-mono">{selected.model}</span> · {selected.projectName ? `project: ${selected.projectName}` : 'no project bound'}</p>
                  </div>
                  {selected.completion && (
                    <Badge variant="outline" className={`shrink-0 ${PROJECT_STATUS_COLORS[selected.completion.status] ?? ''}`}>{selected.completion.status}</Badge>
                  )}
                </div>
                {/* controls for the ACTIVE run: steer / stop / continue */}
                <div className="flex items-center gap-2 pt-1">
                  {running ? (
                    <>
                      <Input
                        className="h-8 text-xs flex-1"
                        placeholder="Steer the running agent (applied at the next turn)…"
                        value={steerText}
                        onChange={(e) => setSteerText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && steerText.trim()) { agent.controls?.steer?.(steerText.trim()); setSteerText(''); } }}
                      />
                      <Button size="sm" variant="secondary" disabled={!steerText.trim()} onClick={() => { agent.controls?.steer?.(steerText.trim()); setSteerText(''); }}>Steer</Button>
                      <Button size="sm" variant="destructive" onClick={() => agent.controls?.stop?.()}><Square className="w-3.5 h-3.5 mr-1" /> Stop</Button>
                    </>
                  ) : selected.status === 'paused' ? (
                    <Button size="sm" variant="secondary" onClick={() => agent.controls?.continue?.()}><Play className="w-3.5 h-3.5 mr-1" /> Continue task</Button>
                  ) : null}
                </div>
                {selected.completion && selected.completion.reasons.length > 0 && (
                  <div className="text-[11px] text-muted-foreground border-t pt-2 space-y-1">
                    {selected.completion.reasons.slice(0, 4).map((r, i) => <p key={i}>• {r}</p>)}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="rounded-xl border bg-card/40">
              <p className="text-xs font-medium px-3 py-2 border-b text-muted-foreground">Operation timeline ({selected.ops.length}) — the actual sequence, not a summary</p>
              <div className="max-h-[420px] overflow-y-auto lf-scroll divide-y">
                {selected.ops.length === 0 && <p className="text-xs text-muted-foreground p-3">No operations recorded.</p>}
                {selected.ops.map((op) => {
                  const Icon = OP_ICONS[op.kind] ?? Activity;
                  const open = openOp === op.id;
                  return (
                    <div key={op.id}>
                      <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/40" onClick={() => setOpenOp(open ? null : op.id)}>
                        <Icon className={`w-3.5 h-3.5 shrink-0 ${op.status === 'error' ? 'text-destructive' : op.kind === 'recovery' ? 'text-amber-500' : 'text-muted-foreground'}`} />
                        <span className={`font-mono text-[10px] text-muted-foreground w-14 shrink-0`}>{new Date(op.ts).toLocaleTimeString([], { hour12: false })}</span>
                        <span className="truncate flex-1 text-left">{op.summary}</span>
                        {op.status === 'error' && <Badge variant="outline" className="text-[9px] text-destructive border-destructive/40 shrink-0">error</Badge>}
                        {op.status === 'blocked' && <Badge variant="outline" className="text-[9px] text-amber-500 border-amber-500/40 shrink-0">blocked</Badge>}
                        {op.durMs != null && <span className="text-[10px] text-muted-foreground shrink-0">{(op.durMs / 1000).toFixed(1)}s</span>}
                        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                      </button>
                      {open && (
                        <div className="px-3 pb-2.5 pl-9 space-y-1.5">
                          {op.tool && <p className="text-[10px] text-muted-foreground">tool: <span className="font-mono">{op.tool}</span>{op.machine ? ` · machine: ${op.machine}` : ''}{op.exitCode != null ? ` · exit: ${op.exitCode}` : ''}</p>}
                          {op.detail ? (
                            <pre className="font-mono text-[10px] bg-muted/60 rounded p-2 whitespace-pre-wrap max-h-52 overflow-y-auto lf-scroll">{op.detail}</pre>
                          ) : (
                            <p className="text-[10px] text-muted-foreground">No captured output for this operation.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">Select a run to see its operation timeline, failures and recovery attempts.</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
