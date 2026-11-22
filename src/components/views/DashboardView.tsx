'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useRouter } from '@/lib/store/router';
import { useAuth } from '@/lib/store/auth';
import { hosted, type Tier } from '@/lib/hosted/api';
import { Check, LogOut, Cpu, Folder } from 'lucide-react';
import { useWorkspace } from '@/lib/store/workspace';

export function DashboardView() {
  const navigate = useRouter((s) => s.navigate);
  const { user, loaded, load, logout } = useAuth();
  const projects = useWorkspace((s) => s.projects);
  const [tiers, setTiers] = useState<{ tiers: Tier[]; enabled: boolean } | null>(null);
  const [status, setStatus] = useState<{ enabled: boolean; tier: string; status: string; message?: string } | null>(null);
  const [usage, setUsage] = useState<{ events: { kind: string; count: number; lastAt: string }[] } | null>(null);

  useEffect(() => {
    load();
    hosted.billingTiers().then(setTiers).catch(() => {});
    hosted.billingStatus().then(setStatus).catch(() => {});
    hosted.usageSummary().then(setUsage).catch(() => {});
  }, [load]);

  const checkout = async (tierId: string) => {
    try {
      const r = await hosted.startCheckout(tierId);
      if (r.url) window.location.href = r.url;
      else setStatus((s) => ({ ...s!, message: r.message }));
    } catch (e: any) {
      setStatus((s) => ({ ...s!, message: e.message }));
    }
  };

  if (loaded && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md text-center p-6">
          <CardTitle className="mb-2">Sign in to view your dashboard</CardTitle>
          <CardDescription className="mb-4">The dashboard manages your account, subscription and synced project metadata.</CardDescription>
          <Button onClick={() => navigate('auth', { authMode: 'login' })}>Sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b sticky top-0 bg-background/90 backdrop-blur z-10">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <button className="flex items-center gap-2" onClick={() => navigate('landing')}>
            { }
            <img src="/logo.svg" alt="" className="w-7 h-7" />
            <span className="font-semibold">LocalForge IDE</span>
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('ide')}>Open IDE</Button>
            {user && (
              <Button variant="ghost" onClick={async () => { await logout(); navigate('landing'); }}>
                <LogOut className="w-4 h-4 mr-1" /> Sign out
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-8 space-y-8">
        <section>
          <h1 className="text-2xl font-semibold">Welcome{user ? `, ${user.name}` : ''}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {user?.email} — account, subscription and synced project metadata. Code stays on your machine.
          </p>
        </section>

        <section className="grid md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Badge variant="secondary" className="capitalize">{status?.tier || 'free'}</Badge> Subscription</CardTitle></CardHeader>
            <CardContent>
              <CardDescription>
                {status?.enabled
                  ? `Status: ${status.status}`
                  : 'Billing is disabled in this prototype build — no payments are processed.'}
              </CardDescription>
              {status?.message && <p className="text-xs text-muted-foreground mt-2">{status.message}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Folder className="w-4 h-4" /> Projects</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{projects.length}</p>
              <CardDescription>Project metadata saved in this browser{user ? ' + synced to your account' : ''}.</CardDescription>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Cpu className="w-4 h-4" /> Hosted-service usage</CardTitle></CardHeader>
            <CardContent>
              {usage?.events.length ? (
                <ul className="text-sm space-y-1">
                  {usage.events.map((e) => (
                    <li key={e.kind} className="flex justify-between"><span className="text-muted-foreground">{e.kind}</span><span>{e.count}</span></li>
                  ))}
                </ul>
              ) : (
                <CardDescription>No hosted-service usage yet. Inference usage is yours — it never touches our servers.</CardDescription>
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3">Subscription tiers</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {tiers?.tiers.map((t) => (
              <Card key={t.id} className={t.highlight ? 'border-primary' : ''}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{t.name}</CardTitle>
                    {t.highlight && <Badge>Recommended</Badge>}
                  </div>
                  <div className="text-2xl font-bold">
                    {t.priceMonthly === 0 ? 'Free' : t.priceMonthly !== null ? <>${t.priceMonthly}<span className="text-sm font-normal text-muted-foreground">/user/mo</span></> : '—'}
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {t.features.map((f) => (
                      <li key={f} className="flex gap-2"><Check className="w-4 h-4 text-primary shrink-0 mt-0.5" /><span className="text-muted-foreground">{f}</span></li>
                    ))}
                  </ul>
                  <Button
                    className="w-full mt-4"
                    variant={t.highlight ? 'default' : 'outline'}
                    disabled={t.id === 'free'}
                    onClick={() => checkout(t.id)}
                  >
                    {t.id === 'free' ? 'Current plan' : 'Upgrade (billing disabled)'}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-6xl px-6 py-4 text-sm text-muted-foreground">
          LocalForge IDE — prototype build. Stripe integration is wired but inactive.
        </div>
      </footer>
    </div>
  );
}
