// Explicitly paired LAN peers. No implicit broad network scans, no public/WAN routing.
// Milestone 2: mDNS advertisement/browsing lives in discovery.js — pairing is
// still manual, user-approved, and code-confirmed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { config, getState, saveState } from './config.js';
import { hardwareInventory } from './platform.js';
import * as tasks from './tasks.js';
import { discoveryStatus } from './discovery.js';

function bad(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function peers() { const s = getState(); if (!s.meshPeers) s.meshPeers = []; return s.meshPeers; }
function peerById(id) { const x = peers().find((p) => p.id === id); if (!x) bad('Unknown mesh peer', 404); return x; }
const credentialFile = () => path.join(config.home, 'mesh-peer-credentials.json');
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(credentialFile(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function writeCredential(id, token) {
  const all = readCredentials();
  if (token) all[id] = token; else delete all[id];
  const dest = credentialFile(); const tmp = dest + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* platform may not support POSIX modes */ }
}
function privateIp(ip) {
  if (ip.startsWith('::ffff:')) return privateIp(ip.slice(7));
  if (net.isIP(ip) === 6) return ip === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip);
  if (net.isIP(ip) !== 4) return false;
  const b = ip.split('.').map(Number);
  return b[0] === 10 || b[0] === 127 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
    (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);
}
export async function normalizePeerUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) bad('Invalid companion URL');
  let u;
  try { u = new URL(raw); } catch { bad('Invalid companion URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) bad('Companion URL must be an HTTP(S) origin without credentials, query or path');
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  // Resolve names once before use; only private LAN/loopback destinations are allowed.
  if (!net.isIP(hostname) && !/^[a-z0-9._-]{1,253}$/i.test(hostname)) bad('Invalid hostname');
  let addresses;
  try { addresses = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((x) => x.address); }
  catch { bad('Companion hostname did not resolve'); }
  if (!addresses.length || addresses.some((ip) => !privateIp(ip))) bad('Mesh companions must resolve to a private LAN or loopback address');
  return u.origin;
}
async function getJson(endpoint, { method = 'GET', token, body, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, redirect: 'error' });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } catch (e) { bad(`Peer request failed: ${e.message}`, 502); }
  finally { clearTimeout(t); }
}
async function healthAt(url) {
  const r = await getJson(`${url}/health`);
  if (r.status !== 200 || !r.json?.ok || r.json?.name !== 'localforge-companion') bad('The URL is not a reachable LocalForge Companion', 502);
  return r.json;
}
export function meshStatus() {
  const credential = readCredentials();
  let discovery = null;
  try { discovery = discoveryStatus(); } catch { /* discovery module unavailable */ }
  return {
    instanceId: localInstanceId(),
    peers: peers().map(({ id, name, url, platform, version, buildId, addedAt, lastSeenAt, lastStatus }) => ({ id, name, url, platform, version, buildId, addedAt, lastSeenAt, lastStatus, paired: !!credential[id] })),
    discovered: discovery?.discovered || [],
    discovery: discovery ? { available: discovery.available, enabled: discovery.enabled, advertising: discovery.self?.advertising, reason: discovery.reason, self: discovery.self } : { available: false, enabled: false, reason: 'discovery module unavailable' },
  };
}
function localInstanceId() {
  const s = getState();
  if (!s.instanceId) { s.instanceId = crypto.randomUUID(); saveState(); }
  return s.instanceId;
}
async function pairToPeer(peer, code, deviceLabel = 'LocalForge mesh peer') {
  if (typeof code !== 'string' || !/^[A-Z0-9]{8}$/i.test(code.trim())) bad('A valid eight-character pairing code is required');
  const r = await getJson(`${peer.url}/pair`, { method: 'POST', body: { code: code.trim().toUpperCase(), deviceLabel } });
  if (r.status !== 200 || !r.json?.token) bad(r.json?.error || 'Pairing failed', r.status || 502);
  writeCredential(peer.id, r.json.token);
  peer.lastStatus = 'paired'; peer.lastSeenAt = Date.now(); saveState();
  return true;
}
export async function connectPeer(rawUrl, options = {}) {
  const url = await normalizePeerUrl(rawUrl);
  const health = await healthAt(url);
  let peer = peers().find((p) => p.url === url);
  if (!peer) {
    peer = { id: crypto.randomUUID(), url, name: String(options.name || health.resources?.hostname || url).slice(0,128), addedAt: new Date().toISOString() };
    peers().push(peer);
  }
  peer.platform = health.platform; peer.version = health.version; peer.lastSeenAt = Date.now(); peer.lastStatus = 'reachable'; saveState();
  if (options.code) await pairToPeer(peer, options.code, options.deviceLabel);
  return { peer: meshStatus().peers.find((p) => p.id === peer.id), paired: !!readCredentials()[peer.id], health };
}
export async function pairPeer(id, code, deviceLabel) {
  const peer = peerById(id);
  await normalizePeerUrl(peer.url);
  await pairToPeer(peer, code, deviceLabel);
  return { peer: meshStatus().peers.find((p) => p.id === peer.id), paired: true };
}
export function removePeer(id) {
  peerById(id);
  const s = getState();
  s.meshPeers = peers().filter((x) => x.id !== id);
  writeCredential(id, null); saveState(); return { removed: true };
}
export async function peerStatus(id) {
  const p = peerById(id);
  const credential = readCredentials()[p.id];
  let reachable = false, health = null, hardware = null;
  try {
    await normalizePeerUrl(p.url);
    const h = await healthAt(p.url);
    reachable = true; health = { version: h.version, buildId: h.buildId || '', platform: h.platform };
    if (credential) {
      const result = await getJson(`${p.url}/api/hardware`, { token: credential });
      if (result.status === 200) hardware = result.json;
    }
    p.lastStatus = credential ? (hardware ? 'ready' : 'paired-api-unavailable') : 'unpaired';
  } catch { p.lastStatus = 'unreachable'; }
  if (reachable) p.lastSeenAt = Date.now();
  else {
    // Milestone 2 — graceful recovery: a disconnected machine cannot silently
    // keep active tasks. Its active task packets are marked failed so the
    // coordinator can reassign them explicitly (never auto-retried).
    for (const ws of getState().workspaces || []) {
      try { tasks.failActiveTasksForMachine(ws.id, p.id, `peer ${p.name} unreachable (${p.lastStatus})`); } catch { /* ignore */ }
    }
  }
  saveState();
  return { peer: { ...p, paired: !!credential }, reachable, health, hardware };
}
// Milestone 2: the proxy carries the full workspace tool surface a remote
// agent needs (fs, exec, browser, revisions, locks, task packets) plus the
// Phase-2 inventory/memory routes. /term and /pty streaming channels are NOT
// proxied (buffered JSON only) — agents use /exec.
const proxied = /^\/api\/(?:hardware|models(?:\/(?:dirs|load|unload|external|profiles(?:\/[\w.-]+)?|status\/[\w.:-]+|diagnostics\/[\w.:-]+|output\/[\w.:-]+))?|network(?:\/test)?|mesh\/discover|agents\/[\w-]+\/(?:scratchpad\/[\w.:-]+|notebook|assignments)|ws\/[\w-]+(?:\/(?:tree|file(?:\/append)?|mkdir|delete|rename|stat|search|exec|term(?:\/signal)?|proc\/(?:start|list|output|stop)|browser\/(?:open|navigate|eval|screenshot|verify|close|status)|diff\/preview|revision|locks|tasks(?:\/[\w-]+(?:\/(?:ack|progress|complete|fail|cancel))?)?|memory(?:\/(?:search|files|index|stats|export|import|[\w-]{8,64}))?))?|memory\/capabilities)?$/;
export async function proxyPeer(id, req, relativePath, query) {
  if (!proxied.test(relativePath) || relativePath.includes('..') || relativePath.includes('%')) bad('This route is not available through mesh proxy', 403);
  const peer = peerById(id); const token = readCredentials()[id];
  if (!token) bad('Peer is not paired', 401);
  await normalizePeerUrl(peer.url);
  const method = req.method;
  if (!['GET','POST','PUT','DELETE'].includes(method)) bad('Unsupported mesh proxy method', 405);
  let body;
  if (method !== 'GET') {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) bad('Mesh proxy body too large', 413);
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  const ctrl = new AbortController();
  // Model loading can legitimately take many minutes on local hardware;
  // workspace exec mirrors the companion's own command timeout ceiling.
  const timeout = relativePath === '/api/models/load' ? 30 * 60_000
    : /\/api\/ws\/[\w-]+\/(?:exec|term)/.test(relativePath) ? 600_000
    : 60000;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(`${peer.url}${relativePath}${query}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body, signal: ctrl.signal, redirect: 'error',
    });
    const result = await response.text();
    if (Buffer.byteLength(result) > 8 * 1024 * 1024) bad('Peer response too large', 502);
    return { status: response.status, body: result };
  } catch (e) { bad(`Mesh proxy failed: ${e.message}`, 502); }
  finally { clearTimeout(timer); }
}
export function lanAddresses() {
  const list = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) for (const addr of addresses || []) {
    if (addr.family !== 'IPv4' || addr.internal) continue;
    list.push({ name, address: addr.address, url: `http://${addr.address}:${config.port}` });
  }
  return list;
}
export function networkSettings() {
  const desired = getState().network || {};
  const host = desired.host || config.host; const port = desired.port || config.port;
  return { host, port, lanEnabled: !['127.0.0.1','::1','localhost'].includes(host), active: { host: config.host, port: config.port }, pendingRestart: host !== config.host || port !== config.port,
    lanAddresses: lanAddresses(), loopbackUrl: `http://127.0.0.1:${config.port}`,
    security: { pairingRequired: true, note: 'Existing Companion pairing remains required for API access; changes require a restart.' },
    service: { systemdUnit: 'localforge-companion.service', managementHint: 'Restart the installed Companion service or tray app to apply saved networking changes.' } };
}
export function setNetwork(patch) {
  const s = getState(); const netcfg = s.network || { host: config.host, port: config.port };
  if (patch.host !== undefined && (typeof patch.host !== 'string' || !/^[a-zA-Z0-9.:_-]{1,253}$/.test(patch.host))) bad('Invalid host');
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) bad('Invalid port');
  if (patch.lanEnabled !== undefined && typeof patch.lanEnabled !== 'boolean') bad('Invalid lanEnabled');
  if (patch.host !== undefined) netcfg.host = patch.host;
  if (patch.lanEnabled !== undefined) netcfg.host = patch.lanEnabled ? (patch.host || '0.0.0.0') : '127.0.0.1';
  if (patch.port !== undefined) netcfg.port = patch.port;
  s.network = netcfg; saveState();
  return { applied: netcfg.host === config.host && netcfg.port === config.port, host: netcfg.host, port: netcfg.port, lanEnabled: !['127.0.0.1','::1','localhost'].includes(netcfg.host), lanAddresses: lanAddresses() };
}
export async function networkTest(rawUrl) {
  const target = await normalizePeerUrl(rawUrl);
  try {
    const h = await healthAt(target);
    return { target, reachable: true, isLocalforgeCompanion: true, version: h.version, detail: 'LocalForge Companion responded' };
  } catch (e) {
    return { target, reachable: false, isLocalforgeCompanion: false, version: null, detail: e.message };
  }
}
export function applySavedNetwork() {
  const saved = getState().network;
  if (!saved) return;
  // Explicit CLI and environment settings always take precedence.
  if (!process.argv.includes('--host') && !process.env.LOCALFORGE_HOST && saved.host) config.host = saved.host;
  if (!process.argv.includes('--port') && !process.env.LOCALFORGE_PORT && saved.port) config.port = saved.port;
}
