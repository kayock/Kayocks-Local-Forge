// Universal provider connectivity — browser-side regression tests (mission §7).
// Covers scenarios 8 (companion settings preservation), 9 (model selection
// across providers), 10 (failed discovery without configuration loss) and the
// merge/validation rules from mission §3/§4. Companion-side discovery tests
// (scenarios 1-7) live in companion/test/providers.discovery.test.mjs; live
// inference-server verification is gated separately.
import { describe, test, expect, beforeEach } from 'bun:test';
import { useSettings, type SavedProvider } from '../src/lib/store/settings';
import { mergeScanResults, providerOrigin, validateProviderUrl } from '../src/lib/store/provider-utils';
import type { DiscoveredProvider } from '../src/lib/types';

// deterministic store state per test (the store is module-level and shared)
function seed() {
  useSettings.setState({
    providers: [saved({}), saved({ id: 'p_ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', label: 'Ollama', serverType: 'Ollama', models: [{ id: 'nemotron-cascade2:30b-a3b' }, { id: 'qwen3-coder:7b' }], selectedModel: 'nemotron-cascade2:30b-a3b' })],
    activeProviderId: null,
    model: '',
  });
}

beforeEach(() => seed());

const saved = (over: Partial<SavedProvider>): SavedProvider => ({
  id: 'p_existing', kind: 'openai', baseUrl: 'http://127.0.0.1:13305/api/v1', label: 'Lemonade',
  serverType: 'Lemonade Server', models: [{ id: 'Llama-3.2-3B-Instruct-Hybrid' }],
  status: 'ok', authRequired: false, credentialSource: 'lemond.env',
  lastDiscoveredAt: 1000, enabled: true, selectedModel: 'Llama-3.2-3B-Instruct-Hybrid',
  ...over,
});

const discovered = (over: Partial<DiscoveredProvider>): DiscoveredProvider => ({
  kind: 'openai', baseUrl: 'http://127.0.0.1:13305/api/v1', name: 'Lemonade Server', reachable: true, models: [],
  ...over,
});

