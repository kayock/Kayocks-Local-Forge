'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useRouter } from '@/lib/store/router';
import { useAuth } from '@/lib/store/auth';
import { BUILD_INFO } from '@/lib/build-info.gen';
import { useEffect } from 'react';
import { Boxes, HardDrive, Laptop, MonitorSmartphone, Network, ShieldCheck, Users } from 'lucide-react';

const REPO = 'https://github.com/kayock/Kayocks-Local-Forge';

const FEATURES = [
  {
    icon: Network,
    title: 'Multi-machine fleet',
    body: 'Connect compatible Windows and Linux machines and manage them from one Control Center. A connection shows the machine. It does not by itself allow that machine to run work.',
  },
  {
    icon: Users,
    title: 'Collaborative AI agents',
    body: 'Assign planner, coder, tester, reviewer, and debugger roles to computers you choose. Each role uses the endpoint you select on that machine.',
  },
  {
    icon: HardDrive,
    title: 'Local model integration',
    body: 'Discover model servers that are already running, such as Ollama, LM Studio, llama.cpp, or Lemonade, and pick the endpoint. Models do not need to stay loaded.',
  },
  {
    icon: Laptop,
    title: 'Distributed task execution',
    body: 'Create work on the controller and run supported tasks on a connected worker you have enabled. The project stays on the workspace host.',
  },
  {
    icon: Boxes,
    title: 'Projects and workspaces',
    body: 'Open an authorized project, use the editor and terminal, and point a collaboration at a workspace that already exists on the chosen host.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Fleet visibility',
    body: 'See which machines are connected, which platform they run, and whether each one is the controller, an enabled worker, or manual-only.',
  },
  {
    icon: ShieldCheck,
    title: 'User-controlled execution',
    body: 'The preferred worker is the one you enable. A manual machine runs only when you include it in that run. A busy or failed worker does not hand the task to another machine on its own.',
  },
];

export function LandingView() {
  const navigate = useRouter((s) => s.navigate);
  const loadUser = useAuth((s) => s.load);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-3 min-h-16 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="LocalForge logo" className="w-8 h-8" />
            <span className="font-semibold text-lg tracking-tight">
              LocalForge <span className="text-muted-foreground font-normal">IDE</span>
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('control')}>Control Center</Button>
            <Button variant="ghost" onClick={() => navigate('settings')}>Settings</Button>
            <a className="inline-flex h-9 items-center px-3 text-sm hover:text-foreground text-muted-foreground" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
            {user ? (
              <Button variant="ghost" onClick={() => navigate('dashboard')}>Dashboard</Button>
            ) : (
              <Button variant="ghost" onClick={() => navigate('auth', { authMode: 'login' })}>Sign in</Button>
            )}
            <Button onClick={() => navigate('ide')}>Launch IDE</Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 pt-16 pb-12 md:pt-20 md:pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground mb-6">
            <span className="w-2 h-2 rounded-full bg-primary lf-pulse-dot" />
            LocalForge {BUILD_INFO.version}
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight leading-tight">
            LocalForge — your AI development workspace,<br className="hidden sm:block" /> powered by your own machines
          </h1>
          <p className="mt-6 text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Build, coordinate, and execute AI-assisted development workflows across your own computers.
            LocalForge brings projects, coding agents, local models, and distributed execution together in one workspace.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" onClick={() => navigate('ide')} className="h-12 px-7 text-base">
              Launch the IDE
            </Button>
            <Button size="lg" variant="outline" className="h-12 px-7 text-base" onClick={() => navigate('control')}>
              Open Control Center
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Linux and Windows companions. The IDE in this deployment stays on the controller.
          </p>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-16">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <Card key={f.title} className="border bg-card/60 hover:bg-card transition-colors">
                <CardContent className="p-6">
                  <f.icon className="w-5 h-5 text-primary mb-3" aria-hidden="true" />
                  <h3 className="font-semibold mb-2">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-t bg-card/40">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-2xl font-semibold text-center mb-3">What this release does not do</h2>
            <p className="text-sm text-muted-foreground text-center max-w-3xl mx-auto mb-8 leading-relaxed">
              These are not capabilities of LocalForge {BUILD_INFO.version}. They are listed so the product is not mistaken for them.
            </p>
            <div className="grid md:grid-cols-2 gap-4 max-w-4xl mx-auto text-sm text-muted-foreground">
              <p className="rounded-lg border p-4">No automatic fallback. If the preferred worker is busy or fails, work is not moved to a machine you left on manual.</p>
              <p className="rounded-lg border p-4">No GPU pooling and no split of one model across machines. Inference runs on the endpoint you selected for that computer.</p>
            </div>
          </div>
        </section>

        <section className="border-t">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-2xl font-semibold text-center mb-10">Getting started</h2>
            <div className="grid md:grid-cols-3 gap-8">
              {[
                { n: '1', title: 'Run a companion', body: 'Windows uses the LocalForge Companion installer from the GitHub release. Linux runs the companion from this source tree. The controller also runs the IDE.' },
                { n: '2', title: 'Pair the fleet', body: 'Open the Control Center, connect each machine, and pair it with its own pairing code. Set participation: the controller orchestrates, the preferred worker is enabled, and any other machine stays manual until you include it.' },
                { n: '3', title: 'Choose an endpoint', body: 'On the worker, discover a model server that is already running, or type that machine’s endpoint. Then open a project and start a task.' },
              ].map((s) => (
                <div key={s.n} className="flex gap-4">
                  <div className="shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">{s.n}</div>
                  <div>
                    <h3 className="font-semibold mb-1">{s.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-sm">
              <a className="text-primary hover:underline" href={`${REPO}/blob/v0.5-dev/README.md`} target="_blank" rel="noreferrer">Documentation on GitHub</a>
              <span className="text-muted-foreground"> · Windows install notes are in the repository docs.</span>
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-6xl px-6 py-6 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>LocalForge {BUILD_INFO.version}</span>
          <div className="flex flex-wrap gap-4">
            <a className="hover:text-foreground" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
            <button className="hover:text-foreground" onClick={() => navigate('control')}>Control Center</button>
            <button className="hover:text-foreground" onClick={() => navigate('settings')}>Settings</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
