'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useRouter } from '@/lib/store/router';
import { useAuth } from '@/lib/store/auth';
import { useEffect } from 'react';
import { Zap, HardDrive, ShieldCheck, Boxes, MonitorPlay, KeyRound } from 'lucide-react';

const FEATURES = [
  {
    icon: HardDrive,
    title: 'Your models, your hardware',
    body: 'Connect Ollama, LM Studio, llama.cpp or Lemonade running on your machine or LAN. Inference tokens come from your own hardware — you never pay per token.',
  },
  {
    icon: Zap,
    title: 'Agents that actually execute',
    body: 'The coding agent reads and writes real files, runs builds and tests in a real shell, reads the failures, and fixes the code — then shows you every tool call.',
  },
  {
    icon: ShieldCheck,
    title: 'Local by default',
    body: 'Source code and prompts flow browser → companion → local model. Our servers handle accounts and billing only. Nothing is uploaded without an explicit feature you enable.',
  },
  {
    icon: MonitorPlay,
    title: 'See it run',
    body: 'Integrated terminal, streaming builds, and a live preview panel for the app your agent just wrote.',
  },
  {
    icon: Boxes,
    title: 'Multi-agent pipelines',
    body: 'Planner → coder → tester → reviewer orchestration with per-stage model routing. Each stage gets the tools it needs — no more, no less.',
  },
  {
    icon: KeyRound,
    title: 'Workspace authorization',
    body: 'Authorize a folder once. File edits inside the workspace run automatically; shell commands and destructive actions follow your execution policy.',
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
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            { }
            <img src="/logo.svg" alt="LocalForge logo" className="w-8 h-8" />
            <span className="font-semibold text-lg tracking-tight">
              LocalForge <span className="text-muted-foreground font-normal">IDE</span>
            </span>
          </div>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('settings')}>Settings</Button>
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
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground mb-6">
            <span className="w-2 h-2 rounded-full bg-primary lf-pulse-dot" />
            Prototype build — connect a real local model and watch it build real software
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-tight">
            Your models. <span className="lf-logo-gradient">Your machine.</span><br />Your IDE.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            A browser-based AI coding environment that connects to the language models
            already running on your computer. The agent edits real files, runs real builds,
            and shows its work — while your code never leaves your machine.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button size="lg" onClick={() => navigate('ide')} className="h-12 px-7 text-base">
              Launch the IDE
            </Button>
            <Button size="lg" variant="outline" className="h-12 px-7 text-base" onClick={() => navigate('auth', { authMode: 'signup' })}>
              Create account
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Requires the free LocalForge companion running on your computer — <span className="font-mono text-xs">npm i -g @localforge/companion</span>
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
            <h2 className="text-2xl font-semibold text-center mb-10">How it works</h2>
            <div className="grid md:grid-cols-3 gap-8">
              {[
                { n: '1', title: 'Run the companion', body: 'Windows: download the installer from the connection screen — no terminal needed. The tray app shows your pairing code. Developers: npm i -g @localforge/companion && localforge-companion.' },
                { n: '2', title: 'Pair the browser', body: 'Paste the pairing code in the IDE. Your browser now talks directly to your machine — files, terminal and models.' },
                { n: '3', title: 'Pick your model', body: 'LocalForge discovers Ollama, LM Studio, llama.cpp and Lemonade automatically. Choose a model and give the agent a task.' },
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
          </div>
        </section>

        <section className="border-t">
          <div className="mx-auto max-w-6xl px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground max-w-3xl mx-auto">
              <strong className="text-foreground">Privacy note:</strong> LocalForge&apos;s hosted service stores your
              account and project metadata only. Source code, prompts and inference stay between your browser,
              the companion, and your local model server. Subscription billing is disabled in this prototype build —
              no payments are processed.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-6xl px-6 py-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>LocalForge IDE — prototype build</span>
          <div className="flex gap-4">
            <button className="hover:text-foreground" onClick={() => navigate('settings')}>Settings</button>
            <button className="hover:text-foreground" onClick={() => navigate('dashboard')}>Dashboard</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
