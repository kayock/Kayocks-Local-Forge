// Phase 2 control plane — real two-Companion integration on loopback.
// Never touches an installed LocalForge, external AI service, or user workspaces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'localforge-controlplane-'));
const services = [];
let fakeOllama = null;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launch(label, env = {}) {
  const port = await freePort();
  const home = path.join(temp, label); fs.mkdirSync(home);
  const child = spawn(process.execPath, ['src/server.js','--host','127.0.0.1','--port',String(port),'--home',home], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), stdio: ['ignore','pipe','pipe'], env: {...process.env, ...env},
  });
  services.push(child);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<100;i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${base}/health`); if (r.ok) { ready = true; break; } } catch { /* not started yet */ }
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  assert.ok(ready, `Companion ${label} must start`);
  const code = JSON.parse(fs.readFileSync(path.join(home,'state.json'),'utf8')).pairingCode;
  const pair = await fetch(`${base}/pair`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code,deviceLabel:'controlplane-test'}) });
  assert.equal(pair.status,200);
  const { token } = await pair.json();
  const api = async (method, route, body, authed = true) => {
    const r = await fetch(`${base}${route}`, { method, headers: { ...(authed ? {Authorization:`Bearer ${token}`} : {}), ...(body !== undefined ? {'Content-Type':'application/json'} : {}) }, body:body===undefined ? undefined : JSON.stringify(body) });
    return { code:r.status, json:await r.json().catch(()=>null) };
  };
  return { base, port, home, code, token, api };
}

after(async()=>{
  for(const c of services) c.kill();
  if(fakeOllama) await new Promise((r)=>fakeOllama.close(r));
  fs.rmSync(temp,{recursive:true,force:true});
});

test('control plane: real peers, inventory, profile contract, durable agent memory and model lifecycle', async()=>{
  const requests=[];
  fakeOllama=http.createServer(async (req,res)=>{
    requests.push(req.method+' '+req.url);
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/tags') return res.end(JSON.stringify({models:[{name:'fixture:1b',size:1000,details:{parameter_size:'1B',quantization_level:'Q4'}}]}));
    if(req.url==='/api/ps') return res.end(JSON.stringify({models:[]}));
    if(req.url==='/api/generate') { for await (const _ of req) {} return res.end(JSON.stringify({done:true})); }
    res.statusCode=404;res.end('{}');
  });
  await new Promise((r)=>fakeOllama.listen(0,'127.0.0.1',r));
  const ollama=`http://127.0.0.1:${fakeOllama.address().port}`;
  const a=await launch('a',{OLLAMA_HOST:ollama});
  const b=await launch('b',{OLLAMA_HOST:ollama});
  assert.equal((await a.api('GET','/api/hardware',undefined,false)).code,401);
  const hardware=await a.api('GET','/api/hardware');
  assert.equal(hardware.code,200);assert.equal(typeof hardware.json.cpuCores,'number');
  assert.ok(Array.isArray(hardware.json.gpus));
  const original=await a.api('GET','/api/models');
  assert.equal(original.code,200);
  assert.equal(original.json.ollama.reachable,true);
  assert.ok(original.json.ollama.models.some((m)=>m.name==='fixture:1b'));
  assert.equal(requests.includes('POST /api/generate'),false,'Inventory must not start a model');

  const project=path.join(temp,'project');fs.mkdirSync(project);
  const opened=await a.api('POST','/api/workspaces',{path:project,name:'fixture'});
  assert.equal(opened.code,200);
  const ws=opened.json.workspace.id;
  const initial=await a.api('GET',`/api/ws/${ws}/revision`);
  assert.equal(initial.json.entries,0);
  fs.writeFileSync(path.join(project,'file.txt'),'a test');
  const changed=await a.api('GET',`/api/ws/${ws}/revision`);
  assert.notEqual(changed.json.revision,initial.json.revision);
  assert.equal(changed.json.entries,1);

  const missing=await a.api('GET',`/api/agents/${ws}/scratchpad/planner`);
  assert.equal(missing.code,200);assert.deepEqual(missing.json.plan,[]);
  const written=await a.api('PUT',`/api/agents/${ws}/scratchpad/planner`,{objective:'do task',plan:['step 1'],progress:'working'});
  assert.equal(written.json.objective,'do task');
  const again=await a.api('GET',`/api/agents/${ws}/scratchpad/planner`);
  assert.deepEqual(again.json.plan,['step 1']);
  const note=await a.api('POST',`/api/agents/${ws}/notebook`,{agentId:'planner',kind:'finding',content:'fact'});
  assert.equal(note.code,200);assert.equal(note.json.seq,1);
  assert.equal((await a.api('GET',`/api/agents/${ws}/notebook?since=1`)).json.entries.length,0);
  const assigned=await a.api('POST',`/api/agents/${ws}/assignments`,{agentId:'planner',role:'planning',machine:'local',model:'fixture:1b',task:'test',status:'pending'});
  assert.ok(assigned.json.id);
  const assignments=await a.api('GET',`/api/agents/${ws}/assignments`);
  assert.equal(assignments.json.assignments.length,1);
  assert.equal((await a.api('GET','/api/agents/unknown/notebook')).code,404);
  assert.ok(fs.existsSync(path.join(a.home,'agent-memory',`${ws}.json`)));

  const addedDir=await a.api('POST','/api/models/dirs',{path:project});
  assert.equal(addedDir.code,200);
  fs.writeFileSync(path.join(project,'toy.gguf'),'tiny');
  const inv=await a.api('GET','/api/models');
  assert.ok(inv.json.gguf.some((m)=>m.name==='toy.gguf'));

  const saved=await a.api('POST','/api/models/profiles',{name:'fixture-model',backend:'ollama',modelId:'fixture:1b',ollamaUrl:ollama,ctx:32768,residency:'on-demand'});
  assert.equal(saved.code,200);const id=saved.json.profile.id;
  assert.equal(saved.json.profile.ctx,32768);
  assert.equal((await a.api('GET','/api/models')).json.profiles.some((m)=>m.id===id),true);
  const loaded=await a.api('POST','/api/models/load',{profileId:id});
  assert.equal(loaded.code,200,JSON.stringify(loaded.json));
  assert.equal(loaded.json.server.status,'ready');
  assert.equal(loaded.json.server.ownership,'ollama');
  assert.ok(requests.includes('POST /api/generate'));
  const serverId=loaded.json.server.id;
  assert.equal((await a.api('GET',`/api/models/status/${serverId}`)).json.server.status,'ready');
  const logs=await a.api('GET',`/api/models/output/${serverId}?since=0`);
  assert.equal(typeof logs.json.byteOffset,'number');
  const unloaded=await a.api('POST','/api/models/unload',{serverId});
  assert.equal(unloaded.json.server.status,'stopped');
  assert.equal((await a.api('DELETE',`/api/models/profiles/${id}`)).json.removed,true);
  assert.equal((await a.api('DELETE','/api/models/dirs',{path:project})).json.dirs.length,0);
  const oldLoad=await a.api('POST','/api/models/load',{provider:{kind:'ollama',baseUrl:ollama},model:'fixture:1b'});
  assert.equal(oldLoad.json.ok,true,'Existing provider contract preserved');

  // Real managed inference-process lifecycle using a disposable fake llama-server,
  // not an actual GPU/model and not an existing user service.
  if (process.platform !== 'win32') {
    const fakeExe = path.join(temp, 'fake-llama-server');
    const fakeModel = path.join(temp, 'fixture.gguf');
    const port = await freePort();
    fs.writeFileSync(fakeModel, 'fixture-only');
    fs.writeFileSync(fakeExe, `#!/usr/bin/env node
const http=require('node:http');
const args=process.argv;const port=Number(args[args.indexOf('--port')+1]);
const s=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok'}));});
s.listen(port,'127.0.0.1',()=>console.log('fake-model-ready'));
process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
`);
    fs.chmodSync(fakeExe, 0o755);
    const profile = await a.api('POST','/api/models/profiles', { name:'isolated-managed-fixture',backend:'llamacpp',serverExe:fakeExe,modelPath:fakeModel,port,ctx:131072,timeoutMs:15000 });
    assert.equal(profile.code,200);
    const loadedServer = await a.api('POST','/api/models/load',{profileId:profile.json.profile.id});
    assert.equal(loadedServer.code,200,JSON.stringify(loadedServer.json));
    assert.equal(loadedServer.json.server.ownership,'localforge-managed');
    assert.equal(loadedServer.json.server.status,'ready');
    const managedId=loadedServer.json.server.id;
    const diagnostics=await a.api('GET',`/api/models/diagnostics/${managedId}`);
    assert.ok(diagnostics.json.diagnostics.healthAttempts>=1);
    assert.equal(diagnostics.json.server.status,'ready');
    const processOutput=await a.api('GET',`/api/models/output/${managedId}?since=0`);
    assert.match(processOutput.json.output,/fake-model-ready/);
    const stopped=await a.api('POST','/api/models/unload',{serverId:managedId});
    assert.equal(stopped.json.server.status,'stopped');
  }

  const settings=await a.api('GET','/api/network');
  assert.equal(settings.json.active.port,a.port);
  const pending=await a.api('POST','/api/network',{port:65501});
  assert.equal(pending.json.applied,false);
  assert.equal((await a.api('GET','/api/network')).json.pendingRestart,true);
  await a.api('POST','/api/network',{port:a.port});
  const check=await a.api('POST','/api/network/test',{url:b.base});
  assert.equal(check.json.isLocalforgeCompanion,true);
  const notLan=await a.api('POST','/api/mesh/connect',{url:'http://8.8.8.8:7337'});
  assert.equal(notLan.code,400);

  const connected=await a.api('POST','/api/mesh/connect',{url:b.base,name:'Machine B',code:b.code});
  assert.equal(connected.code,200,JSON.stringify(connected.json));
  assert.equal(connected.json.paired,true);
  const peer=connected.json.peer.id;
  const status=await a.api('GET','/api/mesh/status');
  assert.equal(status.json.peers.length,1);
  assert.equal(status.json.peers[0].paired,true);
  assert.ok(!JSON.stringify(status.json).includes(b.token),'Peer tokens must not appear in public API');
  const peerStatus=await a.api('GET',`/api/mesh/peers/${peer}`);
  assert.equal(peerStatus.json.reachable,true);
  assert.ok(peerStatus.json.hardware.cpuCores>0);
  const proxied=await a.api('GET',`/api/mesh/${peer}/proxy/api/models`);
  assert.equal(proxied.code,200);assert.ok(proxied.json.ollama);
  const denied=await a.api('POST',`/api/mesh/${peer}/proxy/api/ws/${ws}/exec`,{cmd:'echo unsafe'});
  assert.equal(denied.code,403,'Mesh proxy may not bypass local workspace execution controls');
  assert.ok(fs.existsSync(path.join(a.home,'mesh-peer-credentials.json')));
  assert.equal((await a.api('DELETE',`/api/mesh/peers/${peer}`)).json.removed,true);
  assert.equal((await a.api('GET',`/api/mesh/${peer}/proxy/api/models`)).code,404);
});
