// Universal provider connectivity — browser-side regression tests (mission §7).
// Covers scenarios 8 (companion settings preservation), 9 (model selection
// across providers), 10 (failed discovery without configuration loss) and the
// merge/validation rules from mission §3/§4. Companion-side discovery tests
// (scenarios 1-7) live in companion/test/providers.discovery.test.mjs; live
// inference-server verification is gated separately.
//
// Updated for the v0.5.0 settings API: scans merge through the pure
// mergeScanResults() helper (the old store-level upsertScan and per-provider
// enabled/selectedModel/credentialSource fields were removed — model choice
// is explicit global state, credential state lives in the auth fields).
import { describe, test, expect, beforeEach } from 'bun:test';
import { useSettings, type SavedProvider } from '../src/lib/store/settings';
import { mergeScanResults, providerOrigin, validateProviderUrl } from '../src/lib/store/provider-utils';
import type { DiscoveredProvider } from '../src/lib/types';

// deterministic store state per test (the store is module-level and shared)
function seed() {
  useSettings.setState({
    providers: [saved({}), saved({ id: 'p_ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', label: 'Ollama', serverType: 'Ollama', models: [{ id: 'nemotron-cascade2:30b-a3b' }, { id: 'qwen3-coder:7b' }] })],
    activeProviderId: null,
    model: '',
  });
}

beforeEach(() => seed());

const saved = (over: Partial<SavedProvider>): SavedProvider => ({
  id: 'p_existing', kind: 'openai', baseUrl: 'http://127.0.0.1:13305/api/v1', label: 'Lemonade',
  serverType: 'Lemonade Server', models: [{ id: 'Llama-3.2-3B-Instruct-Hybrid' }],
  status: 'ok', authRequired: false,
  lastDiscoveredAt: 1000,
  ...over,
});

const discovered = (over: Partial<DiscoveredProvider>): DiscoveredProvider => ({
  kind: 'openai', baseUrl: 'http://127.0.0.1:13305/api/v1', name: 'Lemonade Server', reachable: true, models: [],
  ...over,
});

