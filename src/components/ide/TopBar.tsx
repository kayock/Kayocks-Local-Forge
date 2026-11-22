'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSettings } from '@/lib/store/settings';
import { useWorkspace } from '@/lib/store/workspace';
import { useRouter } from '@/lib/store/router';
import { useAuth } from '@/lib/store/auth';
import type { CompanionClient } from '@/lib/companion/client';
import { ChevronDown, CircleDot, Cpu, Moon, Network, Settings2, Sun, Unplug, User } from 'lucide-react';
import { useTheme } from 'next-themes';

export type CompanionStatus = 'checking' | 'offline' | 'unpaired' | 'paired';

export function TopBar({
  status,
  modelReady,
  onOpenProject,
}: {
  status: CompanionStatus;
  modelReady: boolean;
  onOpenProject: () => void;
}) {
  const settings = useSettings();
  const workspace = useWorkspace();
  const navigate = useRouter((s) => s.navigate);
  const { theme, setTheme } = useTheme();
  const user = useAuth((s) => s.user);
  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId);

  return (
    <header className="h-12 border-b flex items-center gap-3 px-3 shrink-0 bg-card/70">
      <button className="flex items-center gap-2 pl-1 pr-2 group" onClick={() => navigate('landing')} title="Home">
        { }
        <img src="/logo.svg" alt="LocalForge" className="w-6 h-6" />
        <span className="font-semibold text-sm tracking-tight hidden sm:inline">LocalForge</span>
      </button>

      <button
        className="text-sm rounded-md px-2 py-1 hover:bg-accent truncate max-w-[220px] flex items-center gap-1.5"
        onClick={onOpenProject}
        title="Switch / open project"
      >
        <span className="font-medium truncate">{workspace.workspacePath ? workspace.workspacePath.split('/').filter(Boolean).pop() || 'workspace' : 'No workspace'}</span>
        <span className="text-muted-foreground font-mono text-[10px] hidden md:inline truncate">{workspace.workspacePath}</span>
      </button>

      <div className="flex-1" />

      {/* Forge Control: projects / fleet / live runs */}
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => navigate('control')} title="Forge Control Center — multi-agent collaboration, parallel fan-out across machines">
        <Network className="w-3.5 h-3.5" /> Control Center
      </Button>
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => navigate('forge')} title="Forge Control — Projects Hub, Fleet Map, Live Runs">
        <Network className="w-3.5 h-3.5 text-primary" />
        <span className="hidden md:inline text-xs">Forge</span>
      </Button>

      {/* companion status */}
      <button
        className="flex items-center gap-1.5 text-xs rounded-md px-2 py-1 hover:bg-accent"
        title={`Companion: ${status}`}
        onClick={() => navigate('settings')}
      >
        <CircleDot
          className={`w-3.5 h-3.5 ${status === 'paired' ? 'text-green-500' : status === 'checking' ? 'text-yellow-500 lf-pulse-dot' : 'text-destructive'}`}
        />
        <span className="text-muted-foreground hidden md:inline">
          {status === 'paired' ? 'Companion' : status === 'checking' ? 'Checking…' : status === 'unpaired' ? 'Not paired' : 'Offline'}
        </span>
      </button>

      {/* model selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={`h-8 gap-1.5 ${modelReady ? '' : 'text-muted-foreground'}`}>
            <Cpu className="w-3.5 h-3.5 text-primary" />
            <span className="max-w-[180px] truncate font-mono text-xs">
              {activeProvider && settings.model ? settings.model : 'Select model'}
            </span>
            <ChevronDown className="w-3.5 h-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 max-h-96 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">Providers</DropdownMenuLabel>
          {settings.providers.length === 0 && (
            <DropdownMenuItem disabled>No providers — open Settings → Discover</DropdownMenuItem>
          )}
          {settings.providers.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => settings.setActiveProvider(p.id)} className="justify-between">
              <span className="font-mono text-xs truncate">{p.label || p.baseUrl}</span>
              {settings.activeProviderId === p.id && <Badge variant="secondary">active</Badge>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Models (active provider)</DropdownMenuLabel>
          {(activeProvider?.models || []).length === 0 && (
            <DropdownMenuItem disabled>No models discovered yet</DropdownMenuItem>
          )}
          <div className="max-h-64 overflow-y-auto">
            {(activeProvider?.models || []).map((m) => (
              <DropdownMenuItem key={m.id} onClick={() => settings.setModel(m.id)} className="justify-between">
                <span className="font-mono text-xs truncate">{m.display || m.id}</span>
                {settings.model === m.id && <Badge variant="secondary">selected</Badge>}
              </DropdownMenuItem>
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate('settings')} className="text-primary">
            <Settings2 className="w-3.5 h-3.5 mr-1.5" /> Manage providers
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title="Toggle theme"
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </Button>

      {user ? (
        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => navigate('dashboard')}>
          <User className="w-3.5 h-3.5" /> {user.name.split(' ')[0]}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => navigate('auth', { authMode: 'login' })}>
          Sign in
        </Button>
      )}
    </header>
  );
}
