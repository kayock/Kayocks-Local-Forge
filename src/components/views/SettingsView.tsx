'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRouter } from '@/lib/store/router';
import { useSettings } from '@/lib/store/settings';
import { useAuth } from '@/lib/store/auth';
import { CompanionClient } from '@/lib/companion/client';
import type { DiscoveredProvider } from '@/lib/types';
import { BUILD_INFO } from '@/lib/build-info.gen';
import { useTheme } from 'next-themes';
import { Trash2, Plug, Search, CheckCircle2, XCircle, Moon, Sun } from 'lucide-react';

export function SettingsView() {
  const navigate = useRouter((s) => s.navigate);
  const settings = useSettings();
  const { user, load } = useAuth();
  const { theme, setTheme } = useTheme();
  const [newUrl, setNewUrl] = useState('');
  const [newKey, setNewKey] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [addingEndpoint, setAddingEndpoint] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => { load(); }, [load]);

  const client = new CompanionClient(() => settings.companion);

  // Upsert one discovered/probed provider without ever removing or clobbering
  // the others (each card is keyed by its own id; match on normalized URL).
  const upsertProvider = (p: DiscoveredProvider, opts: { userKey?: string } = {}) => {
    const base = p.baseUrl.replace(/\/+$/, '');
    const existing = settings.providers.find((x) => x.baseUrl.replace(/\/+$/, '') === base);
    // If the companion authenticated with the key the user just typed, save it
    // on the card. If it used the companion-side lemond.env key, save nothing
    // here — the companion attaches that credential itself at request time.
    const apiKey = p.authSource === 'user-provided' && opts.userKey ? opts.userKey : existing?.apiKey;
    const patch = {
      kind: p.kind,
      label: p.name || existing?.label || base,
      // keep a working card's model list when the new probe couldn't list any
      models: p.models?.length ? p.models : (existing?.models ?? []),
      authRequired: p.authRequired,
      authOk: p.authOk,
      authSource: p.authSource,
      apiKey,
    };
    if (existing) {
      settings.updateProvider(existing.id, patch as any);
      return existing.id;
    }
    const created = settings.addProvider({ kind: p.kind, baseUrl: p.baseUrl, label: patch.label, models: patch.models, authRequired: p.authRequired, authOk: p.authOk, authSource: p.authSource, apiKey: patch.apiKey } as any);
    return created.id;
  };

  const describeProvider = (p: DiscoveredProvider): string => {
    if (p.authRequired && !p.authOk) {
      const why = p.authSource === 'companion-key-rejected' || p.authSource === 'user-key-rejected'
        ? ' — the configured API key was rejected (HTTP 401).'
        : p.authSource === 'no-credentials'
          ? ' — authentication is required and no API key was found (companion lemond.env absent or key empty).'
          : '';
      return `${p.name || 'Server'} at ${p.baseUrl}: reachable but locked (HTTP ${p.status ?? 401})${why} Add the LEMONADE_API_KEY value in the API-key field and click Add endpoint.`;
    }
    if (p.authSource === 'companion-lemond-env') {
      return `${p.name} at ${p.baseUrl}: ${p.models.length} model(s) — authenticated with the companion's lemond.env key.`;
    }
    return `${p.name} at ${p.baseUrl}: ${p.models.length} model(s).`;
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const extra = newUrl.trim() ? [newUrl.trim()] : [];
      const key = newKey.trim() || undefined;
      const { providers, credentials } = await client.discoverProviders(extra, key);
      if (!providers.length) {
        setTestResult({ _discover: 'No providers found. Is your model server running? (Ollama :11434, LM Studio :1234, llama-server :8080, Lemonade :8000 / :13305)' });
        return;
      }
      const lines: string[] = [];
      for (const p of providers) {
        const id = upsertProvider(p, { userKey: newKey.trim() || undefined });
        lines.push(describeProvider(p));
        if (p.authRequired && !p.authOk) {
          setTestResult((r) => ({
            ...r,
            [id]: `Reachable, needs authentication (HTTP ${p.status ?? 401}). ${
              credentials?.lemonadeEnvKey === 'not-found'
                ? 'No /etc/lemonade/lemond.env key was found on the companion machine.'
                : 'The lemond.env key on the companion machine was rejected.'
            } Enter the correct API key below and click Add endpoint.`,
          }));
        }
      }
      setTestResult((r) => ({ ...r, _discover: `Found ${providers.length}: ${lines.join(' · ')}` }));
      setNewUrl('');
      setNewKey('');
    } catch (e: any) {
      setTestResult({ _discover: `Discovery failed: ${e.message}. Companion not connected? Open the IDE and pair first.` });
    } finally {
      setDiscovering(false);
    }
  };

  // "Add endpoint": explicitly register the URL the user typed, even when the
  // server needs authentication or speaks an API we cannot list models for.
  // Never overwrites another provider: same URL updates its own entry, a new
  // URL appends a new one.
  const addEndpoint = async () => {
    const url = newUrl.trim();
    if (!url) {
      setTestResult({ _add: 'Enter a model server URL first, e.g. http://127.0.0.1:13305' });
      return;
    }
    setAddingEndpoint(true);
    try {
      const key = newKey.trim() || undefined;
      const p = await client.probeEndpoint(url, key);
      if (!p.reachable) {
        setTestResult({ _add: p.error || `No server answered at ${url}. Check the address, port and that the server is running.` });
        return;
      }
      const id = upsertProvider(p, { userKey: newKey.trim() || undefined });
      if (p.authRequired && !p.authOk) {
        setTestResult((r) => ({
          ...r,
          [id]: `Added ${p.baseUrl} — reachable but authentication failed (HTTP ${p.status ?? 401}). ${
            p.authSource === 'companion-key-rejected' || p.authSource === 'user-key-rejected'
              ? 'The API key was rejected by the server.'
              : 'No API key was available. Enter the LEMONADE_API_KEY value and click Add endpoint again.'
          }`,
          _add: '',
        }));
        return;
      }
      setTestResult((r) => ({ ...r, [id]: describeProvider(p), _add: '' }));
      setNewUrl('');
      setNewKey('');
    } catch (e: any) {
      setTestResult({ _add: `Could not add endpoint: ${e.message}` });
    } finally {
      setAddingEndpoint(false);
    }
  };

  const testProvider = async (id: string) => {
    const p = settings.providers.find((x) => x.id === id)!;
    setTestingId(id);
    try {
      const models = await client.listModels({ kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey });
      settings.updateProvider(id, { models: models.models, authOk: true });
      setTestResult((r) => ({ ...r, [id]: `Reachable — ${models.models.length} model(s): ${models.models.slice(0, 4).map((m) => m.id).join(', ')}${models.models.length > 4 ? '…' : ''}` }));
    } catch (e: any) {
      const msg = String(e.message || e);
      if (/HTTP 401|HTTP 403|authentication/i.test(msg)) {
        settings.updateProvider(id, { authOk: false, authRequired: true });
      }
      setTestResult((r) => ({ ...r, [id]: `Failed: ${msg}` }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b sticky top-0 bg-background/90 backdrop-blur z-10">
        <div className="mx-auto max-w-3xl px-6 h-16 flex items-center justify-between">
          <button className="flex items-center gap-2" onClick={() => navigate('landing')}>
            { }
            <img src="/logo.svg" alt="" className="w-7 h-7" />
            <span className="font-semibold">LocalForge IDE</span>
          </button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => navigate('ide')}>Open IDE</Button>
            <Button variant="ghost" onClick={() => navigate('dashboard')}>Dashboard</Button>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-8 space-y-6">
        <h1 className="text-2xl font-semibold">Settings</h1>

        {/* --- companion --- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Companion connection</CardTitle>
            <CardDescription>How this browser reaches the companion on your computer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={settings.companion.mode}
              onValueChange={(v) => settings.setCompanion({ mode: v as 'direct' | 'remote' | 'gateway' })}
              className="flex flex-wrap gap-6"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="direct" id="mode-direct" />
                <Label htmlFor="mode-direct" className="font-normal">Direct (my machine)</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="remote" id="mode-remote" />
                <Label htmlFor="mode-remote" className="font-normal">Remote endpoint</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="gateway" id="mode-gateway" />
                <Label htmlFor="mode-gateway" className="font-normal">Sandbox gateway (demo only)</Label>
              </div>
            </RadioGroup>
            {settings.companion.mode === 'gateway' ? (
              <div className="space-y-2">
                <Label htmlFor="gw-port">Companion gateway port</Label>
                <Input
                  id="gw-port"
                  type="number"
                  className="font-mono text-sm"
                  value={settings.companion.gatewayPort}
                  onChange={(e) => settings.setCompanion({ gatewayPort: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">
                  Sandbox/demo only: routes through this site's own server (which runs its own companion).
                  Your real companion on your machine uses Direct mode — prompts and code never touch the hosted server.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="direct-url">{settings.companion.mode === 'remote' ? 'Remote companion URL' : 'Companion URL'}</Label>
                <Input
                  id="direct-url"
                  className="font-mono text-sm"
                  value={settings.companion.mode === 'remote' ? (settings.companion.remoteUrl ?? '') : settings.companion.directUrl}
                  onChange={(e) => settings.setCompanion(settings.companion.mode === 'remote' ? { remoteUrl: e.target.value } : { directUrl: e.target.value })}
                  placeholder={settings.companion.mode === 'remote' ? 'http://192.168.1.20:7337' : 'http://127.0.0.1:7337'}
                />
                <p className="text-xs text-muted-foreground">
                  {settings.companion.mode === 'remote'
                    ? 'An explicit companion endpoint on another machine you control (run the companion there with --host 0.0.0.0 --lan). Use Direct mode for the companion on THIS computer.'
                    : 'Default is http://127.0.0.1:7337. Windows: install the LocalForge Companion app and start it from the Start Menu. For LAN companions, enter http://<machine-ip>:7337 (run the companion with --host 0.0.0.0 --lan on that machine).'}
                </p>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={settings.companion.token ? 'default' : 'secondary'}>
                {settings.companion.token ? 'Paired' : 'Not paired'}
              </Badge>
              {settings.companion.token && (
                <Button variant="ghost" size="sm" onClick={() => settings.setToken(null)}>Unpair</Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* --- providers --- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Model providers</CardTitle>
            <CardDescription>
              Discover local inference servers (Ollama, LM Studio, llama.cpp, Lemonade) or add any OpenAI-compatible endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="provider-url">Model server URL</Label>
                <Input
                  id="provider-url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="http://127.0.0.1:13305"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="provider-key">API key (optional — only if the server requires one)</Label>
                <Input
                  id="provider-key"
                  type="password"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="LEMONADE_API_KEY value"
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={discover} disabled={discovering}>
                <Search className="w-4 h-4 mr-1" /> {discovering ? 'Scanning…' : 'Discover'}
              </Button>
              <Button onClick={addEndpoint} disabled={addingEndpoint || !newUrl.trim()} variant="outline">
                <Plug className="w-4 h-4 mr-1" /> {addingEndpoint ? 'Adding…' : 'Add endpoint'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Discover scans this machine (plus the URL above) and registers everything it can reach — including servers
              that need an API key. Add endpoint registers exactly the URL above without scanning.
            </p>
            {testResult._add && <p className="text-sm text-destructive">{testResult._add}</p>}
            {testResult._discover && <p className="text-sm text-muted-foreground">{testResult._discover}</p>}

            <div className="space-y-3">
              {settings.providers.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No providers yet. Start your model server and click Discover (requires a paired companion).
                </p>
              )}
              {settings.providers.map((p) => (
                <div key={p.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Plug className="w-4 h-4 text-primary shrink-0" />
                      <span className="font-mono text-sm truncate">{p.baseUrl}</span>
                      <Badge variant="outline">{p.kind}</Badge>
                      {p.label && <span className="text-xs text-muted-foreground">{p.label}</span>}
                      {p.authRequired && p.authOk === false && (
                        <Badge variant="destructive">needs API key</Badge>
                      )}
                      {p.authSource === 'companion-lemond-env' && (
                        <Badge variant="secondary">lemond.env key</Badge>
                      )}
                      {!p.authRequired && (p.models?.length ?? 0) > 0 && (
                        <Badge variant="secondary">{p.models!.length} models</Badge>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => testProvider(p.id)} disabled={testingId === p.id}>
                        {testingId === p.id ? 'Testing…' : 'Test'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => settings.removeProvider(p.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {testResult[p.id] && (
                    <p className={`text-xs ${testResult[p.id].startsWith('Reachable') ? 'text-green-500' : 'text-destructive'} flex gap-1 items-start`}>
                      {testResult[p.id].startsWith('Reachable') ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                      {testResult[p.id]}
                    </p>
                  )}
                  {p.kind === 'openai' && (
                    <Input
                      placeholder="API key (optional, stored in this browser only)"
                      type="password"
                      className="text-xs font-mono"
                      value={p.apiKey || ''}
                      onChange={(e) => settings.updateProvider(p.id, { apiKey: e.target.value })}
                    />
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label htmlFor={`timeout-${p.id}`} className="text-xs text-muted-foreground shrink-0">
                      Inference timeout (min)
                    </Label>
                    <Input
                      id={`timeout-${p.id}`}
                      type="number"
                      min={1}
                      max={120}
                      className="text-xs font-mono w-24"
                      placeholder="20"
                      value={p.chatTimeoutSec ? String(Math.round(p.chatTimeoutSec / 60)) : ''}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        settings.updateProvider(p.id, { chatTimeoutSec: Number.isFinite(v) && v > 0 ? Math.min(v, 120) * 60 : undefined });
                      }}
                    />
                    <span className="text-xs text-muted-foreground">
                      How long to wait for one inference (prompt processing on slow hardware can take many minutes). Default 20 min; on timeouts LocalForge never resends the request, so no duplicate queues behind a busy server.
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* --- policy --- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Execution policy</CardTitle>
            <CardDescription>What the agent may do without asking. File edits inside the authorized workspace are covered by your workspace authorization.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={settings.policy}
              onValueChange={(v) => settings.setPolicy(v as any)}
              className="space-y-3"
            >
              {[
                { v: 'auto', label: 'Auto — run everything in the workspace (including shell commands) without asking. Destructive ops still ask.', hint: 'Fastest; for trusted VMs' },
                { v: 'confirm-commands', label: 'Confirm commands — file edits run automatically; shell commands ask first (recommended).', hint: 'Balanced' },
                { v: 'confirm-all', label: 'Confirm all — every write and command asks first.', hint: 'Most restrictive' },
              ].map((o) => (
                <div key={o.v} className="flex items-start space-x-2">
                  <RadioGroupItem value={o.v} id={`policy-${o.v}`} className="mt-1" />
                  <div>
                    <Label htmlFor={`policy-${o.v}`} className="font-normal leading-snug">{o.label}</Label>
                    <p className="text-xs text-muted-foreground">{o.hint}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
            <div className="mt-5 pt-4 border-t space-y-3">
              <div>
                <Label className="text-sm">Tool protocol</Label>
                <p className="text-xs text-muted-foreground">
                  How tool calls reach the model. Models with solid native function calling (e.g. Qwen3-Coder) run best with Native — the text-protocol helper can interfere with them.
                </p>
              </div>
              <RadioGroup
                value={settings.toolProtocol}
                onValueChange={(v) => settings.setToolProtocol(v as any)}
                className="space-y-2"
              >
                {[
                  { v: 'auto', label: 'Automatic (recommended)', hint: 'Starts with native tool calling; falls back to the text protocol only when the server rejects it, records why, and remembers the choice per model.' },
                  { v: 'native', label: 'Native only', hint: 'Never injects text-protocol instructions or nudges. For models that already support function calling.' },
                  { v: 'text', label: 'Text protocol', hint: 'JSON-per-turn fallback for models without reliable native tool calling.' },
                ].map((o) => (
                  <div key={o.v} className="flex items-start space-x-2">
                    <RadioGroupItem value={o.v} id={`proto-${o.v}`} className="mt-1" />
                    <div>
                      <Label htmlFor={`proto-${o.v}`} className="font-normal leading-snug">{o.label}</Label>
                      <p className="text-xs text-muted-foreground">{o.hint}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
              <div className="flex items-center justify-between pt-2">
                <div>
                  <Label htmlFor="agent-turns" className="text-sm">Agent turn limit</Label>
                  <p className="text-xs text-muted-foreground">Pauses the agent after this many turns; "Continue task" resumes with full context.</p>
                </div>
                <Input
                  id="agent-turns"
                  type="number"
                  min={5}
                  max={500}
                  value={settings.agentTurns}
                  onChange={(e) => settings.setAgentTurns(Number(e.target.value))}
                  className="w-24"
                />
              </div>
              {/* Forge upgrade — reliability controls */}
              <div className="flex items-center justify-between pt-2">
                <div>
                  <Label htmlFor="machine-label" className="text-sm">This machine's label</Label>
                  <p className="text-xs text-muted-foreground">Shown in tool feedback, the Fleet Map and run histories (e.g. Station, Portable, Windows Dell).</p>
                </div>
                <Input
                  id="machine-label"
                  value={settings.machineLabel}
                  onChange={(e) => settings.setMachineLabel(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="auto-escalate" className="text-sm">Stall escalation</Label>
                  <p className="text-xs text-muted-foreground">
                    When the agent makes no progress despite coordinator recovery attempts, hand off to the first other configured model — with the original assignment preserved. Off by default; you can always switch models manually.
                  </p>
                </div>
                <input
                  id="auto-escalate"
                  type="checkbox"
                  checked={settings.autoEscalate}
                  onChange={(e) => settings.setAutoEscalate(e.target.checked)}
                  className="w-4 h-4"
                />
              </div>
              {Object.keys(settings.modelDialects).length > 0 && (
                <div className="pt-2 border-t">
                  <Label className="text-sm">Learned tool-call dialects</Label>
                  <div className="mt-1.5 space-y-1">
                    {Object.entries(settings.modelDialects).slice(0, 8).map(([k, v]) => (
                      <p key={k} className="text-[11px] text-muted-foreground font-mono truncate">{k.split('::').pop()} → <span className="text-foreground">{v.dialect}</span> ({v.successes} success{v.successes === 1 ? '' : 'es'})</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* --- appearance --- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appearance</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <span className="text-sm">Theme</span>
            <div className="flex gap-2">
              <Button size="sm" variant={theme === 'dark' ? 'default' : 'outline'} onClick={() => setTheme('dark')}>
                <Moon className="w-4 h-4 mr-1" /> Dark
              </Button>
              <Button size="sm" variant={theme === 'light' ? 'default' : 'outline'} onClick={() => setTheme('light')}>
                <Sun className="w-4 h-4 mr-1" /> Light
              </Button>
            </div>
          </CardContent>
        </Card>

        {user && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Signed in as {user.name} ({user.email}) — plan: {user.subscription?.tier || 'free'}. Manage in the <button className="text-primary underline" onClick={() => navigate('dashboard')}>dashboard</button>.
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-muted-foreground font-mono pb-4">
          Build {BUILD_INFO.commit} · {BUILD_INFO.version} · built {BUILD_INFO.builtAt}
        </p>
      </main>
    </div>
  );
}
