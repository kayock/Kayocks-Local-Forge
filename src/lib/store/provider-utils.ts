// Pure provider-merge and validation logic (mission §3/§4/§7). Kept free of
// zustand/browser APIs so the regression tests exercise exactly the rules the
// store applies:
//   - providers are merged by ORIGIN (scheme+host+port), so an endpoint
//     discovered as http://host:13305/api/v1 matches a saved http://host:13305 entry;
//   - discovery NEVER removes a saved provider and NEVER overwrites its key;
//   - unreachable endpoints are only status updates for known providers, and
//     never become new entries;
//   - invalid URLs are rejected before they can touch any state.
import type { DiscoveredProvider, ModelInfo, ProviderKind, ProviderStatus } from '@/lib/types';

export interface ProviderMergeOutcome<T> {
  providers: T[];  // new full list (same element type as the store's saved list)
  added: T[];
  updated: T[];
  keptUnreachable: number;
  skippedUnreachableNew: number;
}

// The element type the merge operates on: a saved provider (the store's
// SavedProvider). Identity fields are enforced; the index signature covers the
// optional state fields (status, serverType, credentialSource, …).
export type MergeableProvider = {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  [key: string]: any;
};

// scheme://host:port — the identity of an inference server regardless of the
// API path variant discovery stored.
export function providerOrigin(url: string): string {
  try {
    const u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${u.hostname}:${port}`;
  } catch {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

// Reject malformed provider URLs BEFORE they can enter settings: scheme
// optional (http assumed), host required, port 1-65535 when present.
export function validateProviderUrl(raw: string): { ok: boolean; normalized?: string; error?: string } {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return { ok: false, error: 'Enter a server address, e.g. http://192.168.1.20:11434.' };
  // explicit non-http scheme (ftp://, ws://, file:// …) is rejected outright
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?:$/i.test(scheme[1])) return { ok: false, error: 'Only http:// and https:// endpoints are supported.' };
  const candidate = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http:// and https:// endpoints are supported.' };
  if (!u.hostname || u.hostname === 'about' ) return { ok: false, error: 'URL is missing a host.' };
  if (u.username || u.password) return { ok: false, error: 'Credentials in the URL are not supported — use the API key field instead.' };
  if (u.port) {
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `Invalid port: ${u.port}.` };
  }
  return { ok: true, normalized: candidate };
}

// Merge a discovery report into the saved provider list without clobbering
// anything (mission §4). `existing` items are the store's SavedProvider shape
// (extends DiscoveredProvider with id + apiKey + selection state).
export function mergeScanResults<T extends MergeableProvider>(
  existing: T[],
  report: DiscoveredProvider[],
  opts?: { machineLabel?: string },
): ProviderMergeOutcome<T> {
  const out: T[] = existing.map((p) => ({ ...p }));
  const added: T[] = [];
  const updated: T[] = [];
  let keptUnreachable = 0;
  let skippedUnreachableNew = 0;
  const indexOfOrigin = new Map<string, number>();
  out.forEach((p, i) => indexOfOrigin.set(providerOrigin(p.baseUrl), i));

  for (const r of report) {
    if (!r?.baseUrl) continue;
    const origin = providerOrigin(r.baseUrl);
    const idx = indexOfOrigin.get(origin);
    if (idx !== undefined) {
      const cur = out[idx];
      const status = (r.reachable ? (r.authRequired && !r.authOk ? 'auth_required' : 'ok') : 'unreachable') as ProviderStatus;
      const patch: any = {
        status,
        authRequired: !!r.authRequired,
        lastDiscoveredAt: Date.now(),
        // serverType/name refresh only when the report identified the server
        serverType: r.name || cur.serverType,
      };
      if (!r.reachable && !r.models?.length) {
        keptUnreachable++;
        // Failed discovery keeps the provider, its models and its key intact.
        out[idx] = { ...cur, ...patch, error: r.error || (cur as any).error };
        continue;
      }
      if (r.authSource) patch.authSource = r.authSource;
      if (r.error) patch.error = r.error;
      if (r.models?.length) patch.models = r.models;
      // label: only fill when the user never named it
      const label = cur.label && cur.label !== cur.baseUrl ? cur.label : (r.name || cur.label);
      out[idx] = { ...cur, ...patch, label, machineLabel: cur.machineLabel || opts?.machineLabel };
      updated.push(out[idx]);
    } else {
      if (!r.reachable && !r.models?.length) {
        // Never add a dead endpoint as a provider — noise, and it would look
        // like discovery "created" something that is not there.
        skippedUnreachableNew++;
        continue;
      }
      const entry = {
        id: `p_${Math.random().toString(36).slice(2, 10)}`,
        kind: r.kind || 'openai',
        baseUrl: r.baseUrl,
        label: r.name || r.baseUrl,
        serverType: r.name,
        models: r.models || [],
        status: (r.reachable && !(r.authRequired && !r.authOk) ? 'ok' : 'auth_required') as ProviderStatus,
        authRequired: !!r.authRequired,
        authSource: r.authSource,
        error: r.error,
        lastDiscoveredAt: Date.now(),
        machineLabel: opts?.machineLabel,
        enabled: true,
      } as unknown as T; // same shape the store saves (SavedProvider)
      out.push(entry);
      indexOfOrigin.set(origin, out.length - 1);
      added.push(entry);
    }
  }
  return { providers: out, added, updated, keptUnreachable, skippedUnreachableNew };
}

export function summarizeModelCount(models?: ModelInfo[]): string {
  const n = models?.length ?? 0;
  return `${n} model${n === 1 ? '' : 's'}`;
}