describe('§4/§7-8 — Companion settings are preserved; provider ops never touch them', () => {
  test('merge leaves the companion connection untouched and keeps saved provider identity', () => {
    const companionBefore = JSON.stringify(useSettings.getState().companion);
    const merge = mergeScanResults(useSettings.getState().providers, [
      discovered({ models: [{ id: 'Qwen2.5-Coder-7B' }] }),
      discovered({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama', models: [{ id: 'nemotron-cascade2:30b-a3b' }] }),
    ], { machineLabel: 'Portable' });
    // applying the merge never touches companion settings
    useSettings.setState({ providers: merge.providers as SavedProvider[] });
    const after = useSettings.getState();
    expect(JSON.stringify(after.companion)).toBe(companionBefore); // companion address/token untouched
    expect(after.providers).toHaveLength(2);
    const lem = after.providers[0] as SavedProvider;
    expect(lem.id).toBe('p_existing');                 // same identity — updated, not re-created
    expect(lem.models!.some((m) => m.id === 'Qwen2.5-Coder-7B'));
    expect(lem.label).toBe('Lemonade');                // human label preserved by merge
    expect(lem.serverType).toBe('Lemonade Server');
    expect(lem.machineLabel).toBe('Portable');
  });

  test('adding a provider with the same address as the companion cannot replace the companion', () => {
    const companionBefore = JSON.stringify(useSettings.getState().companion);
    // someone types the companion address into the provider scanner
    const merge = mergeScanResults(useSettings.getState().providers, [
      discovered({ baseUrl: 'http://127.0.0.1:7337', reachable: true, models: [], name: null, error: 'no recognized API' }),
    ]);
    useSettings.setState({ providers: merge.providers as SavedProvider[] });
    const after = useSettings.getState();
    expect(JSON.stringify(after.companion)).toBe(companionBefore);
    expect(after.companion.directUrl).toBe('http://127.0.0.1:7337');
    // the endpoint is recorded as a (failing) provider entry, not as companion
    expect(after.providers.some((p) => p.baseUrl.includes(':7337') && p.id !== undefined)).toBe(true);
    expect(after.providers.some((p) => p.baseUrl.includes(':7337') && p.models!.length === 0)).toBe(true); // recorded, unusable
  });
});

describe('§3/§7-9 — Model selection across providers', () => {
  test('activating a provider and choosing a model switches inference explicitly; other providers stay configured', () => {
    const st = useSettings.getState();
    const lemon = st.providers.find((p) => p.baseUrl.includes('13305'))!;
    const ollama = st.providers.find((p) => p.baseUrl.includes('11434'))!;
    st.setActiveProvider(lemon.id);
    st.setModel('Llama-3.2-3B-Instruct-Hybrid');
    expect(useSettings.getState().activeProviderId).toBe(lemon.id);
    expect(useSettings.getState().model).toBe('Llama-3.2-3B-Instruct-Hybrid');
    // explicit re-selection switches models — never a silent swap
    st.setActiveProvider(ollama.id);
    st.setModel('qwen3-coder:7b');
    expect(useSettings.getState().model).toBe('qwen3-coder:7b');
    // switching back keeps the explicitly chosen model until the user picks another
    st.setActiveProvider(lemon.id);
    expect(useSettings.getState().model).toBe('qwen3-coder:7b');
    // the other provider remains fully configured (activation deletes nothing)
    const ollamaAfter = useSettings.getState().providers.find((p) => p.baseUrl.includes('11434'))!;
    expect(ollamaAfter.models!.some((m) => m.id === 'nemotron-cascade2:30b-a3b')).toBe(true);
  });
});

describe('§4/§7-10 — Failed discovery and invalid URLs cannot damage configuration', () => {
  test('unreachable report on a saved provider: status-only update, models/label intact', () => {
    const before = useSettings.getState().providers.find((p) => p.baseUrl.includes('13305'))!;
    const merge = mergeScanResults([before], [discovered({ reachable: false, models: [], error: 'fetch failed' })]);
    expect(merge.providers).toHaveLength(1);
    const kept = merge.providers[0] as SavedProvider;
    expect(kept.status).toBe('unreachable');
    expect(kept.models!.length).toBeGreaterThan(0);        // model list preserved
    expect(kept.label).toBe('Lemonade');
    expect(kept.authRequired).toBe(false);                  // auth state preserved
    expect(merge.keptUnreachable).toBe(1);
    expect(merge.added).toHaveLength(0);
  });

  test('unreachable NEW endpoints are never added as providers', () => {
    const merge = mergeScanResults([], [discovered({ baseUrl: 'http://127.0.0.1:59999', reachable: false, models: [] })]);
    expect(merge.providers).toHaveLength(0);
    expect(merge.skippedUnreachableNew).toBe(1);
  });

  test('failed scan through the store changes nothing but statuses', () => {
    const snap = (providers: SavedProvider[]) => JSON.stringify(providers.map((p) => [p.id, p.models?.length, p.label, p.baseUrl]));
    const before = snap(useSettings.getState().providers);
    const merge = mergeScanResults(useSettings.getState().providers, [
      discovered({ reachable: false, models: [] }),
      discovered({ baseUrl: 'http://127.0.0.1:11434', kind: 'ollama', name: 'Ollama', reachable: false, models: [] }),
    ]);
    useSettings.setState({ providers: merge.providers as SavedProvider[] });
    const after = snap(useSettings.getState().providers);
    expect(after).toBe(before);
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
    const merge = mergeScanResults([bare], [discovered({ baseUrl: 'http://h:13305/api/v1', models: [{ id: 'm1' }] })]);
    expect(merge.providers).toHaveLength(1); // updated in place, no duplicate entry
    expect(merge.updated).toHaveLength(1);
  });
});
