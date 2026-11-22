// Client for the hosted backend (accounts, project metadata, billing, usage).
// This is the ONLY thing that talks to our servers — it never touches model
// traffic or file contents.
export interface HostedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  subscription: { tier: string; status: string } | null;
}

async function api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: opts?.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
  return json as T;
}

export const hosted = {
  register: (email: string, password: string, name: string) =>
    api<{ user: HostedUser }>('/api/auth/register', { method: 'POST', body: { email, password, name } }),
  login: (email: string, password: string) =>
    api<{ user: HostedUser }>('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => api<{ user: HostedUser | null }>('/api/auth/me'),

  listProjects: () => api<{ projects: HostedProject[] }>('/api/projects'),
  saveProject: (p: HostedProject) => api<{ project: HostedProject }>('/api/projects', { method: 'POST', body: p }),
  deleteProject: (id: string) => api<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  billingTiers: () => api<{ tiers: Tier[]; enabled: boolean }>('/api/billing/tiers'),
  billingStatus: () => api<{ enabled: boolean; tier: string; status: string; message?: string }>('/api/billing/status'),
  startCheckout: (tier: string) => api<{ url?: string; message: string }>('/api/billing/checkout', { method: 'POST', body: { tier } }),

  logUsage: (kind: string, meta?: Record<string, unknown>) =>
    api<{ ok: boolean }>('/api/usage', { method: 'POST', body: { kind, meta } }),
  usageSummary: () => api<{ events: { kind: string; count: number; lastAt: string }[] }>('/api/usage'),
};

export interface HostedProject {
  id?: string;
  name: string;
  description?: string;
  localPath?: string;
  companionLabel?: string;
}

export interface Tier {
  id: string;
  name: string;
  priceMonthly: number | null;
  features: string[];
  highlight?: boolean;
}
