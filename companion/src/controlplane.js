// Companion control-plane HTTP contract consumed by src/lib/mesh/client.ts.
import { sendJson, readBody } from './http-utils.js';
import { findWorkspace } from './config.js';
import * as checkpoints from './checkpoints.js';
import { hardwareInventory } from './platform.js';
import * as model from './modelmgr.js';
import * as mesh from './mesh.js';
import * as memory from './agentmem.js';
import * as tasks from './tasks.js';
import * as coordination from './coordination.js';
import * as memoryStore from './memory.js';
import { discoveryStatus } from './discovery.js';
import { loadModel as legacyLoad, unloadModel as legacyUnload } from './providers.js';

function respond(res, data) { return sendJson(res, data?.status >= 400 ? data.status : 200, data); }
function match(p, re) { return p.match(re); }
function unknownWs(id) { const e = new Error(`Unknown workspace: ${id}`); e.status = 404; throw e; }
function dec(v) { try { return decodeURIComponent(v); } catch { const e = new Error('Bad URL encoding'); e.status = 400; throw e; } }

// Return true if handled; false lets the existing Companion router handle its routes.
export async function routeControl(req, res, url, p) {
  const method = req.method;
  if (p === '/api/hardware' && method === 'GET') { respond(res, await hardwareInventory()); return true; }
  if (p === '/api/models' && method === 'GET') { respond(res, await model.inventory()); return true; }
  if (p === '/api/models/dirs' && method === 'POST') { respond(res, model.addDir((await readBody(req, 32*1024)).path)); return true; }
  if (p === '/api/models/dirs' && method === 'DELETE') { respond(res, model.removeDir((await readBody(req, 32*1024)).path)); return true; }
  if (p === '/api/models/profiles' && method === 'POST') { respond(res, model.saveProfile(await readBody(req, 64*1024))); return true; }
  let m;
  if ((m = match(p, /^\/api\/models\/profiles\/([^/]+)$/)) && method === 'DELETE') { respond(res, model.deleteProfile(dec(m[1]))); return true; }
  if ((m = match(p, /^\/api\/models\/status\/([^/]+)$/)) && method === 'GET') { respond(res, await model.status(dec(m[1]))); return true; }
  if ((m = match(p, /^\/api\/models\/diagnostics\/([^/]+)$/)) && method === 'GET') { respond(res, await model.diagnostics(dec(m[1]))); return true; }
  if ((m = match(p, /^\/api\/models\/output\/([^/]+)$/)) && method === 'GET') { respond(res, model.output(dec(m[1]), url.searchParams.get('since') || 0)); return true; }
  if (p === '/api/models/external' && method === 'POST') { const b = await readBody(req, 32*1024); respond(res, model.addExternal(b.name, b.endpoint)); return true; }
  if (p === '/api/models/load' && method === 'POST') {
    const b = await readBody(req, 64*1024);
    if (b.profileId !== undefined) respond(res, await model.loadProfile(b.profileId));
    else respond(res, await legacyLoad(b.provider, b.model, b.keepAlive));
    return true;
  }
  if (p === '/api/models/unload' && method === 'POST') {
    const b = await readBody(req, 64*1024);
    if (b.profileId !== undefined || b.serverId !== undefined) respond(res, await model.unloadProfile(b));
    else respond(res, await legacyUnload(b.provider, b.model));
    return true;
  }
  if (p === '/api/network' && method === 'GET') { respond(res, mesh.networkSettings()); return true; }
  if (p === '/api/network' && method === 'POST') { respond(res, mesh.setNetwork(await readBody(req, 32*1024))); return true; }
  if (p === '/api/network/test' && method === 'POST') { respond(res, await mesh.networkTest((await readBody(req, 32*1024)).url)); return true; }
  if (p === '/api/mesh/status' && method === 'GET') { respond(res, mesh.meshStatus()); return true; }
  if (p === '/api/mesh/discover' && method === 'GET') { respond(res, discoveryStatus()); return true; }
  if (p === '/api/mesh/connect' && method === 'POST') {
    const b = await readBody(req, 32*1024);
    respond(res, await mesh.connectPeer(b.url, b)); return true;
  }
  if ((m = match(p, /^\/api\/mesh\/peers\/([^/]+)\/pair$/)) && method === 'POST') {
    const b = await readBody(req, 32*1024);
    respond(res, await mesh.pairPeer(dec(m[1]), b.code, b.deviceLabel)); return true;
  }
  if ((m = match(p, /^\/api\/mesh\/peers\/([^/]+)$/))) {
    if (method === 'GET') { respond(res, await mesh.peerStatus(dec(m[1]))); return true; }
    if (method === 'DELETE') { respond(res, mesh.removePeer(dec(m[1]))); return true; }
  }
  if ((m = match(p, /^\/api\/mesh\/([^/]+)\/(proxy|p)(\/.*)$/))) {
    const r = await mesh.proxyPeer(dec(m[1]), req, m[3], url.search || '');
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(r.body); return true;
  }
  if ((m = match(p, /^\/api\/agents\/([^/]+)\/(scratchpad\/([^/]+)|notebook|assignments)$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    const resource = m[2];
    if (resource.startsWith('scratchpad/')) {
      const agent = dec(m[3]);
      if (method === 'GET') { respond(res, memory.readScratchpad(ws, agent)); return true; }
      if (method === 'PUT') { respond(res, memory.writeScratchpad(ws, agent, await readBody(req, 128*1024))); return true; }
    } else if (resource === 'notebook') {
      if (method === 'GET') { respond(res, memory.notebookList(ws, url.searchParams)); return true; }
      if (method === 'POST') { respond(res, memory.notebookAppend(ws, await readBody(req, 64*1024))); return true; }
    } else if (resource === 'assignments') {
      if (method === 'GET') { respond(res, memory.listAssignments(ws)); return true; }
      if (method === 'POST') { respond(res, memory.saveAssignment(ws, await readBody(req, 64*1024))); return true; }
    }
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/revision$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, await memory.workspaceRevision(ws)); return true;
  }

  // ---- RC3: task checkpoints (shadow git) ----
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/checkpoints$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    if (method === 'GET') { respond(res, checkpoints.listCheckpoints(ws)); return true; }
    if (method === 'POST') { respond(res, checkpoints.createCheckpoint(ws, (await readBody(req, 8 * 1024))?.label)); return true; }
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/checkpoints\/([\w.:-]+)\/diff$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, checkpoints.checkpointDiff(ws, dec(m[2]))); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/checkpoints\/([\w.:-]+)\/restore$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, checkpoints.restoreCheckpoint(ws, dec(m[2]))); return true;
  }

  // ---- Milestone 2: cross-machine task packets ----
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/tasks$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    if (method === 'GET') { respond(res, tasks.listTasks(ws.id, url.searchParams)); return true; }
    if (method === 'POST') { respond(res, tasks.createTask(ws.id, await readBody(req, 128 * 1024))); return true; }
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/tasks\/([^/]+)\/(ack|progress|complete|fail|cancel)$/)) && method === 'POST') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    const id = dec(m[2]);
    const body = await readBody(req, 128 * 1024).catch(() => ({}));
    const action = m[3];
    if (action === 'ack') respond(res, tasks.ackTask(ws.id, id, body));
    else if (action === 'progress') respond(res, tasks.progressTask(ws.id, id, body));
    else if (action === 'complete') respond(res, tasks.completeTask(ws.id, id, body));
    else if (action === 'fail') respond(res, tasks.failTask(ws.id, id, body));
    else respond(res, tasks.cancelTask(ws.id, id, body));
    return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/tasks\/([^/]+)$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, tasks.getTask(ws.id, dec(m[2]))); return true;
  }

  // ---- Milestone 3: persistent project memory ----
  if (p === '/api/memory/capabilities' && method === 'GET') { respond(res, memoryStore.memoryCapabilities()); return true; }
  if (p === '/api/memory/embeddings' && method === 'POST') {
    const b = await readBody(req, 8 * 1024);
    respond(res, b && b.endpoint === null ? memoryStore.configureEmbeddings(null) : memoryStore.configureEmbeddings(b));
    return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    if (method === 'GET') { respond(res, memoryStore.listMemories(ws.id, url.searchParams)); return true; }
    if (method === 'POST') { respond(res, memoryStore.writeMemory(ws.id, await readBody(req, 64 * 1024))); return true; }
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/search$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, await memoryStore.searchMemory(ws.id, url.searchParams)); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/files$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, await memoryStore.searchFiles(ws.id, url.searchParams)); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/index$/)) && method === 'POST') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    const b = await readBody(req, 8 * 1024).catch(() => ({}));
    respond(res, await memoryStore.indexWorkspace(ws, { full: b?.full === true })); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/stats$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, memoryStore.memoryStats(ws.id)); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/export$/)) && method === 'GET') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    respond(res, memoryStore.exportMemory(ws.id)); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/import$/)) && method === 'POST') {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    const b = await readBody(req, 16 * 1024 * 1024);
    respond(res, memoryStore.importMemory(ws.id, b, { replace: b?.replace === true })); return true;
  }
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/memory\/([^/]+)$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    const id = dec(m[2]);
    if (method === 'GET') { respond(res, memoryStore.readMemory(ws.id, id)); return true; }
    if (method === 'PUT') { respond(res, memoryStore.updateMemory(ws.id, id, await readBody(req, 64 * 1024))); return true; }
    if (method === 'DELETE') { respond(res, memoryStore.deleteMemory(ws.id, id)); return true; }
  }

  // ---- Milestone 2: workspace write reservations (advisory locks) ----
  if ((m = match(p, /^\/api\/ws\/([^/]+)\/locks$/))) {
    const ws = findWorkspace(dec(m[1])); if (!ws) unknownWs(m[1]);
    if (method === 'GET') { respond(res, coordination.listLocks(ws.id)); return true; }
    if (method === 'POST') {
      const b = await readBody(req, 16 * 1024);
      respond(res, b.release ? coordination.releaseLock(ws.id, b.path, b.owner) : coordination.acquireLock(ws.id, b.path, b.owner, b));
      return true;
    }
  }
  return false;
}
export { mesh, model };
