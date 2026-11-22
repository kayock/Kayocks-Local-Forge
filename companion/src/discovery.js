// Automatic LAN discovery (Milestone 2) — mDNS/Bonjour via `bonjour-service`
// (pure JS, maintained, cross-platform: Windows/macOS/Linux, no native deps).
//
// Each Companion advertises ONLY what is needed to identify the service and
// establish a connection:
//   TXT { instanceId, name, version, platform }  +  host/port of the service.
//
// HARD RULES preserved from the mesh design:
//   - discovery NEVER pairs machines and NEVER grants access. Pairing stays
//     an explicit user action (existing /pair + pairing code).
//   - no public/WAN routing: connections still go through mesh.normalizePeerUrl
//     (private LAN / loopback addresses only) before any traffic is sent.
//   - `bonjour-service` is an optional dependency: without it the module
//     reports honestly that discovery is unavailable and manual IP entry
//     keeps working.
import os from 'node:os';
import crypto from 'node:crypto';
import { config, VERSION, getState, saveState, log } from './config.js';

let Bonjour = null;
let loadError = null;
try {
  ({ Bonjour } = await import('bonjour-service'));
} catch (e) {
  loadError = String(e?.message || e).slice(0, 160);
}

const SERVICE_TYPE = 'localforge-companion';
const OFFLINE_AFTER_MS = 30_000;   // no browse hit for 30s → offline
const PRUNE_EVERY_MS = 10_000;
const REBROADCAST_MS = 60_000;     // re-publish periodically (mDNS TTLs expire)

let bonjourInstance = null;
let published = null;
let rebroadcastTimer = null;
let pruneTimer = null;
let disabled = false;

// instanceId -> { instanceId, name, host, port, url, version, platform, lastSeenAt, online, local }
const discovered = new Map();

export function localInstanceId() {
  const s = getState();
  if (!s.instanceId) {
    s.instanceId = crypto.randomUUID();
    saveState();
  }
  return s.instanceId;
}

export function discoveryCapabilities() {
  if (disabled) return { available: false, enabled: false, reason: 'mDNS discovery disabled (--no-mdns).' };
  if (!Bonjour) return { available: false, enabled: false, reason: `bonjour-service not installed: ${loadError || 'optional dependency missing'} — use manual IP/hostname entry.` };
  return { available: true, enabled: true, serviceType: SERVICE_TYPE };
}

function lanHostname() {
  return (os.hostname() || 'unknown-host').replace(/\.local\.?$/, '').slice(0, 120);
}

function recordFromBrowse(svc) {
  const txt = svc.txt || {};
  const host = svc.addresses?.find((a) => a.includes('.') && !a.startsWith('127.')) || svc.host || svc.referer?.address || '';
  const port = svc.port || config.port;
  return {
    instanceId: String(txt.instanceId || svc.fqdn || svc.name).slice(0, 128),
    name: String(txt.name || svc.name).slice(0, 120),
    host,
    port,
    url: `http://${host}:${port}`,
    version: String(txt.version || '').slice(0, 24),
    platform: String(txt.platform || '').slice(0, 24),
    lastSeenAt: Date.now(),
    online: true,
    local: txt.instanceId === localInstanceId(),
  };
}

