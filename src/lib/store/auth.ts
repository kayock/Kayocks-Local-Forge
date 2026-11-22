// Hosted-account session state (client side).
import { create } from 'zustand';
import { hosted, type HostedUser } from '@/lib/hosted/api';

interface AuthState {
  user: HostedUser | null;
  loaded: boolean;
  load: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>()((set) => ({
  user: null,
  loaded: false,
  load: async () => {
    try {
      const { user } = await hosted.me();
      set({ user, loaded: true });
    } catch {
      set({ user: null, loaded: true });
    }
  },
  login: async (email, password) => {
    const { user } = await hosted.login(email, password);
    set({ user });
  },
  register: async (email, password, name) => {
    const { user } = await hosted.register(email, password, name);
    set({ user });
  },
  logout: async () => {
    await hosted.logout();
    set({ user: null });
  },
}));
