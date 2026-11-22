// Hash-based view router (single-route app: /#/...).
import { create } from 'zustand';

export type ViewId = 'landing' | 'ide' | 'dashboard' | 'settings' | 'auth' | 'forge';

interface RouterState {
  view: ViewId;
  authMode: 'login' | 'signup';
  navigate: (view: ViewId, opts?: { authMode?: 'login' | 'signup' }) => void;
  syncFromHash: () => void;
}

function parseHash(): { view: ViewId; authMode: 'login' | 'signup' } {
  const h = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#\/?/, '');
  const [seg, param] = h.split('/');
  let view: ViewId = 'landing';
  if (seg === 'ide') view = 'ide';
  else if (seg === 'dashboard') view = 'dashboard';
  else if (seg === 'settings') view = 'settings';
  else if (seg === 'auth') view = 'auth';
  else if (seg === 'forge') view = 'forge';
  return { view, authMode: param === 'signup' ? 'signup' : 'login' };
}

function toHash(view: ViewId, authMode?: 'login' | 'signup'): string {
  switch (view) {
    case 'ide': return '#/ide';
    case 'dashboard': return '#/dashboard';
    case 'settings': return '#/settings';
    case 'auth': return authMode === 'signup' ? '#/auth/signup' : '#/auth/login';
    case 'forge': return '#/forge';
    default: return '#/';
  }
}

export const useRouter = create<RouterState>()((set) => ({
  view: 'landing',
  authMode: 'login',
  navigate: (view, opts) => {
    if (typeof window !== 'undefined') {
      window.location.hash = toHash(view, opts?.authMode);
    }
    set({ view, authMode: opts?.authMode ?? 'login' });
  },
  syncFromHash: () => {
    const { view, authMode } = parseHash();
    set({ view, authMode });
  },
}));