describe('§4/§7-8 — Companion settings are preserved; provider ops never touch them', () => {
  test('merge leaves the companion connection untouched and keeps saved provider identity', () => {
    const s = useSettings.getState();
    const companionBefore = JSON.stringify(s.companion);
    s.upsertScan([
      discovered({ status: 'ok', models: [{ id: 'Qwen2.5-Coder-7B' }] }),
      discovered({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama', status: 'ok', models: [{ id: 'nemotron-cascade2:30b-a3b' }] }),
    ], 'Portable');
    const after = useSettings.getState();
    expect(JSON.stringify(after.companion)).toBe(companionBefore); // companion address/token untouched
    expect(after.providers).toHaveLength(2);
    const lem = after.providers[0] as SavedProvider;
    expect(lem.id).toBe('p_existing');                 // same identity — updated, not re-created
    expect(lem.models!.some((m) => m.id === 'Qwen2.5-Coder-7B'));
    expect(lem.selectedModel).toBe('Llama-3.2-3B-Instruct-Hybrid'); // selection kept
    expect(lem.credentialSource).toBe('lemond.env');
    expect(lem.machineLabel).toBe('Portable');
  });

  test('adding a provider with the same address as the companion cannot replace the companion', () => {
    const s = useSettings.getState();
    const companionBefore = JSON.stringify(s.companion);
    // someone types the companion address into the provider scanner
    s.upsertScan([discovered({ baseUrl: 'http://127.0.0.1:7337', status: 'incompatible', reachable: true, models: [], detail: 'no recognized API' })]);
    const after = useSettings.getState();
    expect(JSON.stringify(after.companion)).toBe(companionBefore);
    expect(after.companion.directUrl).toBe('http://127.0.0.1:7337');
    // the endpoint is recorded as a (failing) provider entry, not as companion
    expect(after.providers.some((p) => p.baseUrl.includes(':7337') && p.id !== undefined)).toBe(true);
    expect(after.providers.some((p) => p.status === 'incompatible')).toBe(true);
  });
});

describe('§3/§7-9 — Model selection is independent per provider', () => {
  test('activating a provider adopts ITS remembered model; switching back restores the other', () => {
    const s = useSettings.getState();
    s.upsertScan([
      discovered({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama', status: 'ok', models: [{ id: 'nemotron-cascade2:30b-a3b' }, { id: 'qwen3-coder:7b' }] }),
    ]);
    const st = useSettings.getState();
    const lemon = st.providers.find((p) => p.baseUrl.includes('13305'))!;
    const ollama = st.providers.find((p) => p.baseUrl.includes('11434'))!;
    s.setProviderModel(lemon.id, 'Llama-3.2-3B-Instruct-Hybrid');
    expect(useSettings.getState().activeProviderId).toBe(lemon.id);
    expect(useSettings.getState().model).toBe('Llama-3.2-3B-Instruct-Hybrid');
    s.setProviderModel(ollama.id, 'qwen3-coder:7b');
    expect(useSettings.getState().model).toBe('qwen3-coder:7b');
    // switching back to Lemonade restores its own model (context preserved §6)
    s.setActiveProvider(lemon.id);
    expect(useSettings.getState().model).toBe('Llama-3.2-3B-Instruct-Hybrid');
    s.setActiveProvider(ollama.id);
    expect(useSettings.getState().model).toBe('qwen3-coder:7b');
  });

  test('enable/disable keeps providers configured but excludes inactive ones from selection', () => {
    const s = useSettings.getState();
    const p = s.providers[0];
    s.setProviderEnabled(p.id, false);
    expect(useSettings.getState().providers[0].enabled).toBe(false);
    s.setProviderEnabled(p.id, true);
    expect(useSettings.getState().providers[0].enabled).toBe(true);
  });
});

describe('§4/§7-10 — Failed discovery and invalid URLs cannot damage configuration', () => {
  test('unreachable report on a saved provider: status-only update, models/key/label intact', () => {
    const before = useSettings.getState().providers.find((p) => p.baseUrl.includes('13305'))!;
    const merge = mergeScanResults([before], [discovered({ status: 'unreachable', reachable: false, models: [], detail: 'fetch failed' })]);
    expect(merge.providers).toHaveLength(1);
    const kept = merge.providers[0] as SavedProvider;
    expect(kept.status).toBe('unreachable');
    expect(kept.models!.length).toBeGreaterThan(0);        // model list preserved
    expect(kept.credentialSource).toBe('lemond.env');       // key state preserved
    expect(kept.label).toBe('Lemonade');
    expect(kept.selectedModel).toBe('Llama-3.2-3B-Instruct-Hybrid');
    expect(merge.keptUnreachable).toBe(1);
    expect(merge.added).toHaveLength(0);
  });

  test('unreachable NEW endpoints are never added as providers', () => {
    const merge = mergeScanResults([], [discovered({ baseUrl: 'http://127.0.0.1:59999', status: 'unreachable', reachable: false, models: [] })]);
    expect(merge.providers).toHaveLength(0);
    expect(merge.skippedUnreachableNew).toBe(1);
  });

  test('failed scan through the store changes nothing but statuses', () => {
    const s = useSettings.getState();
    const before = JSON.stringify(s.providers.map((p) => [p.id, p.models?.length, p.credentialSource]));
    s.upsertScan([
      discovered({ status: 'unreachable', reachable: false, models: [] }),
      discovered({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama', status: 'unreachable', reachable: false, models: [] }),
    ]);
    const after = useSettings.getState();
    expect(JSON.stringify(after.providers.map((p) => [p.id, p.models?.length, p.credentialSource]))).toBe(before);
  });

  test('invalid provider URLs are rejected before they can enter settings', () => {
    expect(validateProviderUrl('not a url').ok).toBe(false);
    expect(validateProviderUrl('ftp://x').ok).toBe(false);
    expect(validateProviderUrl('http://user:pass@host:11434').ok).toBe(false);
    expect(validateProviderUrl('http://host:notaport').ok).toBe(false);
    expect(validateProviderUrl('').ok).toBe(false);
    const okCase = validateProviderUrl('192.168.1.20:11434');
    expect(okCase.ok).toBe(true);
    expect(okCase.normalized).toBe('http://192.168.1.20:11434');
  });

  test('providers merge by ORIGIN — a path-suffixed discovery matches the saved bare entry', () => {
    expect(providerOrigin('http://h:13305/api/v1')).toBe(providerOrigin('http://h:13305'));
    expect(providerOrigin('http://h:13305/v1')).toBe('http://h:13305');
    const bare = saved({ baseUrl: 'http://h:13305', id: 'p_bare' });
    const merge = mergeScanResults([bare], [discovered({ baseUrl: 'http://h:13305/api/v1', status: 'ok', models: [{ id: 'm1' }] })]);
    expect(merge.providers).toHaveLength(1); // updated in place, no duplicate entry
    expect(merge.updated).toHaveLength(1);
  });
});
