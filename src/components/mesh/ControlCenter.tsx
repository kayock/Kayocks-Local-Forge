'use client';

// Control Center (Phase 2.0 spec §10): one graphical interface for Computers,
// Model Manager, Agents, Shared Notebook and mesh diagnostics. Uses the
// existing graphite/purple design language. Every action maps to a real
// companion API — no mock controls.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMesh } from '@/lib/store/mesh';
import { useWorkspace } from '@/lib/store/workspace';
import { useSettings } from '@/lib/store/settings';
import { CompanionClient } from '@/lib/companion/client';
import { clientForMachine, launchCollaborativeTask, runDistributedFanout, startCollabRun, type CollabRunMode, type CollabRunHandle, type CollabParticipant, type CollabTaskConfig, type CollabRole } from '@/lib/agent/collab-service';
import { defaultParticipation, isExcludedWindowsLlama, isPlaceholderEndpoint, resolveParticipation, type ParticipationMode } from '@/lib/fleet/participation';
import type { ProtocolSetting } from '@/lib/store/settings';
import type { AgentEvent } from '@/lib/agent/types';
import type { CoordinatorReport } from '@/lib/agent/coordinator';
import type { AgentAssignment, LoadResult, ModelInventory, ModelProfile, StartupDiagnostics } from '@/lib/mesh-types';
import {
  Activity, Cpu, HardDrive, Laptop, Loader2, MemoryStick, MonitorSmartphone, NotebookPen,
  Plus, RefreshCw, Server, Trash2, Unplug, Wrench, Zap, CircleAlert, Play, Square, Plug,
  Users, Send, Pause, StopCircle, Bot, MessageSquarePlus, Repeat, Network, Wifi,
} from 'lucide-react';

const fmtBytes = (n?: number | null) => {
  if (n == null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${n} B`;
};

const platformLabel = (p?: string) => (p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p || '—');

const statusBadge = (s?: string | null) => {
  const cls = /ready|connected|done|paired/.test(s || '') ? 'text-green-600 border-green-500/40'
    : /fail|error|unreach|blocked/.test(s || '') ? 'text-destructive border-destructive/40'
    : /load|progress|working/.test(s || '') ? 'text-primary border-primary/40'
    : 'text-muted-foreground';
  return <Badge variant="outline" className={`text-[10px] ${cls}`}>{s || '—'}</Badge>;
};

export function ControlCenter() {
  const mesh = useMesh();
  const ws = useWorkspace();
  const settings = useSettings();
  const [tab, setTab] = useState('computers');

  useEffect(() => {
    mesh.refreshMesh();
    mesh.refreshModels().catch(() => {});
    if (ws.workspaceId) {
      mesh.refreshAssignments(ws.workspaceId);
      mesh.refreshNotebook(ws.workspaceId);
    }
    const t = setInterval(() => {
      mesh.refreshMesh();
      mesh.refreshModels().catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [ws.workspaceId]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <span className="font-semibold tracking-tight">LocalForge <span className="text-primary">Control Center</span></span>
          <Badge variant="outline" className="text-[10px]">companion {mesh.primaryHardware ? 'connected' : 'offline'}</Badge>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => mesh.refreshMesh()}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh</Button>
            <Button variant="ghost" size="sm" onClick={() => window.location.hash = '#/ide'}>Back to IDE</Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="computers"><MonitorSmartphone className="w-3.5 h-3.5 mr-1.5" />Computers</TabsTrigger>
            <TabsTrigger value="models"><Server className="w-3.5 h-3.5 mr-1.5" />Model Manager</TabsTrigger>
            <TabsTrigger value="agents"><Activity className="w-3.5 h-3.5 mr-1.5" />Agents</TabsTrigger>
            <TabsTrigger value="collaborate"><Users className="w-3.5 h-3.5 mr-1.5" />Collaborate</TabsTrigger>
            <TabsTrigger value="notebook"><NotebookPen className="w-3.5 h-3.5 mr-1.5" />Shared Notebook</TabsTrigger>
          </TabsList>
          <TabsContent value="computers"><ComputersTab /></TabsContent>
          <TabsContent value="models"><ModelsTab /></TabsContent>
          <TabsContent value="agents"><AgentsTab assignments={mesh.assignments} onLaunch={() => setTab('collaborate')} /></TabsContent>
          <TabsContent value="collaborate"><CollaborateTab /></TabsContent>
          <TabsContent value="notebook"><NotebookTab /></TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Computers
// ---------------------------------------------------------------------------
function HardwareCard({ hw, name, suffix }: { hw: NonNullable<ReturnType<typeof useMesh.getState>['primaryHardware']> | null; name: string; suffix?: string }) {
  if (!hw) return null;
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-primary" />
        <span className="font-medium text-sm">{name}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{suffix}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p>CPU: <span className="text-foreground font-mono">{hw.cpuModel || '—'} · {hw.cpuCores} cores</span></p>
        <p>RAM: <span className="text-foreground font-mono">{fmtBytes(hw.ramAvailableBytes)} free / {fmtBytes(hw.ramTotalBytes)}</span></p>
        <p>GPU: <span className="text-foreground font-mono">{hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramBytes ? ` (${fmtBytes(g.vramBytes)})` : ''}`).join(', ') : 'not detected'}</span></p>
        <p>NPU: <span className="text-foreground font-mono">{hw.npu.detected ? `${hw.npu.runtime || 'device detected'}` : 'not detected'}</span></p>
        <p className="col-span-2">Inference runtimes: <span className="text-foreground font-mono">{hw.inferenceRuntimes.join(', ') || 'none found in PATH'}</span></p>
        <p className="col-span-2 text-[10px]">Measured {new Date(hw.measuredAt).toLocaleTimeString()} · {platformLabel(hw.platform)} {hw.platformVersion}</p>
      </div>
    </div>
  );
}

function ComputersTab() {
  const mesh = useMesh();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const connect = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setMsg(null);
    const r = await mesh.connectPeer(url.trim(), { name: name.trim() || undefined, code: code.trim() || undefined });
    setBusy(false);
    setMsg(r.ok ? 'Connected' + (code.trim() ? ' and paired' : ' (register only — pair with the peer code to proxy requests)') : r.error || 'Failed');
    if (r.ok) { setUrl(''); setCode(''); setName(''); }
  };

  return (
    <div className="space-y-4">
      <HardwareCard hw={mesh.primaryHardware} name="This computer (primary)" suffix={mesh.models ? `${mesh.models.servers.filter((s) => s.status === 'ready').length} model server(s) ready` : undefined} />

      <FleetParticipation />

      {/* connect form */}
      <div className="rounded-lg border p-3 space-y-2">
        <p className="text-sm font-medium flex items-center gap-2"><Plug className="w-4 h-4 text-primary" /> Connect a computer</p>
        <p className="text-[11px] text-muted-foreground">Peers on the LAN appear below automatically (passive discovery — no scanning). Otherwise add one by IP/hostname; pairing uses the peer's own pairing code.</p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <Input placeholder="http://192.168.1.20:7337" value={url} onChange={(e) => setUrl(e.target.value)} className="sm:col-span-2" />
          <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Pairing code (optional)" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={connect} disabled={busy || !url.trim()}>{busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plug className="w-3.5 h-3.5 mr-1" />} Connect{code.trim() ? ' & pair' : ''}</Button>
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
        </div>
      </div>

      {/* paired peers */}
      {mesh.peers.map((p) => {
        const st = mesh.peerStatus[p.id];
        return (
          <div key={p.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Laptop className="w-4 h-4 text-primary" />
              <span className="font-medium text-sm">{p.name}</span>
              {statusBadge(st ? (st.reachable ? 'connected' : 'unreachable') : p.lastStatus)}
              <Badge variant="outline" className="text-[10px]">{platformLabel(p.platform)}</Badge>
              <span className="text-[10px] text-muted-foreground">v{p.version || '?'} · {p.buildId || '?'}</span>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => mesh.client().peerStatus(p.id).then(() => mesh.refreshMesh()).catch(() => mesh.refreshMesh())}><RefreshCw className="w-3 h-3 mr-1" />Reconnect</Button>
                <Button size="sm" variant="outline" className="h-6 text-[10px] text-destructive" onClick={() => mesh.removePeer(p.id)}><Unplug className="w-3 h-3 mr-1" />Remove</Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground font-mono">{p.url}</p>
            {st?.hardware && <HardwareCard hw={st.hardware} name={`${p.name} — hardware`} suffix="via mesh" />}
            {st && !st.reachable && <p className="text-[11px] text-destructive">Peer is unreachable right now — agents assigned to it are deferred, not lost.</p>}
          </div>
        );
      })}

      {/* discovered (unpaired) */}
      {mesh.discovered.filter((d) => !mesh.peers.some((p) => p.url === d.url)).length > 0 && (
        <div className="rounded-lg border border-dashed p-3 space-y-2">
          <p className="text-sm font-medium">Discovered on this LAN (not connected yet)</p>
          {mesh.discovered.filter((d) => !mesh.peers.some((p) => p.url === d.url)).map((d) => (
            <div key={d.url} className="flex items-center gap-2 text-xs">
              <HardDrive className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="font-mono">{d.name}</span>
              <span className="text-muted-foreground">{platformLabel(d.platform)} · v{d.version} · {d.url}</span>
              <Button size="sm" variant="outline" className="ml-auto h-6 text-[10px]" onClick={() => { setUrl(d.url); window.scrollTo({ top: 0 }); }}>Use this address</Button>
            </div>
          ))}
        </div>
      )}

      {mesh.lastError && <p className="text-xs text-destructive">{mesh.lastError}</p>}

      {/* Companion Networking (Phase 2.2 Fix 1) — graphical LAN configuration
          for the selected computer: no terminal, no systemd edits. */}
      <NetworkingPanel />
    </div>
  );
}