export function startDiscovery({ enabled = true } = {}) {
  disabled = !enabled;
  if (!enabled) return { started: false, reason: 'disabled' };
  if (!Bonjour) return { started: false, reason: loadError ? `bonjour-service unavailable: ${loadError}` : 'bonjour-service unavailable' };
  try {
    // loopback stays ENABLED (default): same-host multi-instance setups must
    // see each other, and packets from other LAN machines are never filtered
    // by this flag. Self-records are excluded by instanceId below.
    bonjourInstance = new Bonjour();
    // ---- advertise THIS companion (identifying info only) ----
    publishSelf();
    rebroadcastTimer = setInterval(() => {
      try { if (published) { published.stop(() => {}); published = null; } publishSelf(); } catch { /* ignore */ }
    }, REBROADCAST_MS);
    rebroadcastTimer.unref?.();

    // ---- browse for peers ----
    const browser = bonjourInstance.find({ type: SERVICE_TYPE }, (svc) => {
      try {
        const rec = recordFromBrowse(svc);
        if (rec.local) return; // never list ourselves
        if (!rec.host) return;
        discovered.set(rec.instanceId, rec);
        log('mdns_seen', { instanceId: rec.instanceId, name: rec.name, host: rec.host, port: rec.port, version: rec.version });
      } catch { /* ignore malformed advertisements */ }
    });
    pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, rec] of discovered) {
        if (rec.online && now - rec.lastSeenAt > OFFLINE_AFTER_MS) {
          rec.online = false;
          log('mdns_offline', { instanceId: id });
        }
      }
      // keep offline records for the UI (last-seen) but bound the map
      while (discovered.size > 100) {
        const oldest = [...discovered.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
        if (!oldest) break;
        discovered.delete(oldest[0]);
      }
    }, PRUNE_EVERY_MS);
    pruneTimer.unref?.();
    log('mdns_started', { serviceType: SERVICE_TYPE });
    return { started: true, serviceType: SERVICE_TYPE };
  } catch (e) {
    bonjourInstance = null;
    const reason = String(e?.message || e).slice(0, 200);
    log('mdns_start_failed', { reason });
    return { started: false, reason: `mDNS could not start: ${reason} — manual IP entry remains available.` };
  }
}

function publishSelf() {
  try {
    // Unique per instance: two Companions on one machine (or two test
    // instances) must not collide; the port disambiguates. The name carries
    // the hostname so users recognize the machine in the Fleet Map.
    // HARD LIMIT: the mDNS instance label must stay <= 63 bytes — longer
    // names produce silently-dropped packets. Truncate defensively.
    const instanceName = `LocalForge ${lanHostname()} #${config.port}`.slice(0, 63);
    published = bonjourInstance.publish({
      name: instanceName,
      type: SERVICE_TYPE,
      port: config.port,
      txt: {
        instanceId: localInstanceId(),
        name: lanHostname(),
        version: VERSION,
        platform: process.platform,
      },
    });
    // Surface asynchronous advertisement failures (socket bind errors etc.)
    // instead of letting them vanish — discovery degrades honestly.
    published.on('error', (e) => {
      log('mdns_publish_error', { reason: String(e?.message || e).slice(0, 200) });
    });
  } catch (e) {
    log('mdns_publish_failed', { reason: String(e?.message || e).slice(0, 160) });
  }
}

// Discovery status for the UI: what we saw, what is online. NEVER includes
// pairing tokens; pairing always requires the user-entered code.
export function discoveryStatus() {
  const caps = discoveryCapabilities();
  const now = Date.now();
  return {
    ...caps,
    self: {
      instanceId: localInstanceId(),
      name: lanHostname(),
      port: config.port,
      host: config.host,
      lanAddresses: lanAddressesLocal(),
      advertising: !!published,
    },
    discovered: [...discovered.values()]
      .sort((a, b) => (b.online - a.online) || (b.lastSeenAt - a.lastSeenAt))
      .map((r) => ({ ...r, online: r.online && now - r.lastSeenAt <= OFFLINE_AFTER_MS, secondsSinceSeen: Math.round((now - r.lastSeenAt) / 1000) })),
  };
}

function lanAddressesLocal() {
  const list = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const addr of addresses || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      list.push({ iface: name, address: addr.address });
    }
  }
  return list;
}

export function stopDiscovery() {
  try { rebroadcastTimer && clearInterval(rebroadcastTimer); } catch { /* ignore */ }
  try { pruneTimer && clearInterval(pruneTimer); } catch { /* ignore */ }
  try { published?.stop(() => {}); } catch { /* ignore */ }
  try { bonjourInstance?.destroy(); } catch { /* ignore */ }
  published = null;
  bonjourInstance = null;
}

// test seam: inject/observe records
export function _discoveredForTest() { return discovered; }
export function _resetForTest() { discovered.clear(); }
