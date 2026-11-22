'use client';

// LocalForge IDE — application shell.
// Single-route app: /#/ (landing), /#/ide, /#/dashboard, /#/settings, /#/auth, /#/forge.
import { useEffect } from 'react';
import { useRouter } from '@/lib/store/router';
import { LandingView } from '@/components/views/LandingView';
import { AuthView } from '@/components/views/AuthView';
import { DashboardView } from '@/components/views/DashboardView';
import { SettingsView } from '@/components/views/SettingsView';
import { IdeView } from '@/components/ide/IdeView';
import { ForgeView } from '@/components/forge/ForgeView';
import { ControlCenter } from '@/components/mesh/ControlCenter';

export default function Page() {
  const view = useRouter((s) => s.view);

  useEffect(() => {
    useRouter.getState().syncFromHash();
    const onHash = () => useRouter.getState().syncFromHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  switch (view) {
    case 'ide':
      return <IdeView />;
    case 'dashboard':
      return <DashboardView />;
    case 'settings':
      return <SettingsView />;
    case 'auth':
      return <AuthView />;
    case 'forge':
      return <ForgeView />;
    case 'control':
      return <ControlCenter />;
    default:
      return <LandingView />;
  }
}