interface NetInfo {
  host: string; port: number; lanEnabled: boolean;
  active: { host: string; port: number };
  pendingRestart: boolean;
  lanAddresses: { name: string; address: string; url?: string }[];
  loopbackUrl: string;
  security: { pairingRequired: boolean; note: string };
  service: { systemdUnit: string; managementHint: string };
}

function FleetParticipation() {
  const mesh = useMesh();
  const [overrides, setOverrides] = useState<Record<string, ParticipationMode>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    mesh.client().fleetParticipation().then((r) => setOverrides(r.participation || {})).catch(() => setNote('Participation settings are unavailable until the companion answers.'));
  }, [mesh.peers.length]);

  const rows = [
    {
      machineId: 'local',
      name: mesh.primaryHardware?.hostname || 'This computer',
      platform: mesh.primaryHardware?.platform,
      connected: !!mesh.primaryHardware,
    },
    ...mesh.peers.map((p) => ({
      machineId: p.id,
      name: p.name,
      platform: p.platform || mesh.peerStatus[p.id]?.health?.platform,
      connected: mesh.peerStatus[p.id] ? !!mesh.peerStatus[p.id].reachable : p.lastStatus !== 'unreachable',
    })),
  ];

  const roleOf = (machineId: string, name: string, platform?: string) => {
    const mode = resolveParticipation({ machineId, name, platform }, overrides);
    if (mode === 'controller' || machineId === 'local') return 'Controller';
    if (defaultParticipation({ machineId, name, platform }) === 'enabled' || /portable/i.test(name)) return 'Primary worker';
    return 'Secondary worker';
  };

  const setMode = async (machineId: string, mode: ParticipationMode) => {
    setNote(null);
    try {
      const r = await mesh.client().setFleetParticipation(machineId, mode);
      setOverrides(r.participation || {});
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <p className="text-sm font-medium">Fleet participation</p>
      <p className="text-[11px] text-muted-foreground">Connected does not mean eligible. Manual machines stay visible and are used only when a run explicitly includes them. A busy or failed preferred worker does not move work onto a manual machine.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-1 pr-3 font-medium">Machine</th><th className="py-1 pr-3 font-medium">Role</th><th className="py-1 pr-3 font-medium">Connected</th><th className="py-1 font-medium">Participation</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const mode = resolveParticipation(row, overrides);
              return (
                <tr key={row.machineId} className="border-t">
                  <td className="py-1.5 pr-3">{row.name}</td>
                  <td className="py-1.5 pr-3">{roleOf(row.machineId, row.name, row.platform)}</td>
                  <td className="py-1.5 pr-3">{row.connected ? 'Yes' : 'No'}</td>
                  <td className="py-1.5">
                    {row.machineId === 'local' ? <span>Controller</span> : (
                      <Select value={mode === 'controller' ? 'manual' : mode} onValueChange={(v) => setMode(row.machineId, v as ParticipationMode)}>
                        <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="enabled">Enabled</SelectItem>
                          <SelectItem value="manual">Manual only</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="text-[11px] text-destructive">{note}</p>}
    </div>
  );
}

function NetworkingPanel() {
  const mesh = useMesh();
  const [machineId, setMachineId] = useState<string>('local');
  const [net, setNet] = useState<NetInfo | null>(null);
  const [host, setHost] = useState<string>('127.0.0.1');
  const [busy, setBusy] = useState(false);
  const [applyOut, setApplyOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [testUrl, setTestUrl] = useState('');
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const peer = machineId === 'local' ? null : machineId;
  const peerName = machineId === 'local' ? 'This computer' : (mesh.peers.find((p) => p.id === machineId)?.name || machineId);

  const load = useCallback(async () => {
    try {
      const n = await mesh.client().network(peer);
      setNet(n);
      setHost(n.host);
      setLoadErr(null);
    } catch (e: any) {
      setNet(null);
      setLoadErr(`Cannot read the networking configuration of ${peerName}: ${String(e.message || e)}. Is its companion paired and reachable?`);
    }
     
  }, [mesh.client, peer, peerName]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const apply = async () => {
    setBusy(true);
    setApplyOut(null);
    try {
      const r = await mesh.client().setNetwork({ host }, peer);
      setApplyOut({ ok: true, text: `Applied — re-binding ${peerName} to ${r.host}:${r.port}…` });
      await new Promise((res) => setTimeout(res, 800)); // re-bind completes just after the response drains
      await load();
      setApplyOut({ ok: true, text: `Applied and confirmed — active listener: ${net?.active.host ?? r.host}:${net?.active.port ?? r.port}. Configuration persisted.` });
    } catch (e: any) {
      setApplyOut({ ok: false, text: String(e.message || e) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!testUrl.trim()) { setTestOut({ ok: false, text: 'Enter an address first, e.g. http://192.168.1.20:7337' }); return; }
    setTestOut({ ok: true, text: 'Testing…' });
    try {
      const r = await mesh.client().networkTest(testUrl.trim(), peer);
      setTestOut(r.reachable
        ? { ok: true, text: r.isLocalforgeCompanion ? `Reachable — a LocalForge companion v${r.version} answered.` : 'Something answered, but it is NOT a LocalForge companion.' }
        : { ok: false, text: r.detail });
    } catch (e: any) {
      setTestOut({ ok: false, text: String(e.message || e) });
    }
  };

  const lanOn = net ? net.active.host !== '127.0.0.1' : false;
  const options: { value: string; label: string }[] = [
    { value: '127.0.0.1', label: 'Loopback only — this computer (LAN off)' },
    { value: '0.0.0.0', label: 'All interfaces — LAN on' },
    ...((net?.lanAddresses || []).filter((a) => a.address !== '127.0.0.1').map((a) => ({ value: a.address, label: `${a.address} — interface ${a.name}` }))),
  ];

  return (
    <div className="rounded-lg border p-3 space-y-3" id="companion-networking">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm font-medium flex items-center gap-2"><Network className="w-4 h-4 text-primary" /> Companion networking</p>
        <Select value={machineId} onValueChange={(v) => { setMachineId(v); setApplyOut(null); setTestOut(null); }}>
          <SelectTrigger className="w-[220px] h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="local">This computer (primary)</SelectItem>
            {mesh.peers.filter((p) => p.paired).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {lanOn ? (
          <Badge variant="outline" className="text-[10px] text-green-600 border-green-500/40"><Wifi className="w-3 h-3 mr-1" />LAN access ON</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">LAN off (loopback only)</Badge>
        )}
      </div>

      {loadErr && (
        <p className="text-xs text-destructive flex items-center gap-1.5"><CircleAlert className="w-3.5 h-3.5" /> {loadErr}</p>
      )}

      {net && (
        <>
          {/* current status — the ACTIVE listener, not merely the requested config */}
          <div className="text-[11px] grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
            <p>Listening on: <span className="text-foreground font-mono">{net.active.host}:{net.active.port}</span>{net.pendingRestart && <span className="text-yellow-600"> (applying {net.host}:{net.port}…)</span>}</p>
            <p>Loopback URL: <span className="text-foreground font-mono">{net.loopbackUrl}</span></p>
            <p>LAN addresses: <span className="text-foreground font-mono">{net.lanAddresses.map((a) => a.address).join(', ') || 'none detected'}</span></p>
            <p>Interfaces: <span className="text-foreground font-mono">{[...new Set(net.lanAddresses.map((a) => a.name))].join(', ') || '—'}</span></p>
          </div>
          <p className="text-[10px] text-muted-foreground">{net.security.note} {net.service.managementHint}</p>

          {/* bind selector: loopback / all interfaces / specific address */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs">Listen on:</span>
            <Select value={host} onValueChange={setHost}>
              <SelectTrigger className="w-[300px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-7 text-[11px]" onClick={apply} disabled={busy || host === net.active.host}>
              {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />Save &amp; Apply</>}
            </Button>
          </div>

          {/* connection test */}
          <div className="flex items-center gap-2 flex-wrap">
            <Input className="h-7 text-xs w-[280px]" placeholder="Test another companion: http://192.168.1.20:7337" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} />
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={runTest}><Wrench className="w-3 h-3 mr-1" />Connection test</Button>
          </div>

          {applyOut && <p className={`text-xs flex items-center gap-1.5 ${applyOut.ok ? 'text-green-600' : 'text-destructive'}`}><CircleAlert className="w-3.5 h-3.5" />{applyOut.text}</p>}
          {testOut && <p className={`text-xs flex items-center gap-1.5 ${testOut.ok ? 'text-green-600' : 'text-destructive'}`}><CircleAlert className="w-3.5 h-3.5" />{testOut.text}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Manager
// ---------------------------------------------------------------------------
function ModelsTab() {
  const mesh = useMesh();
  const [machineId, setMachineId] = useState<string>('local'); // 'local' | mesh peer id
  const [inv, setInv] = useState<ModelInventory | null>(null);
  const [loadingInv, setLoadingInv] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [diag, setDiag] = useState<{ server: any; diagnostics: StartupDiagnostics | null } | null>(null);
  const [logs, setLogs] = useState<{ server: any; output: string; status: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const peer = machineId === 'local' ? null : machineId;
  const peerName = machineId === 'local' ? 'This computer' : (mesh.peers.find((p) => p.id === machineId)?.name || machineId);

  const loadInventory = useCallback(async (id: string) => {
    setLoadingInv(true);
    try {
      const data = await mesh.client().models(id === 'local' ? null : id);
      setInv(data);
    } catch (e: any) {
      setInv(null);
      setResult({ ok: false, text: `Cannot reach ${id === 'local' ? 'this computer' : peerName}: ${String(e.message || e)}` });
    } finally {
      setLoadingInv(false);
    }
     
  }, [mesh.client, peerName]);

  useEffect(() => {
    loadInventory(machineId);
    const t = setInterval(() => loadInventory(machineId), 15000);
    return () => clearInterval(t);
  }, [machineId, loadInventory]);

  const doLoad = async (profileId: string) => {
    setBusy(profileId);
    setResult(null);
    try {
      const r: LoadResult = await mesh.client().loadModel(profileId, peer);
      if (r.error) {
        setResult({ ok: false, text: r.error });
        if (r.server?.id) {
          const d = await mesh.client().modelDiagnostics(r.server.id, peer).catch(() => null);
          if (d?.diagnostics) setDiag(d);
        }
      } else {
        setResult({ ok: true, text: `${r.server?.profileName} ready at ${r.server?.endpoint} on ${peerName} (loaded in ${((r.server?.loadMs ?? 0) / 1000).toFixed(1)}s)` });
      }
    } catch (e: any) {
      setResult({ ok: false, text: String(e.message || e) });
    } finally {
      setBusy(null);
      loadInventory(machineId);
    }
  };

  const doUnload = async (serverId?: string, profileId?: string) => {
    setBusy(serverId || profileId || '');
    try {
      const r: any = await mesh.client().unloadModel({ serverId, profileId }, peer);
      if (r?.error) setResult({ ok: false, text: r.error });
      else if (r?.unloaded === false) setResult({ ok: false, text: 'Unload not confirmed by the backend (check its logs)' });
      else setResult({ ok: true, text: `Unloaded on ${peerName}` });
    } catch (e: any) {
      setResult({ ok: false, text: String(e.message || e) });
    } finally {
      setBusy(null);
      loadInventory(machineId);
    }
  };

  const showLogs = async (srv: any) => {
    try {
      const o = await mesh.client().serverOutput(srv.id, peer);
      setLogs({ server: srv, output: o.output?.slice(-6000) || '(no output captured yet)', status: o.proc.status });
    } catch (e: any) {
      setLogs({ server: srv, output: `Cannot read logs: ${String(e.message || e)}`, status: '?' });
    }
  };

  if (loadingInv && !inv) return <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading inventory from {peerName}…</p>;

  return (
    <div className="space-y-4">
      {/* machine selector — the Model Manager operates on ANY trusted computer */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">Operating on:</span>
          <Select value={machineId} onValueChange={(v) => { setMachineId(v); setResult(null); }}>
            <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">This computer (primary companion)</SelectItem>
              {mesh.peers.filter((p) => p.paired).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name} ({platformLabel(p.platform)})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="outline" className="text-[10px]">every action below executes on the selected machine</Badge>
          <Button size="sm" variant="outline" className="ml-auto h-7 text-[11px]" onClick={() => loadInventory(machineId)} disabled={loadingInv}>
            {loadingInv ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />} Refresh
          </Button>
        </div>
        {inv?.hardware && (
          <div className="text-[11px] text-muted-foreground grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
            <p>CPU: <span className="text-foreground font-mono">{inv.hardware.cpuModel?.slice(0, 28) || '—'} · {inv.hardware.cpuCores}c</span></p>
            <p>RAM: <span className="text-foreground font-mono">{fmtBytes(inv.hardware.ramAvailableBytes)} free / {fmtBytes(inv.hardware.ramTotalBytes)}</span></p>
            <p>GPU: <span className="text-foreground font-mono">{inv.hardware.gpus.map((g) => g.name).join(', ') || 'not detected'}</span></p>
            <p>Runtimes: <span className="text-foreground font-mono">{inv.hardware.inferenceRuntimes.join(', ') || 'none'}</span></p>
          </div>
        )}
      </div>

      {result && (
        <p className={`text-xs ${result.ok ? 'text-green-600' : 'text-destructive'} flex items-center gap-1.5`}>
          <CircleAlert className="w-3.5 h-3.5" /> {result.text}
        </p>
      )}

      {/* managed servers on the selected machine */}
      {inv && inv.servers.filter((x) => x.status !== 'stopped').length > 0 && (
        <div className="rounded-lg border">
          <p className="px-3 py-2 text-xs font-medium border-b flex items-center gap-2"><Zap className="w-3.5 h-3.5 text-primary" /> Servers on {peerName}</p>
          {inv.servers.map((srv) => (
            <div key={srv.id} className="px-3 py-2 flex items-center gap-2 text-xs border-b last:border-0">
              <span className="font-mono">{srv.profileName}</span>
              {statusBadge(srv.status)}
              <span className="text-muted-foreground">{srv.backend} · {srv.endpoint}{srv.loadMs ? ` · loaded in ${(srv.loadMs / 1000).toFixed(1)}s` : ''}{srv.exitCode != null ? ` · exit ${srv.exitCode}` : ''}</span>
              <div className="ml-auto flex gap-1.5">
                {srv.status === 'ready' && srv.ownership === 'localforge-managed' && (
                  <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy === srv.id} onClick={() => doUnload(srv.id)}>
                    {busy === srv.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Square className="w-3 h-3 mr-1" />Unload</>}
                  </Button>
                )}
                {srv.status !== 'stopped' && srv.ownership === 'localforge-managed' && (
                  <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => showLogs(srv)}><Wrench className="w-3 h-3 mr-1" />Logs</Button>
                )}
                {(srv.status === 'failed' || srv.hasDiagnostics) && (
                  <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={async () => setDiag(await mesh.client().modelDiagnostics(srv.id, peer))}><CircleAlert className="w-3 h-3 mr-1" />Diagnostics</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* recent startup errors on the selected machine */}
      {inv && inv.servers.filter((x) => x.status === 'failed').length > 0 && (
        <div className="rounded-lg border border-destructive/40">
          <p className="px-3 py-2 text-xs font-medium border-b text-destructive">Recent startup errors on {peerName}</p>
          {inv.servers.filter((x) => x.status === 'failed').map((srv) => (
            <div key={srv.id} className="px-3 py-2 text-xs border-b last:border-0 space-y-1">
              <p className="flex items-center gap-2"><span className="font-mono">{srv.profileName}</span>{statusBadge(srv.status)}<span className="text-muted-foreground">{srv.lastError?.slice(0, 160)}</span></p>
              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={async () => setDiag(await mesh.client().modelDiagnostics(srv.id, peer))}><CircleAlert className="w-3 h-3 mr-1" />Open diagnostics</Button>
            </div>
          ))}
        </div>
      )}

      {/* profiles on the selected machine */}
      {inv && (
        <div className="rounded-lg border">
          <p className="px-3 py-2 text-xs font-medium border-b flex items-center justify-between">
            <span>Model profiles on {peerName}</span>
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setShowCreate(true)}><Plus className="w-3 h-3 mr-1" /> New profile</Button>
          </p>
          {inv.profiles.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No profiles on this machine yet. A profile registers a model with a supported backend — nothing is moved or downloaded.</p>}
          {inv.profiles.map((p) => (
            <div key={p.id} className="px-3 py-2 text-xs border-b last:border-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{p.name}</span>
                <Badge variant="outline" className="text-[9px]">{p.backend}</Badge>
                <Badge variant="outline" className="text-[9px]">residency: {p.residency}</Badge>
                {p.backend === 'foxai' && <Badge variant="outline" className="text-[9px] text-yellow-600">observed only — FOXAI owns this server</Badge>}
                {p.backend === 'external' && <Badge variant="outline" className="text-[9px]">attach only</Badge>}
                <div className="ml-auto flex gap-1.5">
                  {(p.backend === 'llamacpp' || p.backend === 'ollama') && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy === p.id} onClick={() => doLoad(p.id)}>
                      {busy === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Play className="w-3 h-3 mr-1" />Load</>}
                    </Button>
                  )}
                  {p.backend === 'ollama' && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy === p.id} onClick={() => doUnload(undefined, p.id)}><Square className="w-3 h-3 mr-1" />Unload (API)</Button>
                  )}
                  <Button size="sm" variant="outline" className="h-6 text-[10px] text-destructive" onClick={async () => { await mesh.client().deleteProfile(p.id, peer); loadInventory(machineId); }}><Trash2 className="w-3 h-3" /></Button>
                </div>
              </div>
              <p className="text-muted-foreground font-mono text-[10px]">
                {p.backend === 'llamacpp' && `${p.serverExe} ← ${p.modelPath}`}
                {p.backend === 'ollama' && `${p.ollamaUrl} · ${p.modelId}`}
                {(p.backend === 'external' || p.backend === 'foxai') && p.endpoint}
                {p.backend === 'openvino' && 'OpenVINO runtime (detect-only in this release)'}
              </p>
              <p className="text-muted-foreground text-[10px]">
                ctx: {p.ctx ?? '—'} · max output tokens: {p.nPredict ?? 'runtime default'} · threads: {p.threads ?? 'auto'} · GPU layers: {p.ngl ?? 'auto'}
                {p.nPredict != null && ' · (output limit is distinct from the context window; truncation events are reported per tool call, user-selected limits are never reduced silently)'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* GGUF + Ollama inventory on the selected machine */}
      {inv && inv.gguf.length > 0 && (
        <div className="rounded-lg border">
          <p className="px-3 py-2 text-xs font-medium border-b">GGUF files on {peerName} (read-only inventory — never moved or downloaded)</p>
          {inv.gguf.map((g) => (
            <div key={g.path} className="px-3 py-1.5 flex items-center gap-2 text-xs border-b last:border-0">
              <span className="font-mono truncate flex-1">{g.path}</span>
              <span className="text-muted-foreground">{fmtBytes(g.sizeBytes)}</span>
              <span className="text-muted-foreground text-[10px]">RAM estimate ≈ {fmtBytes(g.estimatedRamBytes)}</span>
            </div>
          ))}
        </div>
      )}
      {inv && inv.ollama.models.length > 0 && (
        <div className="rounded-lg border">
          <p className="px-3 py-2 text-xs font-medium border-b">Ollama on {peerName} ({inv.ollama.url})</p>
          {inv.ollama.models.map((m) => (
            <div key={m.name} className="px-3 py-1.5 flex items-center gap-2 text-xs border-b last:border-0">
              <span className="font-mono">{m.name}</span>
              <Badge variant="outline" className="text-[9px]">{m.state}</Badge>
              <span className="text-muted-foreground">{m.parameterSize || ''} {m.quant || ''} {fmtBytes(m.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}
      {inv && inv.external.length > 0 && (
        <div className="rounded-lg border">
          <p className="px-3 py-2 text-xs font-medium border-b">Attached endpoints on {peerName}</p>
          {inv.external.map((e) => (
            <div key={e.id} className="px-3 py-1.5 flex items-center gap-2 text-xs border-b last:border-0">
              <span className="font-mono">{e.name}</span>
              {statusBadge(e.state)}
              <span className="text-muted-foreground font-mono">{e.endpoint} · {(e.models || []).map((m) => m.id).join(', ') || 'no models reported'}</span>
            </div>
          ))}
        </div>
      )}
      {!inv && !loadingInv && <p className="text-sm text-muted-foreground">Inventory unavailable for {peerName} — is its companion paired and reachable?</p>}

      <ProfileCreateDialog machineId={machineId} open={showCreate} onClose={() => setShowCreate(false)} onSaved={() => loadInventory(machineId)} />

      <Dialog open={!!diag} onOpenChange={(o) => !o && setDiag(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto lf-scroll">
          <DialogHeader><DialogTitle>Startup diagnostics — {diag?.server?.profileName} ({peerName})</DialogTitle></DialogHeader>
          {diag?.diagnostics && <DiagnosticsView d={diag.diagnostics} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!logs} onOpenChange={(o) => !o && setLogs(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto lf-scroll">
          <DialogHeader><DialogTitle>Server logs — {logs?.server?.profileName} ({peerName}) · status: {logs?.status}</DialogTitle></DialogHeader>
          <pre className="font-mono text-[10px] bg-muted rounded p-2 whitespace-pre-wrap">{logs?.output}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DiagnosticsView({ d }: { d: StartupDiagnostics }) {
  return (
    <div className="text-xs space-y-2">
      <p className="font-mono bg-muted rounded p-2 break-all">$ {d.command}</p>
      <div className="grid grid-cols-2 gap-2">
        <p>exit code: <span className="font-mono">{d.exitCode ?? '—'}</span></p>
        <p>health polls: <span className="font-mono">{d.healthAttempts}</span></p>
        <p>port busy: <span className="font-mono">{String(d.portBusy)}</span></p>
        <p>file missing: <span className="font-mono">{String(d.fileMissing)}</span></p>
      </div>
      {d.stderrTail && <div><p className="text-muted-foreground mb-1">stderr (captured):</p><pre className="bg-muted rounded p-2 whitespace-pre-wrap max-h-40 overflow-y-auto lf-scroll">{d.stderrTail}</pre></div>}
      {d.stdoutTail && <div><p className="text-muted-foreground mb-1">stdout (captured):</p><pre className="bg-muted rounded p-2 whitespace-pre-wrap max-h-40 overflow-y-auto lf-scroll">{d.stdoutTail}</pre></div>}
      <div>
        <p className="text-muted-foreground mb-1">Suggested steps:</p>
        <ol className="list-decimal ml-4 space-y-1">
          {d.suggestions.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>
      {d.healthTimeline.length > 0 && (
        <div><p className="text-muted-foreground mb-1">Health-check timeline:</p>
          <pre className="bg-muted rounded p-2 whitespace-pre-wrap">{d.healthTimeline.map((h) => `${h.at}ms → HTTP ${h.status}`).join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

function ProfileCreateDialog({ open, onClose, onSaved, machineId }: { open: boolean; onClose: () => void; onSaved: () => void; machineId: string }) {
  const mesh = useMesh();
  const inv = mesh.models;
  const [form, setForm] = useState<Partial<ModelProfile>>({ backend: 'llamacpp', ctx: 8192, nPredict: 2048, residency: 'on-demand', toolProtocol: 'auto' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await mesh.client().saveProfile(form as Record<string, unknown>, machineId === 'local' ? null : machineId);
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto lf-scroll">
        <DialogHeader><DialogTitle>New model profile</DialogTitle></DialogHeader>
        <div className="text-xs space-y-2">
          <Input placeholder="Profile name" value={form.name || ''} onChange={(e) => set('name', e.target.value)} />
          <Select value={form.backend} onValueChange={(v) => set('backend', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="llamacpp">llama.cpp (managed — LocalForge starts/stops llama-server)</SelectItem>
              <SelectItem value="ollama">Ollama (documented API — load/unload via Ollama)</SelectItem>
              <SelectItem value="foxai">FOXAI (observed only — FOXAI owns its servers)</SelectItem>
              <SelectItem value="external">External OpenAI-compatible endpoint (attach)</SelectItem>
            </SelectContent>
          </Select>
          {form.backend === 'llamacpp' && (
            <>
              <Input placeholder="llama-server executable path (e.g. /usr/local/bin/llama-server)" value={form.serverExe || ''} onChange={(e) => set('serverExe', e.target.value)} />
              <Input placeholder="Model GGUF path" value={form.modelPath || ''} onChange={(e) => set('modelPath', e.target.value)} list="gguf-list" />
              <datalist id="gguf-list">{(inv?.gguf || []).map((g) => <option key={g.path} value={g.path} />)}</datalist>
              <Input placeholder="Port (default 8081)" value={form.port ?? ''} onChange={(e) => set('port', Number(e.target.value) || null)} />
            </>
          )}
          {form.backend === 'ollama' && (
            <>
              <Input placeholder="Ollama URL" value={form.ollamaUrl || 'http://127.0.0.1:11434'} onChange={(e) => set('ollamaUrl', e.target.value)} />
              <Input placeholder="Model id (e.g. qwen3-coder:30b)" value={form.modelId || ''} onChange={(e) => set('modelId', e.target.value)} list="ollama-list" />
              <datalist id="ollama-list">{(inv?.ollama.models || []).map((m) => <option key={m.name} value={m.name} />)}</datalist>
            </>
          )}
          {(form.backend === 'external' || form.backend === 'foxai') && (
            <Input placeholder="Endpoint on that machine" value={form.endpoint || ''} onChange={(e) => set('endpoint', e.target.value)} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1"><span className="text-muted-foreground">Context window</span><Input value={form.ctx ?? ''} onChange={(e) => set('ctx', Number(e.target.value) || undefined)} /></label>
            <label className="space-y-1"><span className="text-muted-foreground">Max output tokens (distinct from ctx)</span><Input value={form.nPredict ?? ''} onChange={(e) => set('nPredict', Number(e.target.value) || null)} /></label>
            <label className="space-y-1"><span className="text-muted-foreground">CPU threads</span><Input value={form.threads ?? ''} onChange={(e) => set('threads', Number(e.target.value) || null)} /></label>
            <label className="space-y-1"><span className="text-muted-foreground">GPU layers (-ngl)</span><Input value={form.ngl ?? ''} onChange={(e) => set('ngl', Number(e.target.value) || null)} /></label>
          </div>
          <label className="space-y-1 block"><span className="text-muted-foreground">Residency policy</span>
            <Select value={form.residency} onValueChange={(v) => set('residency', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on-demand">On demand (load when needed, unload per policy)</SelectItem>
                <SelectItem value="keep-loaded">Keep loaded (user-declared persistent)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {err && <p className="text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={busy || !form.name}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save profile'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
function AgentsTab({ assignments, onLaunch }: { assignments: AgentAssignment[]; onLaunch?: () => void }) {
  const mesh = useMesh();
  const live = Object.values(mesh.agents);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border">
        <p className="px-3 py-2 text-xs font-medium border-b">Live agents (this session)</p>
        {live.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No agents are running. Start a pipeline or coordinator job from the IDE.</p>}
        {live.map((a) => (
          <div key={a.agentId} className="px-3 py-2 text-xs border-b last:border-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono">{a.agentId}</span>
              <Badge variant="outline" className="text-[9px]">{a.role}</Badge>
              {statusBadge(a.state)}
              <span className="ml-auto text-muted-foreground">{a.machine} · {a.model} · {a.turns} turns</span>
            </div>
            {a.currentTask && <p className="text-muted-foreground truncate">{a.currentTask}</p>}
            {a.currentTool && <p className="text-[10px] text-muted-foreground font-mono">tool: {a.currentTool}</p>}
          </div>
        ))}
      </div>

      {onLaunch && (
        <Button size="sm" variant="outline" onClick={onLaunch}><Users className="w-3.5 h-3.5 mr-1.5" /> Launch a collaborative multi-agent task</Button>
      )}

      <div className="rounded-lg border">
        <p className="px-3 py-2 text-xs font-medium border-b">Assignment history (persisted on the workspace host)</p>
        {assignments.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No assignments recorded yet.</p>}
        {assignments.slice().reverse().map((a) => (
          <div key={a.id} className="px-3 py-2 text-xs border-b last:border-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono">{a.agentId}</span>
              <Badge variant="outline" className="text-[9px]">{a.role}</Badge>
              {statusBadge(a.status)}
              <span className="ml-auto text-muted-foreground">{a.machine} · {a.model}{a.turns ? ` · ${a.turns} turns` : ''}</span>
            </div>
            <p className="text-muted-foreground line-clamp-2">{a.task.slice(0, 200)}</p>
            {a.conflict && <p className="text-yellow-600 text-[10px]">conflict: {a.conflict}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Notebook
// ---------------------------------------------------------------------------
function NotebookTab() {
  const mesh = useMesh();
  const ws = useWorkspace();
  return (
    <div className="rounded-lg border">
      <p className="px-3 py-2 text-xs font-medium border-b flex items-center gap-2"><NotebookPen className="w-3.5 h-3.5 text-primary" /> Shared project notebook (append-only · persisted on the workspace host)</p>
      {mesh.notebook.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No entries yet — agents append verified findings and handoffs here; entries are never overwritten.</p>}
      <div className="divide-y">
        {mesh.notebook.slice().reverse().map((e) => (
          <div key={e.id} className="px-3 py-2 text-xs space-y-0.5">
            <p className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">#{e.seq}</span>
              <Badge variant="outline" className="text-[9px]">{e.kind}</Badge>
              <span className="font-mono text-[10px]">{e.agentId}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
            </p>
            <p className="text-muted-foreground">{e.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collaborate: the REAL multi-agent launch workflow (Phase 2.1 Priority 3).
// The Start button calls startCollabRun() — the SAME production dispatcher the
// acceptance tests call — which instantiates the real Coordinator with
// mesh-routed companions. Nothing here is a diagram.
// ---------------------------------------------------------------------------
interface AgentLive {
  agentId: string;
  stage: string;
  machine?: string;
  model?: string;
  state: 'queued' | 'working' | 'paused' | 'done' | 'error';
  turns: number;
  currentTool?: string;
  lastOutput?: string;
  escalations: string[];
}

const ROLE_ORDER: CollabRole[] = ['planner', 'coder', 'tester', 'reviewer'];

function CollaborateTab() {
  const mesh = useMesh();
  const ws = useWorkspace();
  const settings = useSettings();
  const [participants, setParticipants] = useState<CollabParticipant[]>([]);
  const [fleetOverrides, setFleetOverrides] = useState<Record<string, ParticipationMode>>({});
  const [endpointChoices, setEndpointChoices] = useState<Record<number, { baseUrl: string; models: string[]; label: string }[]>>({});
  const seeded = useRef(false);
  const [mode, setMode] = useState<'sequential' | 'parallel' | 'fanout'>('sequential');
  const [autoSteer, setAutoSteer] = useState(true);
  const [objective, setObjective] = useState('');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [agents, setAgents] = useState<Record<string, AgentLive>>({});
  const [feed, setFeed] = useState<{ at: number; agentId?: string; text: string; tool?: string; status?: string }[]>([]);
  const [autoEvents, setAutoEvents] = useState<{ agentId?: string; trigger: string; text: string }[]>([]);
  const [report, setReport] = useState<CoordinatorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steerText, setSteerText] = useState('');
  const runRef = useRef<CollabRunHandle | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // ---- Authoritative workspace host (Phase 2.2 Fix 2) — a REAL selector:
  // the project may live on any paired computer, with ITS operating system. ----
  const [hostId, setHostId] = useState<string>('local');
  const [hostPlatform, setHostPlatform] = useState<string>('');
  const [hostWorkspaces, setHostWorkspaces] = useState<{ id: string; name: string; path: string }[]>([]);
  const [wsSel, setWsSel] = useState<string>('');
  const [hostErr, setHostErr] = useState<string | null>(null);
  const hostName = hostId === 'local' ? 'This computer' : (mesh.peers.find((p) => p.id === hostId)?.name || hostId);
  const osLabel = (plat: string) => (plat === 'win32' ? 'Windows' : plat === 'darwin' ? 'macOS' : plat === 'linux' ? 'Linux' : plat || '…');

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [feed.length]);

  useEffect(() => {
    mesh.client().fleetParticipation().then((r) => setFleetOverrides(r.participation || {})).catch(() => {});
  }, [mesh.peers.length]);

  // Presets the user saved are kept. The old hard-coded endpoint is cleared.
  // A fresh form prefers the enabled worker and does not invent an endpoint.
  useEffect(() => {
    if (seeded.current) return;
    const saved = (settings as any).collabParticipants as CollabParticipant[] | undefined;
    const clean = (list: CollabParticipant[]) => list.map((p) => (
      isPlaceholderEndpoint(p.baseUrl, p.model) ? { ...p, baseUrl: '', model: '' } : p
    ));
    if (saved && saved.length) {
      seeded.current = true;
      setParticipants(clean(saved));
      return;
    }
    const preferred = mesh.peers.find((p) => resolveParticipation({ machineId: p.id, name: p.name, platform: p.platform }, fleetOverrides) === 'enabled');
    if (!preferred) return;
    seeded.current = true;
    setParticipants([{
      machineId: preferred.id,
      machineName: preferred.name,
      baseUrl: '',
      model: '',
      roles: ['planner', 'coder'],
      residency: 'on-demand',
      platform: preferred.platform,
      participation: 'enabled',
      explicitRun: true,
    }]);
  }, [mesh.peers, fleetOverrides]);

  const saveParticipants = (ps: CollabParticipant[]) => {
    setParticipants(ps);
    settings.setCollabParticipants?.(ps as unknown as Array<Record<string, unknown>>);
  };

  // whenever the host changes: fetch its REAL OS + its authorized workspaces
  useEffect(() => {
    let alive = true;
    setHostErr(null);
    (async () => {
      try {
        const client = clientForMachine(hostId === 'local' ? null : hostId);
        const h = await client.health();
        if (!alive) return;
        setHostPlatform(h.platform || '');
        const wl = await client.listWorkspaces();
        if (!alive) return;
        setHostWorkspaces(wl.workspaces || []);
        setWsSel((prev) => (wl.workspaces?.some((w) => w.id === prev) ? prev : (wl.workspaces?.[0]?.id || '')));
        if (!wl.workspaces?.length) setHostErr(`${hostName} has no authorized project workspaces yet — open a project with its companion first (IDE or companion control page).`);
      } catch (e: any) {
        if (!alive) return;
        setHostPlatform('');
        setHostWorkspaces([]);
        setWsSel('');
        setHostErr(`Cannot reach ${hostName}: ${String(e.message || e)}. Pair it first (Computers tab) and make sure its companion is running.`);
      }
    })();
    return () => { alive = false; };
     
  }, [hostId]);

  const pushFeed = (text: string, extra: { agentId?: string; tool?: string; status?: string } = {}) =>
    setFeed((f) => [...f.slice(-200), { at: Date.now(), text, ...extra }]);

  const start = async () => {
    setError(null);
    setReport(null);
    setAgents({});
    setFeed([]);
    setAutoEvents([]);
    setPaused(false);
    // resolve the AUTHORITATIVE workspace host + the selected project ON it
    const wsRec = hostWorkspaces.find((w) => w.id === wsSel);
    if (!wsRec) { setError(`Select a project on ${hostName} first — its workspace list is loaded in the Authoritative workspace panel.`); return; }
    const wsHostClient = clientForMachine(hostId === 'local' ? null : hostId);
    const prepared = participants.map((p) => {
      const peer = mesh.peers.find((x) => x.id === p.machineId);
      const platform = p.machineId === 'local' ? mesh.primaryHardware?.platform : (p.platform || peer?.platform);
      const machineName = p.machineId === 'local' ? 'This computer' : (peer?.name || p.machineName);
      const participation = resolveParticipation({ machineId: p.machineId, name: machineName, platform, participation: p.participation }, fleetOverrides);
      return {
        ...p,
        machineName,
        platform,
        participation,
        explicitRun: participation === 'enabled' ? true : !!p.explicitRun,
      };
    });
    const cfg: CollabTaskConfig = {
      objective,
      workspaceHostPeerId: hostId === 'local' ? null : hostId,
      workspaceHostMachineName: hostName,
      participants: prepared,
      fleetOverrides,
      executionMode: (mode === 'fanout' ? 'sequential' : mode) as any, // fanout handled by runDistributedFanout
      autoSteering: autoSteer,
      maxTurnsPerStage: settings.agentTurns,
      params: settings.inference,
    };
    setRunning(true);
    try {
      const handle = await startCollabRun(mode as CollabRunMode, cfg, {
        mesh: mesh.client(),
        workspaceHost: wsHostClient,
        workspaceId: wsRec.id,
        workspacePath: wsRec.path,
        workspaceContext: { platform: hostPlatform || 'linux', workspacePath: wsRec.path },
        approver: async () => 'allow',
        onEvent: (e: AgentEvent & { stage?: string; agentId?: string; fanoutKey?: string }) => {
          const agentId = (e as any).agentId as string | undefined;
          if (e.type === 'stage' && agentId) {
            setAgents((a) => ({ ...a, [agentId]: { agentId, stage: (e as any).stage || '?', state: 'working', turns: 0, escalations: [] } }));
            pushFeed(`stage "${(e as any).stage}" assigned to agent ${agentId}`, { agentId });
          }
          if (e.type === 'tool_end') {
            pushFeed(`${e.entry.tool} → ${e.entry.status}`, { agentId, tool: e.entry.tool, status: e.entry.status });
            if (agentId) setAgents((a) => a[agentId] ? { ...a, [agentId]: { ...a[agentId], currentTool: e.entry.tool, turns: a[agentId].turns + 1, lastOutput: (e.entry.output || '').slice(0, 400), state: 'working' } } : a);
          }
          if (e.type === 'turn_start' && agentId) setAgents((a) => a[agentId] ? { ...a, [agentId]: { ...a[agentId], turns: a[agentId].turns + 1 } } : a);
          if (e.type === 'final' && agentId) setAgents((a) => a[agentId] ? { ...a, [agentId]: { ...a[agentId], state: 'done', lastOutput: (e.content || '').slice(0, 400) } } : a);
          if (e.type === 'notice') pushFeed(e.message);
          if (e.type === 'auto_steering') {
            setAutoEvents((x) => [...x.slice(-30), { agentId, trigger: e.trigger, text: e.text }]);
            pushFeed(`automatic steering (${e.trigger}) delivered to ${agentId}`, { agentId });
          }
          if ((e as any).paused && agentId) setAgents((a) => a[agentId] ? { ...a, [agentId]: { ...a[agentId], state: 'paused' } } : a);
        },
      });
      runRef.current = handle;
      pushFeed(handle.kind === 'fanout'
        ? `Distributed fan-out launched — planner task graph scheduled across ${participants.length} machine(s).`
        : 'Collaborative task launched — real Coordinator running.');
      const r = await handle.done;
      setReport(r);
      mesh.refreshAssignments(wsRec.id);
      mesh.refreshNotebook(wsRec.id);
      const fanoutCounts = (r as any).fanout ? ` — ${((r as any).fanout.completed)} completed, ${((r as any).fanout.failed)} failed` : '';
      pushFeed(`${handle.kind === 'fanout' ? 'Fan-out' : 'Coordinator'} finished — verdict: ${r.verdict}, ${r.totalTurns} turns${r.conflicts.length ? `, ${r.conflicts.length} conflict(s)` : ''}${fanoutCounts}.`);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setRunning(false);
    }
  };

  const steerAgentById = (agentId: string) => {
    if (!steerText.trim()) return;
    const ok = runRef.current?.control.steerAgent(agentId, steerText.trim()) ?? false;
    pushFeed(ok ? `manual steering delivered to ${agentId}` : `manual steering queued for ${agentId}'s next stage`, { agentId });
    setSteerText('');
  };

  const machineOptions = [{ id: 'local', name: 'This computer' }, ...mesh.peers.filter((p) => p.paired).map((p) => ({ id: p.id, name: p.name }))];

  const addParticipant = () => {
    const used = new Set(participants.map((p) => p.machineId));
    const free = machineOptions.find((m) => !used.has(m.id)) || machineOptions[0];
    const peer = mesh.peers.find((p) => p.id === free.id);
    const platform = free.id === 'local' ? mesh.primaryHardware?.platform : peer?.platform;
    const participation = resolveParticipation({ machineId: free.id, name: free.name, platform }, fleetOverrides);
    saveParticipants([...participants, {
      machineId: free.id,
      machineName: free.name,
      baseUrl: '',
      model: '',
      roles: ['coder'],
      residency: 'on-demand',
      platform,
      participation,
      explicitRun: participation === 'enabled',
    }]);
  };

  const discoverEndpoints = async (i: number) => {
    const p = participants[i];
    const peer = mesh.peers.find((x) => x.id === p.machineId);
    const platform = p.machineId === 'local' ? mesh.primaryHardware?.platform : (p.platform || peer?.platform);
    const identity = { machineId: p.machineId, name: p.machineName, platform };
    if ((platform || '').toLowerCase() === 'win32' || /windows/i.test(p.machineName)) {
      setError('Windows endpoints are not probed. Choose an approved endpoint yourself if this run should use Windows.');
      return;
    }
    setError(null);
    try {
      const found = await clientForMachine(p.machineId === 'local' ? null : p.machineId).discoverProviders();
      const choices = (found.providers || [])
        .filter((d) => d.reachable && d.baseUrl && !isExcludedWindowsLlama(d.baseUrl, identity))
        .map((d) => ({ baseUrl: d.baseUrl, models: (d.models || []).map((m) => m.id).filter(Boolean), label: d.name || d.baseUrl }));
      setEndpointChoices((prev) => ({ ...prev, [i]: choices }));
      if (choices.length === 1 && choices[0].models.length === 1) {
        updParticipant(i, { baseUrl: choices[0].baseUrl, model: choices[0].models[0] });
      } else if (choices.length === 1) {
        updParticipant(i, { baseUrl: choices[0].baseUrl });
      } else if (!choices.length) {
        setError(`No inference endpoint is already running on ${p.machineName}. Start one there, or type the endpoint that machine uses.`);
      }
    } catch (e: any) {
      setError(`Could not discover endpoints on ${p.machineName}: ${String(e?.message || e)}`);
    }
  };

  const updParticipant = (i: number, patch: Partial<CollabParticipant>) =>
    setParticipants((ps) => {
      const next = ps.map((p, idx) => (idx === i ? { ...p, ...patch, machineName: patch.machineId !== undefined ? (machineOptions.find((m) => m.id === patch.machineId)?.name || p.machineName) : p.machineName } : p));
      settings.setCollabParticipants?.(next as unknown as Array<Record<string, unknown>>); // persist presets
      return next;
    });

  const toggleRole = (i: number, role: CollabRole) =>
    setParticipants((ps) => {
      const next = ps.map((p, idx) => {
        if (idx !== i) return p;
        const has = p.roles.includes(role);
        const roles = has ? p.roles.filter((r) => r !== role) : [...p.roles, role];
        return { ...p, roles: roles.length ? roles : p.roles };
      });
      settings.setCollabParticipants?.(next as unknown as Array<Record<string, unknown>>);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* 1. authoritative workspace — REAL host + project selection (Phase 2.2 Fix 2) */}
      <div className="rounded-lg border p-3 space-y-2">
        <p className="text-sm font-medium flex items-center gap-2"><HardDrive className="w-4 h-4 text-primary" /> Authoritative workspace host</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="w-[240px] h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">This computer (primary companion)</SelectItem>
              {mesh.peers.filter((p) => p.paired).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Badge variant="outline" className="text-[10px]">OS: {osLabel(hostPlatform)}</Badge>
          <Select value={wsSel} onValueChange={setWsSel} disabled={!hostWorkspaces.length}>
            <SelectTrigger className="w-[260px] h-8 text-xs"><SelectValue placeholder={hostWorkspaces.length ? 'Select project…' : 'No workspaces'} /></SelectTrigger>
            <SelectContent>
              {hostWorkspaces.map((w) => <SelectItem key={w.id} value={w.id}>{w.name} · {w.path}</SelectItem>)}
            </SelectContent>
          </Select>
          <Badge variant="outline" className={`text-[10px] ${hostWorkspaces.length ? 'text-green-600 border-green-500/40' : 'text-yellow-600'}`}>
            {hostWorkspaces.length ? `workspace access OK (${hostWorkspaces.length} authorized)` : 'no access yet'}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Every agent&apos;s file and terminal tools execute on <span className="text-foreground font-mono">{hostName}</span>
          {hostPlatform ? <> ({osLabel(hostPlatform)} path conventions)</> : null}, regardless of which machine runs each agent&apos;s model. Projects are never duplicated; revisions and conflicts are tracked on this host.
        </p>
        {hostErr && <p className="text-[11px] text-destructive flex items-center gap-1.5"><CircleAlert className="w-3.5 h-3.5" />{hostErr}</p>}
      </div>

      {/* 2. participants */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium flex items-center gap-2"><Users className="w-4 h-4 text-primary" /> Participating computers &amp; models</p>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={addParticipant}><Plus className="w-3 h-3 mr-1" /> Add computer</Button>
        </div>
        {participants.map((p, i) => (
          <div key={i} className="rounded-md border p-2 space-y-1.5 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={p.machineId} onValueChange={(v) => updParticipant(i, { machineId: v })}>
                <SelectTrigger className="w-[200px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {machineOptions.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="h-7 text-xs flex-1 min-w-[180px]" placeholder="Inference endpoint on that machine" value={p.baseUrl} onChange={(e) => updParticipant(i, { baseUrl: e.target.value })} />
              <Input className="h-7 text-xs w-[170px]" placeholder="Model" value={p.model} onChange={(e) => updParticipant(i, { model: e.target.value })} />
              <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => discoverEndpoints(i)}>Discover</Button>
              {participants.length > 1 && (
                <Button size="sm" variant="outline" className="h-7 text-[10px] text-destructive" onClick={() => saveParticipants(participants.filter((_, idx) => idx !== i))}><Trash2 className="w-3 h-3" /></Button>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {resolveParticipation({ machineId: p.machineId, name: p.machineName, platform: p.platform || mesh.peers.find((x) => x.id === p.machineId)?.platform }, fleetOverrides) !== 'enabled' && (
                <label className="flex items-center gap-1 text-[10px]">
                  <input type="checkbox" className="accent-[hsl(var(--primary))]" checked={!!p.explicitRun} onChange={(e) => updParticipant(i, { explicitRun: e.target.checked })} />
                  Include in this run
                </label>
              )}
              <span className="text-[10px] text-muted-foreground">Roles:</span>
              {ROLE_ORDER.map((role) => (
                <button key={role} className={`px-2 py-0.5 rounded border text-[10px] ${p.roles.includes(role) ? 'border-primary text-primary bg-primary/10' : 'text-muted-foreground'}`} onClick={() => toggleRole(i, role)}>
                  {role}
                </button>
              ))}
              <span className="text-[10px] text-muted-foreground">residency:</span>
              <Select value={p.residency} onValueChange={(v) => updParticipant(i, { residency: v as 'on-demand' | 'keep-loaded' })}>
                <SelectTrigger className="w-[120px] h-6 text-[10px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="on-demand">on-demand (load when needed)</SelectItem>
                  <SelectItem value="keep-loaded">keep loaded</SelectItem>
                </SelectContent>
              </Select>
              {/* per-agent tool protocol (Fix 3): each agent gets its OWN —
                  'inherit' resolves THIS model's IDE preference */}
              <span className="text-[10px] text-muted-foreground ml-2">tools:</span>
              <Select value={p.toolProtocol || 'inherit'} onValueChange={(v) => updParticipant(i, { toolProtocol: v as ProtocolSetting | 'inherit' })}>
                <SelectTrigger className="w-[150px] h-6 text-[10px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">inherit IDE per-model setting</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="native">Native function calling</SelectItem>
                  <SelectItem value="text">Text (JSON in replies)</SelectItem>
                  <SelectItem value="auto-native">Auto, prefer native</SelectItem>
                  <SelectItem value="force-text">Force text</SelectItem>
                </SelectContent>
              </Select>
              {/* per-agent turn allowance (Fix 3) — empty = collaborative default */}
              <span className="text-[10px] text-muted-foreground ml-2">turns:</span>
              <Input className="h-6 w-[70px] text-[10px]" placeholder={String(settings.agentTurns)} value={p.maxTurns ?? ''} onChange={(e) => updParticipant(i, { maxTurns: e.target.value === '' ? undefined : (Math.max(1, Math.min(500, Math.round(Number(e.target.value) || 0))) || undefined) })} />
            </div>
            {(endpointChoices[i] || []).length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-muted-foreground">Choose an endpoint on {p.machineName}:</span>
                {endpointChoices[i].map((c) => (
                  <button key={c.baseUrl} className={`px-2 py-0.5 rounded border text-[10px] ${p.baseUrl === c.baseUrl ? 'border-primary text-primary' : 'text-muted-foreground'}`} onClick={() => updParticipant(i, { baseUrl: c.baseUrl, model: c.models.length === 1 ? c.models[0] : '' })}>
                    {c.label} · {c.baseUrl}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">Inference for this participant: {p.machineName}{p.baseUrl ? ` · ${p.baseUrl}` : ' · no endpoint selected'}{p.model ? ` · ${p.model}` : ''}</p>
          </div>
        ))}
        <p className="text-[10px] text-muted-foreground">
          Endpoints are discovered on the selected machine and are not filled in for you when more than one is available. Discovery only lists servers that are already running. Work runs on Enabled machines. A Manual machine runs only when Include in this run is checked, and a failure on the preferred worker does not move the task there.
        </p>
      </div>

      {/* 3. mode + steering + objective */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            {(['sequential', 'parallel', 'fanout'] as const).map((m) => (
              <button key={m} className={`px-2.5 py-1 rounded border text-xs ${mode === m ? 'border-primary text-primary bg-primary/10' : 'text-muted-foreground'}`} onClick={() => setMode(m)}>
                {m === 'sequential' ? 'Sequential stages' : m === 'parallel' ? 'Parallel writers' : 'Parallel fan-out (distributed)'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={autoSteer} onChange={(e) => setAutoSteer(e.target.checked)} className="accent-[hsl(var(--primary))]" />
            Automatic steering &amp; escalation
          </label>
          {mode === 'parallel' && <span className="text-[10px] text-yellow-600">parallel coders: concurrent edits are detected via workspace revisions — conflicts are flagged, never silently overwritten</span>}
        </div>
        <Textarea placeholder="Development objective — e.g. &quot;Add a settings page with theme persistence to the app, write tests, make them pass&quot;" value={objective} onChange={(e) => setObjective(e.target.value)} className="min-h-[72px] text-sm" />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={start} disabled={running || !objective.trim() || !ws.workspaceId || participants.length === 0}>
            {running ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1" />}
            {running ? 'Collaborative task running…' : 'Start collaborative task'}
          </Button>
          {running && (
            <>
              <Button size="sm" variant="secondary" onClick={() => { runRef.current?.control.requestPause(); setPaused(true); pushFeed('pause requested — agents pause at safe boundaries'); }}><Pause className="w-3.5 h-3.5 mr-1" /> Pause</Button>
              <Button size="sm" variant="destructive" onClick={() => { runRef.current?.control.requestStop(); pushFeed('stop requested'); }}><StopCircle className="w-3.5 h-3.5 mr-1" /> Stop</Button>
            </>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!ws.workspaceId && <p className="text-[10px] text-destructive">Open a project in the IDE first — the authoritative workspace must exist.</p>}
      </div>

      {/* 4. live monitoring */}
      {(running || Object.keys(agents).length > 0) && (
        <div className="rounded-lg border p-3 space-y-3">
          <p className="text-sm font-medium flex items-center gap-2"><Bot className="w-4 h-4 text-primary" /> Agents at work (live)</p>

          {/* coordinator steering + per-agent steering */}
          <div className="flex items-center gap-2 flex-wrap">
            <Input className="h-7 text-xs flex-1 min-w-[220px]" placeholder="Steer: instruction delivered to the selected agent (or coordinator)…" value={steerText} onChange={(e) => setSteerText(e.target.value)} />
            <Select onValueChange={(v) => steerAgentById(v)}>
              <SelectTrigger className="w-[150px] h-7 text-xs"><SelectValue placeholder="Deliver to…" /></SelectTrigger>
              <SelectContent>
                {[...Object.keys(agents), 'coordinator'].map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => { if (steerText.trim()) { runRef.current?.control.steerAll(steerText.trim()); pushFeed(`coordinator steering delivered to all agents`); setSteerText(''); } }}>
              <MessageSquarePlus className="w-3 h-3 mr-1" /> Coordinator
            </Button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.values(agents).map((a) => (
              <div key={a.agentId} className="rounded-md border p-2 text-xs space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{a.agentId}</span>
                  <Badge variant="outline" className="text-[9px]">{a.stage}</Badge>
                  {statusBadge(a.state === 'working' ? 'in-progress' : a.state)}
                  <span className="ml-auto text-muted-foreground">{a.turns} turns{a.currentTool ? ` · tool: ${a.currentTool}` : ''}</span>
                </div>
                {a.lastOutput && <p className="text-[10px] text-muted-foreground line-clamp-2">{a.lastOutput}</p>}
                {a.state === 'paused' && paused && <p className="text-[10px] text-yellow-600">paused — deliver steering, then resume by starting a continuation task</p>}
              </div>
            ))}
          </div>

          {/* automatic steering / recovery status */}
          {autoEvents.length > 0 && (
            <div className="rounded-md border border-primary/30 p-2 text-[11px] space-y-1">
              <p className="font-medium text-primary">Automatic steering delivered</p>
              {autoEvents.slice(-6).map((e, i) => (
                <p key={i} className="text-muted-foreground">{e.agentId ? <span className="font-mono">{e.agentId}</span> : ''} · {e.trigger}: {e.text.slice(0, 140)}…</p>
              ))}
            </div>
          )}

          {/* tool activity feed */}
          <div ref={feedRef} className="rounded-md bg-muted/40 p-2 max-h-56 overflow-y-auto lf-scroll font-mono text-[10px] space-y-0.5">
            {feed.map((f, i) => (
              <p key={i} className="text-muted-foreground">
                {new Date(f.at).toLocaleTimeString()} {f.agentId ? `[${f.agentId}] ` : ''}{f.tool ? <span className={f.status === 'error' ? 'text-destructive' : 'text-foreground'}>{f.tool}</span> : null} {f.text}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* 5. results */}
      {report && (
        <div className="rounded-lg border p-3 space-y-2 text-xs">
          <p className="text-sm font-medium">Result — verdict: <Badge variant="outline" className={report.verdict === 'APPROVE' ? 'text-green-600 border-green-500/40' : 'text-yellow-600'}>{report.verdict}</Badge> · {report.totalTurns} turns · rework passes: {report.reworkPassesUsed}</p>
          {report.conflicts.length > 0 && (
            <div className="rounded-md border border-yellow-500/40 p-2 space-y-1">
              <p className="font-medium text-yellow-600">Conflicts detected (both change sets preserved)</p>
              {report.conflicts.map((c, i) => <p key={i} className="text-muted-foreground">{c}</p>)}
            </div>
          )}
          {report.results.map((r) => (
            <div key={r.assignmentId} className="rounded-md border p-2 space-y-1">
              <p className="flex items-center gap-2 flex-wrap"><span className="font-mono">{r.agentId}</span><Badge variant="outline" className="text-[9px]">{r.stage}</Badge><span className="text-muted-foreground">{r.machine} · {r.model} · {r.turns} turns{r.escalated ? ' · escalated' : ''}</span></p>
              <p className="text-muted-foreground line-clamp-3">{r.summary}</p>
              {r.hitTurnLimit && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-yellow-600">turn limit reached on this stage</span>
                  <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={async () => {
                    if (!runRef.current?.coordinator) return;
                    pushFeed(`continuing ${r.stage} on the same machine with a fresh allowance…`);
                    const res = await runRef.current.coordinator.continueStage(r.stage as any);
                    if (res) pushFeed(`continuation of ${r.stage} finished (${res.turns} turns): ${res.summary.slice(0, 120)}`);
                    mesh.refreshAssignments(wsSel);
                  }}><Play className="w-3 h-3 mr-1" />Continue task</Button>
                </div>
              )}
              {['coder', 'tester'].includes(r.stage) && participants.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Reassign to:</span>
                  <Select onValueChange={async (peerId) => {
                    const target = participants.find((p) => p.machineId === peerId);
                    if (!target || !runRef.current?.coordinator) return;
                    pushFeed(`reassigning ${r.stage} to ${target.machineName}…`);
                    const res = await runRef.current.coordinator.reassign(r.stage as any, {
                      machineId: target.machineId, machineName: target.machineName,
                      provider: { kind: 'openai', baseUrl: target.baseUrl }, model: target.model, profileId: target.profileId,
                      // the replacement agent brings ITS OWN configuration
                      toolProtocol: !target.toolProtocol || target.toolProtocol === 'inherit'
                        ? settings.effectiveProtocol(target.baseUrl, target.model)
                        : target.toolProtocol,
                      maxTurns: target.maxTurns ?? settings.agentTurns,
                    }, r.summary || 'previous agent failed');
                    pushFeed(`reassignment complete on ${target.machineName}: ${res.summary.slice(0, 120)}`);
                    mesh.refreshAssignments(wsSel);
                  }}>
                    <SelectTrigger className="w-[180px] h-6 text-[10px]"><SelectValue placeholder="pick a computer…" /></SelectTrigger>
                    <SelectContent>
                      {participants.filter((p) => p.machineId !== r.machine).map((p) => <SelectItem key={p.machineId} value={p.machineId}>{p.machineName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">Every agent handoff was appended to the shared notebook; scratchpads and assignments persist on the workspace host (see Agents + Shared Notebook tabs).</p>
        </div>
      )}
    </div>
  );
}

// The primary companion client (authoritative workspace host) — same config
// the IDE uses everywhere.
function clientForPrimary() {
  return new CompanionClient(() => useSettings.getState().companion);
}
