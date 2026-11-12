import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkClient } from '@clerk/backend';
import { generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startCanonicalApp } from './server.ts';
import { openDeviceRuntime } from './device-runtime.ts';
import { createAuth, type AuthConfig } from './auth.ts';
import { prepareRestoreBootstrap, issueRestoreSession, restoreWorkspace, workspaceSnapshot } from './backup.ts';
import { canonicalJson, ProtocolError, digestCommand, sha256 } from './protocol.ts';
import { parseOwnership } from './task-recovery.ts';
import sharp from 'sharp';
import { saveSkill } from './skills.ts';
import { initializeSites, saveSite } from './sites.ts';

function memoryKeys() {
  const values = new Map<string, string>();
  return { values, entry(service: string, name: string) { const key = `${service}/${name}`; return { getPassword: () => values.get(key) ?? null, setPassword: (value: string) => { values.set(key, value); } }; } };
}

test('canonical site management keeps project scope and recovers one deletion after a lost reply and restart',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),otherProject=randomUUID(),agent=randomUUID(),site=randomUUID(),foreign=randomUUID();
    for(const id of [project,otherProject])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:id})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Site owner',model:'fixture',backupModel:'',instructions:'Manage sites',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{
      initializeSites(db);const owner=db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_owner'").get()!.id;
      for(const [id,scope] of [[site,project],[foreign,otherProject]]){
        saveSite(db,agent,{id,name:'Scoped site',source:'<p>PRIVATE_SITE_SOURCE</p>'});
        db.prepare("INSERT INTO record_scopes VALUES ('local_sites',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),owner,scope,agent);
      }
    }finally{db.close();}
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'List and delete my site',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId);let sequence=0;
    const input=async(name:string,args:unknown)=>{
      const detail=(await f.send(`/api/tasks/${taskId}`)).body.data,context=await runtime.taskContext(taskId,owned.ownership,detail.revision),actionId=randomUUID();
      return {taskId,actionId,sequence:sequence++,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    };
    const listing=await runtime.executeAction(await input('list_sites',{}),()=>assert.fail('Host effect')),result=JSON.parse(String(listing.result_json));
    assert.deepEqual(result.sites.map((row:{id:string})=>row.id),[site]);assert(!JSON.stringify(result).includes('PRIVATE_SITE_SOURCE'));
    const deletion=await input('delete_site',{site,revision:1});
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost site deletion');}return response;};
    await assert.rejects(runtime.executeAction(deletion,()=>assert.fail('Host effect')),/Lost site deletion/);globalThis.fetch=originalFetch;
    const generation=connection.state().generation;
    await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>generation);
    await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===deletion.actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.results.length,2);assert.deepEqual(detail.results[1].content,{id:site,name:'Scoped site',revision:2,deleted:1,path:null});
    const inspect=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.deepEqual({...inspect.prepare('SELECT revision,deleted,source,html FROM local_sites WHERE id=?').get(site)!},{revision:2,deleted:1,source:'',html:''});assert.equal(inspect.prepare('SELECT deleted FROM local_sites WHERE id=?').get(foreign)!.deleted,0);assert.equal(inspect.prepare('SELECT count(*) n FROM site_commands WHERE site=?').get(site)!.n,2);}finally{inspect.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical questions survive lost RPC and answer replies, restart and home outage without duplicate work', async () => {
  const f=await fixture(),keys=memoryKeys(),originalFetch=globalThis.fetch;
  const runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  let closed=false;
  try {
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Questions'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Reader',model:'fixture',backupModel:'',instructions:'Ask first',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Ask before continuing',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    const input={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:['Yes','No']})}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost question result');}return response;};
    await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost question result/);globalThis.fetch=originalFetch;
    let detail=(await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(detail.state,'paused');assert.equal(detail.questions.length,1);assert.equal(detail.questions[0].answer,null);
    const generation=connection.state().generation;
    await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>generation);
    await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.questions.length,1);assert.equal(detail.results.length,1);
    const path=`/api/tasks/${taskId}/questions/${detail.questions[0].id}/answer`,answer={requestId:randomUUID(),expectedRevision:detail.revision,text:'Yes'};
    assert.equal((await f.send(path,{...answer,text:'Maybe'})).status,400);
    assert.equal((await f.send(path,answer,'user_foreign')).status,404);
    assert.equal((await f.send(`/api/tasks/${taskId}/control`,{requestId:randomUUID(),expectedRevision:detail.revision,operation:'resume'})).body.error.code,'question_pending');
    assert.equal((await f.send(path,{...answer,expectedRevision:1})).body.error.code,'stale_revision');
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/answer')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost answer result');}return response;};
    await assert.rejects(f.send(path,answer),/Lost answer result/);globalThis.fetch=originalFetch;
    const beforeAnswerRestart=connection.state().generation;
    await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>beforeAnswerRestart);
    const replay=await f.send(path,answer);assert.equal(replay.status,200);assert.equal(replay.body.data.answer,'Yes');
    assert.equal((await f.send(path,{...answer,text:'No'})).body.error.code,'payload_conflict');
    detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.state,'running');assert.equal(detail.questions[0].answer,'Yes');
    const continued=await runtime.taskContext(taskId,owned.ownership,detail.revision);
    assert.equal((continued.snapshot.conversation as {questions:{answer:string}[]}).questions[0].answer,'Yes');
    await runtime.executeAction({taskId,actionId:randomUUID(),sequence:1,actionKind:'read',ownership:owned.ownership,payload:{operation:'after answer'},context:continued,grantRevision:1},()=>({text:'Continued once'}));
    detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.results.length,2);
    const nextContext=await runtime.taskContext(taskId,owned.ownership,detail.revision),nextAction=randomUUID();
    await runtime.executeAction({taskId,actionId:nextAction,sequence:2,actionKind:'canonical',ownership:owned.ownership,payload:{toolCall:{id:nextAction,function:{name:'ask_user',arguments:JSON.stringify({question:'More input?',choices:[]})}},expectedRevision:nextContext.snapshot.taskRevision+1},context:nextContext,grantRevision:1},()=>assert.fail('Host effect'));
    await runtime.close();closed=true;
    await until(async()=>(await f.send('/api/devices')).body.data[0].status!=='ready');
    detail=(await f.send(`/api/tasks/${taskId}`)).body.data;
    const offline=await f.send(`/api/tasks/${taskId}/questions/${detail.questions[1].id}/answer`,{requestId:randomUUID(),expectedRevision:detail.revision,text:'Saved while offline'});
    assert.equal(offline.status,200);assert.equal(offline.body.data.state,'waiting_device');
    assert.deepEqual((await f.send(path,answer)).body.receipt,replay.body.receipt);
  } finally {globalThis.fetch=originalFetch;if(!closed)await runtime.close();await f.close();}
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-device-http-')), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth: AuthConfig = { secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`, issuer: 'https://fixture.clerk.accounts.dev', origin: 'http://127.0.0.1', development: true };
  const clerk = createClerkClient({ secretKey: auth.secretKey, publishableKey: auth.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const options = { database: join(dir, 'canonical.sqlite'), auth, clerk };
  let app = await startCanonicalApp(options); auth.origin = app.origin;
  const jwt = (subject = 'user_owner') => {
    const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url'), claims = Buffer.from(JSON.stringify({ iss: auth.issuer, sub: subject, sid: `sess_${subject}`, azp: auth.origin, exp: now + 300, nbf: now - 1, iat: now - 1 })).toString('base64url');
    return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url')}`;
  };
  const send = async (path: string, body?: { requestId: string; [key: string]: unknown }, subject = 'user_owner', method = body ? 'POST' : 'GET') => {
    const response = await fetch(app.origin + path, { method, headers: { Authorization: `Bearer ${jwt(subject)}`, Origin: auth.origin, Connection: 'close', 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': body?.requestId ?? randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { dir, jwt, send, origin: () => app.origin, startAgain: (database=options.database,port=0) => startCanonicalApp({...options,database,port}), async restart() { const port = new URL(app.origin).port; await app.close(); app = await startCanonicalApp({ ...options, port: Number(port) }); }, async restoreFrom(backup:string){
    const port=Number(new URL(app.origin).port);await app.close();renameSync(options.database,options.database+'.unavailable');
    restoreWorkspace(backup,options.database,{canonicalOnly:true});
    const restored=new DatabaseSync(options.database);
    try{
      const verifier=createAuth(restored,auth,clerk),actor=await verifier.authenticate(new Request(auth.origin+'/api/session',{headers:{Authorization:`Bearer ${jwt()}`}}));
      const gate=prepareRestoreBootstrap(restored);return issueRestoreSession(restored,verifier,actor,gate.bootstrap);
    }finally{restored.close();app=await startCanonicalApp({...options,port});}
  }, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Device state did not settle');
}

test('canonical listener rejects a second server on the same database and releases lock on close', async () => {
  const f=await fixture();let duplicate:Awaited<ReturnType<typeof startCanonicalApp>>|undefined;
  try {
    await assert.rejects(async()=>{duplicate=await f.startAgain();},(error:unknown)=>error instanceof ProtocolError&&error.code==='canonical_server_busy');
    const alias=join(f.dir,'alias.sqlite');symlinkSync(join(f.dir,'canonical.sqlite'),alias);
    await assert.rejects(async()=>{duplicate=await f.startAgain(alias);},(error:unknown)=>error instanceof ProtocolError&&error.code==='canonical_server_busy');
    assert.equal((await f.send('/api/session')).status,200);
    const failed=join(f.dir,'failed.sqlite');await assert.rejects(f.startAgain(failed,Number(new URL(f.origin()).port)),{code:'EADDRINUSE'});
    duplicate=await f.startAgain(failed);await duplicate.close();duplicate=undefined;
    await f.restart();assert.equal((await f.send('/api/session')).status,200);
  } finally { await duplicate?.close();await f.close(); }
});

test('cross-device reassign survives lost reply and restart, preserves old results and waits for fixed recipient home', async () => {
  const f = await fixture(), a = memoryKeys(), b = memoryKeys();
  const first = openDeviceRuntime({ database: join(f.dir,'a.sqlite'), server: f.origin(), development: true, entry: a.entry });
  const second = openDeviceRuntime({ database: join(f.dir,'b.sqlite'), server: f.origin(), development: true, entry: b.entry });
  const originalFetch = globalThis.fetch;
  let effects = 0;
  try {
    await first.enroll(f.jwt()); await second.enroll(f.jwt());
    const connection = first.connect(); await until(() => connection.state().phase === 'connected');
    const homes = (await f.send('/api/devices')).body.data, project = randomUUID(), source = randomUUID(), recipient = randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Transfer'})).status,201);
    for (const [agentId,homeId] of [[source,first.deviceId()],[recipient,second.deviceId()]]) {
      assert.equal((await f.send('/api/agents',{requestId:agentId,id:agentId,name:agentId,model:'fixture',backupModel:'',instructions:'Continue safely',threadLimit:2,projectId:project,homeDeviceId:homeId,expectedProjectRevision:1,expectedHomeDeviceRevision:homes.find((home:{id:string})=>home.id===homeId).revision,providerBinding:null})).status,201);
    }
    const taskId = randomUUID(), payload = {v:1,kind:'direct',message:{text:'Keep earlier evidence',files:[]}}, expectedRevisions = {project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    const command = {requestId:taskId,projectId:project,agentId:source,homeDeviceId:first.deviceId(),payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,source,first.deviceId(),payload,expectedRevisions])};
    const accepted = await f.send('/api/tasks',command); assert.equal(accepted.status,202);
    const owned = await first.startTask(taskId), context = await first.taskContext(taskId,owned.ownership,owned.revision);
    await first.executeAction({taskId,actionId:randomUUID(),sequence:0,actionKind:'read',ownership:owned.ownership,payload:{operation:'original'},context,grantRevision:1},()=>{effects++;return{text:'Saved source output'};});
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
    const paused = await f.send(`/api/tasks/${taskId}/control`,{requestId:randomUUID(),expectedRevision:detail.revision,operation:'pause'}); assert.equal(paused.status,200);
    const reassign = {requestId:randomUUID(),expectedRevision:paused.body.data.revision,operation:'reassign',recipientAgentId:recipient};
    globalThis.fetch = async (url,init) => { const response = await originalFetch(url,init); if(String(url).endsWith(`/api/tasks/${taskId}/control`)){await response.body?.cancel();throw new Error('Lost transfer ACK');} return response; };
    await assert.rejects(f.send(`/api/tasks/${taskId}/control`,reassign),/Lost transfer ACK/); globalThis.fetch = originalFetch;
    await f.restart();
    const retry = await f.send(`/api/tasks/${taskId}/control`,reassign); assert.equal(retry.status,200,JSON.stringify(retry.body));
    const nextId = retry.body.data.taskId; assert.notEqual(nextId,taskId); assert.equal(retry.body.data.homeDeviceId,second.deviceId());
    const original = await f.send(`/api/tasks/${taskId}`), next = await f.send(`/api/tasks/${nextId}`);
    assert.equal(original.body.data.currentTaskId,nextId); assert.equal(original.body.data.state,'transferred');
    assert.deepEqual(original.body.receipt,accepted.body.receipt);
    assert.equal(next.body.data.state,'waiting_device'); assert.equal(next.body.data.agentId,recipient);
    assert.equal((await f.send(`/api/tasks/${taskId}/control`,{...reassign,requestId:randomUUID()})).body.error.code,'task_transferred');
    const nextConnection = second.connect(); await until(()=>nextConnection.state().phase==='connected');
    const nextOwner = await second.startTask(nextId), continued = await second.taskContext(nextId,nextOwner.ownership,nextOwner.revision);
    assert.equal((continued.snapshot.toolJournal as {result:{text:string}}[])[0].result.text,'Saved source output');
    await first.recoverPending(); assert.equal(effects,1);
    assert.equal((await f.send('/api/tasks',command)).body.data.taskId,taskId);
  } finally { globalThis.fetch=originalFetch; await first.close(); await second.close(); await f.close(); }
});

test('local possession gate enrolls only configured server and retains identity across reconnect/revoke', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  try {
    const link = await runtime.bootstrap(), token = readFileSync(link.tokenFile, 'utf8');
    assert.equal(statSync(link.tokenFile).mode & 0o777, 0o600);
    const local = async (headers = {}, path = '/local/link-proof', body: unknown = { requestId: randomUUID(), clerkToken: f.jwt() }) => {
      const response = await fetch(link.origin + path, { method: 'POST', headers: { Origin: link.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() };
    };
    assert.equal((await local({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await local({ Authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await local({ 'X-Forwarded-Host': 'evil.example' })).status, 403);
    assert.equal((await local({}, '/local/sign-arbitrary')).status, 403);
    const linked = await local(); assert.equal(linked.status, 200, JSON.stringify(linked.body));
    await link.close(); assert(!existsSync(link.tokenFile));
    const deviceId = runtime.deviceId(), connection = runtime.connect();
    await until(() => connection.state().phase === 'connected');
    const devices = (await f.send('/api/devices')).body.data; assert.equal(devices.length, 1); assert.equal(devices[0].id, deviceId); assert.equal(devices[0].status, 'ready');
    assert.equal((await f.send('/api/devices', undefined, 'user_foreign')).body.data.length, 0);
    const project = randomUUID(), createProject = { requestId: randomUUID(), id: project, name: 'A' };
    assert.equal((await f.send('/api/projects', createProject)).status, 201);
    const id = randomUUID(), createAgent = { requestId: id, id, name: 'Remote', model: 'fixture', backupModel: '', instructions: 'Help with research', threadLimit: 2, projectId: project, homeDeviceId: deviceId, expectedProjectRevision: 1, expectedHomeDeviceRevision: devices[0].revision, providerBinding: null, setup: false };
    assert.equal((await f.send('/api/agents', createAgent)).status, 201);
    assert.equal((await f.send('/api/agents', createAgent)).status, 200);
    const avatar = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const avatarId = randomUUID(), avatarCommand = { ...createAgent, requestId: avatarId, id: avatarId, avatar: avatar.toString('base64') };
    assert(Buffer.byteLength(JSON.stringify(avatarCommand)) > 65536);
    assert.equal((await f.send('/api/agents', avatarCommand)).status, 201);
    assert.equal((await f.send('/api/agents', { ...avatarCommand, avatar: 'a'.repeat(750000) })).status, 413);

    assert.equal((await f.send(`/api/projects/${project}/agents/${id}/rules`, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'A only' }, 'user_owner', 'PUT')).status, 200);
    assert.equal((await f.send(`/api/projects/${project}/agents/${id}/capabilities`, { requestId: randomUUID(), expectedRevision: 2, capabilities: { v: 1, tools: [], resources: [] } }, 'user_owner', 'PUT')).status, 200);
    await connection.stop(); await runtime.close();
    await f.restart(); runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    assert.equal(runtime.deviceId(), deviceId);
    const resumed = runtime.connect(); await until(() => resumed.state().phase === 'connected');
    const current = (await f.send('/api/devices')).body.data[0];
    assert.equal((await f.send(`/api/devices/${deviceId}/revoke`, { requestId: randomUUID(), expectedRevision: current.revision })).status, 200);
    await until(() => resumed.state().phase === 'blocked'); assert.equal(resumed.state().lastFailure?._tag, 'ConnectionBlockedError');
    const canonical = new DatabaseSync(join(f.dir, 'canonical.sqlite')), device = new DatabaseSync(database);
    try {
      assert.equal(device.prepare("SELECT name FROM sqlite_schema WHERE name='accounts'").get(), undefined);
      assert.equal(canonical.prepare("SELECT name FROM sqlite_schema WHERE name='device_state'").get(), undefined);
      assert.equal(canonical.prepare('SELECT count(*) AS n FROM device_sessions WHERE revoked=0').get()!.n, 0);
      const publicMetadata = readFileSync(`${database}.host/identity.json`, 'utf8');
      for (const secret of store.values.values()) assert(!publicMetadata.includes(secret));
    } finally { canonical.close(); device.close(); }
  } finally { await runtime.close(); await f.close(); }
});

test('device key loss fails closed and concurrent stream replacement fences old heartbeat', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  try {
    await runtime.enroll(f.jwt());
    await runtime.close();
    assert.throws(() => openDeviceRuntime({ database, server: f.origin(), development: true, entry: () => ({ getPassword() { return null; }, setPassword() { assert.fail('Must not replace missing identity key'); } }) }), error => error instanceof ProtocolError && error.code === 'device_key_unavailable');
    runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    const first = runtime.connect(); await until(() => first.state().phase === 'connected');
    const secondRuntime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    try {
      const second = secondRuntime.connect(); await until(() => second.state().phase === 'connected');
      await until(() => first.state().phase !== 'connected'); await first.stop();
      const current = (await f.send('/api/devices')).body.data[0]; assert.equal(current.status, 'ready'); assert(current.connection_generation >= 2);
      await second.stop();
    } finally { await secondRuntime.close(); }
  } finally { await runtime.close(); await f.close(); }
});

test('lost enrollment ACK resumes same request and explicit reenroll/rotation preserve home identity', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  const originalFetch = globalThis.fetch; let drop = true;
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (drop && String(input) === f.origin() + '/api/devices/link') { drop = false; await response.body?.cancel(); throw new Error('Synthetic lost enrollment ACK'); }
      return response;
    };
    await assert.rejects(runtime.enroll(f.jwt()), /lost enrollment ACK/);
    const pending = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8')).pending;
    const linked = await runtime.enroll(f.jwt()); assert.equal(linked.generation, 1);
    const canonical = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      assert.equal(canonical.prepare('SELECT count(*) AS n FROM devices').get()!.n, 1);
      assert.equal(canonical.prepare("SELECT count(*) AS n FROM receipts WHERE scope='device_enrollment'").get()!.n, 1);
      assert.equal(canonical.prepare('SELECT request_id FROM receipts WHERE request_id=?').get(pending.request.requestId)!.request_id, pending.request.requestId);
    } finally { canonical.close(); }
    const home = runtime.deviceId();
    const reenrolled = await runtime.enroll(f.jwt(), 'reenroll'); assert.equal(reenrolled.deviceId, home); assert.equal(reenrolled.generation, 2);
    const before = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8'));
    const rotated = await runtime.enroll(f.jwt(), 'rotate'); assert.equal(rotated.deviceId, home); assert.equal(rotated.generation, 3);
    const after = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8')); assert.notEqual(after.signingRef, before.signingRef); assert.equal(after.descriptor.keyRevision, 2);
    assert([...store.values.keys()].some(key => key.endsWith('/' + before.signingRef)));
    await runtime.close(); runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('canonical task HTTP survives lost acceptance response/restart without dispatch and hides private task', async () => {
  const f = await fixture(), store = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'device.sqlite'), server: f.origin(), development: true, entry: store.entry });
  try {
    await runtime.enroll(f.jwt());
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Task project' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Agent', model: 'fixture', backupModel: '', instructions: 'Research', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const input = { requestId: randomUUID(), projectId: project, agentId: agent, homeDeviceId: home.id, payload: { v: 1, kind: 'direct', message: { text: 'Persistent task', files: [] } }, expectedRevisions: { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 } };
    const command = { ...input, payloadDigest: digestCommand(['briefsip-task-payload-v1', input.requestId, project, agent, home.id, input.payload, input.expectedRevisions]) };
    assert.equal((await f.send('/api/tasks', command)).status, 202);
    await f.restart();
    const detail = await f.send(`/api/tasks/${command.requestId}`); assert.equal(detail.status, 200); assert.equal(detail.body.data.state, 'waiting_device');
    assert.equal((await f.send('/api/tasks', command)).status, 200);
    assert.equal((await f.send(`/api/tasks/${command.requestId}`, undefined, 'user_foreign')).status, 404);
    const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try { assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n, 1); assert.equal(db.prepare('SELECT count(*) n FROM task_actions').get()!.n, 0); }
    finally { db.close(); }
  } finally { await runtime.close(); await f.close(); }
});

test('signed host HTTP admission commits once and result ACK survives canonical restart', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  const runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  const originalFetch = globalThis.fetch;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Recovery' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Agent', model: 'fixture', backupModel: '', instructions: 'Research', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const input = { requestId: randomUUID(), projectId: project, agentId: agent, homeDeviceId: home.id, payload: { v: 1, kind: 'direct', message: { text: 'Persistent result', files: [] } }, expectedRevisions: { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 } };
    const command = { ...input, payloadDigest: digestCommand(['briefsip-task-payload-v1', input.requestId, project, agent, home.id, input.payload, input.expectedRevisions]) };
    assert.equal((await f.send('/api/tasks', command)).status, 202);
    const taskId = input.requestId, acquireId = randomUUID(), lockProof = { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') };
    let dropAcquire = true;
    globalThis.fetch = async (url, init) => { const response = await originalFetch(url, init); if (dropAcquire && String(url).endsWith('/acquire')) { dropAcquire = false; await response.body?.cancel(); throw new Error('Synthetic lost acquire ACK'); } return response; };
    await assert.rejects(runtime.acquireTask(taskId, lockProof, 0, acquireId), /lost acquire ACK/);
    const acquired = await runtime.acquireTask(taskId, lockProof, 0, acquireId) as { ownership: unknown; revision: number };
    await assert.rejects(runtime.acquireTask(taskId, lockProof, 0, randomUUID()), error => error instanceof ProtocolError && error.code === 'ownership_conflict');
    globalThis.fetch = originalFetch;
    const ownership = parseOwnership(acquired.ownership), context = await runtime.taskContext(taskId, ownership, acquired.revision) as { snapshotRef: { snapshotId: string; digest: string }; snapshot: unknown };
    assert.equal(context.snapshotRef.digest, sha256(canonicalJson(context.snapshot)));
    const actionId = randomUUID(), payloadDigest = sha256('synthetic read');
    const intentDigest = digestCommand([taskId,actionId,0,ownership,payloadDigest,'read',context.snapshotRef.snapshotId,context.snapshotRef.digest,null,null,1,null,null,null]);
    await runtime.prepareTask(taskId, actionId, { requestId: randomUUID(), sequence: 0, ownership, intentDigest, payloadDigest, actionKind: 'read', contextSnapshotId: context.snapshotRef.snapshotId, contextDigest: context.snapshotRef.digest, grantRevision: 1, expectedTaskRevision: acquired.revision, journalSequence: 1 });
    const commit = { requestId: randomUUID(), ownership, intentDigest, expectedTaskRevision: acquired.revision, journalSequence: 1 };
    assert.equal((await runtime.commitTask(taskId, actionId, commit) as { dispatchable: boolean }).dispatchable, true);
    assert.equal((await runtime.commitTask(taskId, actionId, commit) as { dispatchable: boolean }).dispatchable, false);
    const resultContent = { text: 'Saved over signed HTTP' }, resultDigest = sha256(canonicalJson(resultContent));
    const report = { requestId: randomUUID(), actionId, ownership, payloadDigest, state: 'acknowledged', effectStatus: 'known', journalSequence: 2, resultContent, resultDigest, resultRef: { v: 1, taskId, actionId, digest: resultDigest, size: Buffer.byteLength(canonicalJson(resultContent)), encoding: 'canonical-json-v1' } };
    const published = await runtime.reconcileTask(taskId, report);
    const previousConnectionGeneration = connection.state().generation;
    await f.restart(); await until(() => connection.state().phase === 'connected' && connection.state().generation > previousConnectionGeneration);
    assert.deepEqual(await runtime.reconcileTask(taskId, report), published);
    assert.deepEqual((await f.send(`/api/tasks/${taskId}`)).body.data.results[0].content, resultContent);
    const db = new DatabaseSync(database), canonical = new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try {
      const refs = String(db.prepare('SELECT executor_refs_json FROM device_state WHERE id=1').get()!.executor_refs_json), receipts = JSON.stringify(canonical.prepare('SELECT result_json FROM receipts').all());
      for (const [name, token] of store.values) if (name.includes('/executor/')) { assert(!refs.includes(token)); assert(!receipts.includes(token)); }
      assert.equal(canonical.prepare('SELECT count(*) n FROM task_results').get()!.n, 1);
    } finally { db.close(); canonical.close(); }
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('journal-backed host dispatches once, retries publication only and refuses lost or late commit grants', { timeout: 20000 }, async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  const runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Executor' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Agent', model: 'fixture', backupModel: '', instructions: 'Research', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    async function action(loseAcquire=false) {
      const taskId = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Run once', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
      assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions]) })).status, 202);
      if(loseAcquire) {
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/acquire')){await response.body?.cancel();throw new Error('Lost acquire ACK');}return response;};
        await assert.rejects(runtime.startTask(taskId),/Lost acquire ACK/);globalThis.fetch=originalFetch;
      }
      const acquired = await runtime.startTask(taskId);
      const context = await runtime.taskContext(taskId, acquired.ownership, acquired.revision);
      return { taskId, actionId: randomUUID(), sequence: 0, actionKind: 'read' as const, ownership: acquired.ownership, payload: { operation: 'synthetic' }, context, grantRevision: 1 };
    }
    const first = await action(true);
    let dropReport = true;
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (dropReport && String(url).endsWith('/reconcile')) { dropReport = false; await response.body?.cancel(); throw new Error('Lost result ACK'); }
      return response;
    };
    const effect = async () => { calls++; return { text: 'Durable result' }; };
    await assert.rejects(runtime.executeAction(first, effect), /Lost result ACK/);
    assert.equal(calls, 1);
    globalThis.fetch = originalFetch;
    assert.equal((await runtime.executeAction(first, effect)).state, 'acknowledged');
    assert.equal((await runtime.executeAction(first, effect)).state, 'acknowledged');
    assert.equal(calls, 1);
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare('SELECT state FROM device_outbox WHERE action_id=?').get(first.actionId)!.state, 'acknowledged');
      assert.equal(db.prepare('SELECT send_marker FROM device_journal WHERE action_id=?').get(first.actionId)!.send_marker, 1);
    } finally { db.close(); }
    for (const mode of ['lost', 'late'] as const) {
      const input = await action();
      globalThis.fetch = async (url, init) => {
        const response = await originalFetch(url, init);
        if (String(url).endsWith('/commit')) {
          if (mode === 'lost') { await response.body?.cancel(); throw new Error('Lost commit ACK'); }
          await new Promise(resolve => setTimeout(resolve, 2100));
        }
        return response;
      };
      await assert.rejects(runtime.executeAction(input, effect));
      globalThis.fetch = originalFetch;
      await assert.rejects(runtime.executeAction(input, effect), error => error instanceof ProtocolError && error.code === 'recovery_required');
      assert.equal(calls, 1);
    }
    const failed=await action();
    await assert.rejects(runtime.executeAction(failed,()=>{calls++;throw new Error('Provider response unavailable');}),/Provider response unavailable/);
    assert.equal((await runtime.recoverAction(failed.taskId,failed.actionId)).state,'uncertain');
    const detail=(await f.send(`/api/tasks/${failed.taskId}`)).body.data,decisionId=randomUUID();
    assert.equal((await f.send(`/api/tasks/${failed.taskId}/control`,{requestId:decisionId,expectedRevision:detail.revision,operation:'resolve_uncertain',decision:{kind:'retry_with_risk',actionId:failed.actionId,acknowledgement:'effect_may_have_happened',reason:'Synthetic test with explicit owner decision'}})).status,200);
    const resolved=(await f.send(`/api/tasks/${failed.taskId}`)).body.data;
    const context=await runtime.taskContext(failed.taskId,failed.ownership,resolved.revision);
    assert.equal((await runtime.executeAction({...failed,actionId:decisionId,sequence:1,resolutionRequestId:decisionId,context},effect)).state,'acknowledged');
    assert.equal(calls,3);
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('SIGKILL recovery proves no send before marker and never repeats marked effects or lost result ACKs', { timeout: 30000 }, async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir,'device.sqlite'), keys = join(f.dir,'synthetic-keys.json');
  const runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  const calls = new Map<string,number>();
  const effect = createServer(async (req,res) => {
    let body=''; for await(const chunk of req)body+=chunk;
    const {actionId}=JSON.parse(body); calls.set(actionId,(calls.get(actionId)??0)+1);
    res.end(JSON.stringify({text:'Saved effect'}));
  });
  await new Promise<void>(resolve=>effect.listen(0,'127.0.0.1',resolve));
  const address=effect.address();assert(address&&typeof address!=='string');
  const effectOrigin=`http://127.0.0.1:${address.port}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await runtime.enroll(f.jwt());await runtime.close();
    writeFileSync(keys,JSON.stringify(Object.fromEntries(store.values)),{mode:0o600});
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Crash recovery'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Agent',model:'fixture',backupModel:'',instructions:'Research',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    async function start(config:Record<string,unknown>) {
      child=spawn(process.execPath,['--experimental-strip-types','recovery-fixture.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,BRIEFSIP_RECOVERY_FIXTURE:JSON.stringify({database,keys,server:f.origin(),effect:effectOrigin, ...config})},stdio:['ignore','ignore','pipe','ipc']});
      let errors='';child.stderr!.on('data',chunk=>{errors+=chunk;});
      const exited=once(child,'exit');
      const message=await Promise.race([once(child,'message').then(([message])=>message),exited.then(()=>{throw new Error(`Recovery fixture exited: ${errors}`);})]);
      return {child,exited,message};
    }
    for(const checkpoint of ['after-intent','after-prepare','after-commit','after-marker','after-result','after-report']) {
      const taskId=randomUUID(),actionId=randomUUID(),payload={v:1,kind:'direct',message:{text:checkpoint,files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
      const running=await start({checkpoint,taskId,actionId});
      assert.equal(running.message.checkpoint,checkpoint);
      running.child.kill('SIGKILL');assert.equal((await running.exited)[1],'SIGKILL');
      const beforeMarker=['after-intent','after-prepare','after-commit'].includes(checkpoint);
      const expected=checkpoint==='after-marker'?'uncertain':beforeMarker?'not_sent':'acknowledged';
      const continuationId=beforeMarker?randomUUID():undefined;
      for(let restart=0;restart<2;restart++) {
        await f.restart();
        const recovered=await start({mode:'recover',taskId,actionId,...(restart===0&&continuationId?{continuationId}:{})});
        assert.equal(recovered.message.state,expected);
        assert.equal((await recovered.exited)[0],0);
        assert.equal(calls.get(actionId)??0,beforeMarker?0:1);
        if(continuationId)assert.equal(calls.get(continuationId),1);
      }
      const detail=(await f.send(`/api/tasks/${taskId}`)).body.data;
      if(expected==='acknowledged')assert.deepEqual(detail.results[0].content,{text:'Saved effect'});
      else assert.equal(detail.state,beforeMarker?'running':'uncertain');
    }
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    await runtime.close();effect.closeAllConnections();await new Promise<void>(resolve=>effect.close(()=>resolve()));await f.close();
  }
});


test('stalled normal requests cannot starve control reads and disconnected requests release capacity', async () => {
  const f=await fixture(), held: ReturnType<typeof httpRequest>[]=[];
  try {
    for(let i=0;i<64;i++) {
      const request=httpRequest(f.origin()+'/api/projects',{method:'POST',headers:{Authorization:`Bearer ${f.jwt()}`,Origin:f.origin(),'Content-Type':'application/json','Content-Length':'8','X-Briefsip-Protocol':'1','X-Briefsip-Request-Id':randomUUID()}});
      request.on('error',()=>{});request.write('{');held.push(request);
    }
    await until(async()=> (await f.send('/api/projects')).status===429);
    const control=await f.send('/api/session');assert.equal(control.status,200,JSON.stringify(control.body));
    for (const path of [`/api/tasks/${randomUUID()}`, `/api/tasks/${randomUUID()}/results/${randomUUID()}`]) {
      const receipt = await f.send(path); assert.equal(receipt.status,404,JSON.stringify(receipt.body));
    }
    const logout = await f.send('/api/session/logout',{requestId:randomUUID()},'user_logout');
    assert([200,202,503].includes(logout.status),JSON.stringify(logout));
    const taskControl=await f.send(`/api/tasks/${randomUUID()}/control`,{requestId:randomUUID(),expectedRevision:1,operation:'cancel'});
    assert.equal(taskControl.status,404,JSON.stringify(taskControl.body));
    for(const request of held)request.destroy();
    await until(async()=> (await f.send('/api/projects')).status===200);
  } finally { for(const request of held)request.destroy();await f.close(); }
});

test('canonical transfer survives lost RPC reply and canonical restart without duplicate successor or caller effects', async () => {
  const f=await fixture(), keys=memoryKeys(), targetKeys=memoryKeys();
  const home=openDeviceRuntime({database:join(f.dir,'source.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const target=openDeviceRuntime({database:join(f.dir,'target.sqlite'),server:f.origin(),development:true,entry:targetKeys.entry});
  const originalFetch=globalThis.fetch;let effects=0;
  try {
    await home.enroll(f.jwt());await target.enroll(f.jwt());const connection=home.connect();await until(()=>connection.state().phase==='connected');
    const devices=(await f.send('/api/devices')).body.data,project=randomUUID(),source=randomUUID(),recipient=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Canonical transfer'})).status,201);
    for(const [agentId,deviceId] of [[source,home.deviceId()],[recipient,target.deviceId()]])assert.equal((await f.send('/api/agents',{requestId:agentId,id:agentId,name:agentId,model:'fixture',backupModel:'',instructions:'Continue',threadLimit:2,projectId:project,homeDeviceId:deviceId,expectedProjectRevision:1,expectedHomeDeviceRevision:devices.find((d:{id:string})=>d.id===deviceId).revision,providerBinding:null})).status,201);
    const channel=randomUUID(),seed=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try {
      const ownerId=String(seed.prepare('SELECT account FROM projects WHERE id=?').get(project)!.account);
      seed.prepare('INSERT INTO channels(id,name,instructions,lead) VALUES (?,?,?,?)').run(channel,'Handoff','Continue project work',source);
      for(const agent of [source,recipient]) seed.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);
      seed.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),ownerId,project,channel);
    } finally {seed.close();}
    const taskId=randomUUID(),payload={v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Original request',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,channel:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:source,homeDeviceId:home.deviceId(),payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,source,home.deviceId(),payload,expectedRevisions])})).status,202);
    const owned=await home.startTask(taskId),context=await home.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    const transferSchema=(context.snapshot.tools as any[]).find((tool:any)=>tool.function.name==='transfer_task') as any;
    assert.deepEqual(transferSchema.function.parameters.properties.recipient.enum,[recipient]);
    const toolCall={id:'transfer',function:{name:'transfer_task',arguments:JSON.stringify({recipient,task:'Continue from saved evidence'})}};
    const action={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall,expectedRevision:owned.revision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith(`/api/tasks/${taskId}/context-mutations`)){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost canonical ACK');}return response;};
    await assert.rejects(home.executeAction(action,()=>{effects++;return{text:'Must not execute'};}),/Lost canonical ACK/);globalThis.fetch=originalFetch;
    const transferred=(await f.send(`/api/tasks/${taskId}`)).body.data,successor=transferred.currentTaskId;assert.equal(transferred.state,'transferred');assert.notEqual(successor,taskId);
    await f.restart();await until(()=>connection.state().phase==='connected');
    await until(()=>home.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    assert.equal(effects,0);assert.equal((await f.send(`/api/tasks/${taskId}`)).body.data.currentTaskId,successor);
    const next=(await f.send(`/api/tasks/${successor}`)).body.data;assert.equal(next.homeDeviceId,target.deviceId());assert.equal(next.state,'waiting_device');
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE logical_turn=?').get(taskId)!.n,2);assert.equal(db.prepare('SELECT count(*) n FROM task_results WHERE action=?').get(actionId)!.n,1);}finally{db.close();}
  } finally {globalThis.fetch=originalFetch;await home.close();await target.close();await f.close();}
});

test('owner recovers revoked-device journal through HTTP without device session or repeated effect',async()=>{
  const f=await fixture(),keys=memoryKeys(),database=join(f.dir,'recover-device.sqlite');
  let runtime=openDeviceRuntime({database,server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;let calls=0;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Recovery'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Agent',model:'fixture',backupModel:'',instructions:'Recover',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'One effect',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/reconcile'))throw new Error('Report offline');return originalFetch(url,init);};
    await assert.rejects(runtime.executeAction({taskId,actionId,sequence:0,actionKind:'read',ownership:owned.ownership,payload:{operation:'one effect'},context,grantRevision:1},()=>{calls++;return{text:'Original output'};}),/Report offline/);
    globalThis.fetch=originalFetch;
    const current=(await f.send('/api/devices')).body.data[0];assert.equal((await f.send(`/api/devices/${home.id}/revoke`,{requestId:randomUUID(),expectedRevision:current.revision})).status,200);
    await connection.stop();
    const start={requestId:randomUUID(),expectedAuthorityGeneration:owned.ownership.authorityGeneration,sourceDeviceId:home.id,sourceDeviceGeneration:owned.ownership.deviceGeneration};
    const session=await f.send(`/api/tasks/${taskId}/recovery-session`,start);assert.equal(session.status,201,JSON.stringify(session.body));
    assert.equal((await f.send(`/api/tasks/${taskId}/recovery-session`,start)).body.data.session,undefined);
    const generation=session.body.data.recoveryGeneration,proof=session.body.data.session;
    const send=async(operation:string,body:ReturnType<typeof runtime.exportRecovery>,origin=f.origin(),subject='user_owner')=>{
      const response=await fetch(f.origin()+`/api/tasks/${taskId}/recovery-${operation}`,{method:'POST',headers:{Authorization:`Bearer ${f.jwt(subject)}`,Origin:origin,'Content-Type':'application/json','X-Briefsip-Protocol':'1','X-Briefsip-Request-Id':body.requestId,'X-Briefsip-Recovery':proof,Connection:'close'},body:JSON.stringify(body)});
      return{status:response.status,body:await response.json()};
    };
    const metadata=runtime.exportRecovery(taskId,[actionId],randomUUID(),generation);
    assert.equal((await send('import',metadata,'https://evil.example')).status,403);
    assert.equal((await send('import',metadata,f.origin(),'user_other')).status,404);
    const imported=await send('import',metadata);assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.data.state,'result_missing');
    await f.restart();
    const result=runtime.exportRecovery(taskId,[actionId],randomUUID(),generation,true);
    assert.deepEqual(result.envelope.entries,metadata.envelope.entries);
    const published=await send('results',result);assert.equal(published.status,200,JSON.stringify(published.body));assert.equal((await send('results',result)).status,200);
    assert.deepEqual((await f.send(`/api/tasks/${taskId}`)).body.data.results[0].content,{text:'Original output'});
    assert.equal((await f.send('/api/devices')).body.data[0].status,'revoked');assert.equal(calls,1);
    const rotated=await runtime.enroll(f.jwt(),'rotate');assert(rotated.generation>owned.ownership.deviceGeneration);
    const historical=runtime.exportRecovery(taskId,[actionId],randomUUID(),generation,true);
    assert.deepEqual(historical.envelope.entries,metadata.envelope.entries);
    assert.equal((await send('results',historical)).status,200);
    const local=new DatabaseSync(database);let signingRef:string;
    try{signingRef=String(local.prepare('SELECT signing_ref FROM device_enrollment_keys WHERE device_generation=?').get(owned.ownership.deviceGeneration)!.signing_ref);}finally{local.close();}
    const keyName=[...keys.values.keys()].find(name=>name.endsWith('/'+signingRef))!,privateKey=keys.values.get(keyName)!;
    keys.values.delete(keyName);
    assert.throws(()=>runtime.exportRecovery(taskId,[actionId],randomUUID(),generation,true),error=>error instanceof ProtocolError&&error.code==='device_key_unavailable');
    keys.values.set(keyName,privateKey);

    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM task_results').get()!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,1);assert(!JSON.stringify(db.prepare('SELECT * FROM receipts').all()).includes(proof));}finally{db.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('disaster recovery imports original host result without original server and never enables dispatch',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;let calls=0,backup:Awaited<ReturnType<typeof workspaceSnapshot>>|undefined;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Disaster recovery'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Agent',model:'fixture',backupModel:'',instructions:'Recover',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Original action',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/reconcile'))throw new Error('Original server lost');return originalFetch(url,init);};
    await assert.rejects(runtime.executeAction({taskId,actionId,sequence:0,actionKind:'read',ownership:owned.ownership,payload:{operation:'one call'},context,grantRevision:1},()=>{calls++;return{text:'Saved on original host'};}),/Original server lost/);
    await connection.stop();globalThis.fetch=originalFetch;
    const source=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{backup=await workspaceSnapshot(source);}finally{source.close();}
    const proof=await f.restoreFrom(backup.file);
    assert.notEqual(proof.recoveryGeneration,owned.ownership.authorityGeneration);
    const send=async(kind:string,body:ReturnType<typeof runtime.exportRecovery>,session=proof.session,subject='user_owner')=>{
      const response=await fetch(f.origin()+`/api/tasks/${taskId}/recovery-${kind}`,{method:'POST',headers:{Authorization:`Bearer ${f.jwt(subject)}`,Origin:f.origin(),Connection:'close','Content-Type':'application/json','X-Briefsip-Protocol':'1','X-Briefsip-Request-Id':body.requestId,'X-Briefsip-Recovery':session},body:JSON.stringify(body)});
      return{status:response.status,body:await response.json()};
    };
    const metadata=runtime.exportRecovery(taskId,[actionId],randomUUID(),proof.recoveryGeneration);
    assert.equal((await send('import',metadata,Buffer.alloc(32).toString('base64url'))).status,403);
    assert.equal((await send('import',metadata,proof.session,'user_other')).status,403);
    const imported=await send('import',metadata);assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.data.state,'result_missing');
    await f.restart();const content=runtime.exportRecovery(taskId,[actionId],randomUUID(),proof.recoveryGeneration,true);
    const published=await send('results',content);assert.equal(published.status,200,JSON.stringify(published.body));assert.equal((await send('results',content)).status,200);
    await assert.rejects(runtime.startTask(taskId),error=>error instanceof ProtocolError&&error.code==='device_offline');
    assert.equal((await f.send(`/api/tasks/${taskId}`)).status,503);
    const restored=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{
      assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'read_only_recovery');
      assert.deepEqual(JSON.parse(String(restored.prepare('SELECT content_json FROM task_results WHERE action=?').get(actionId)!.content_json)),{text:'Saved on original host'});
      assert.equal(restored.prepare('SELECT count(*) n FROM task_results').get()!.n,1);
      assert.equal(restored.prepare('SELECT stopped FROM execution_owners').get()!.stopped,1);
      assert.equal(restored.prepare('SELECT status FROM devices').get()!.status,'revoked');
      restored.exec('UPDATE authority_state SET recovery_expires_at=0');
      assert.equal((await send('results',content)).status,403);
    }finally{restored.close();}
    assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;backup?.cleanup();await runtime.close();await f.close();}
});

test('disaster recovery quarantines signed post-backup actions and tasks without publishing or admitting them',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;let calls=0,backup:Awaited<ReturnType<typeof workspaceSnapshot>>|undefined;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Quarantine'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Agent',model:'fixture',backupModel:'',instructions:'Recover',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const admit=async()=>{
      const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Post-backup action',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
      return taskId;
    };
    const knownTask=await admit(),source=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{backup=await workspaceSnapshot(source);}finally{source.close();}
    const unknownTask=await admit(),actions=[];
    globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/reconcile'))throw new Error('Original server lost');return originalFetch(url,init);};
    for(const taskId of [knownTask,unknownTask]){
      const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();actions.push({taskId,actionId});
      await assert.rejects(runtime.executeAction({taskId,actionId,sequence:0,actionKind:'read',ownership:owned.ownership,payload:{operation:'one call'},context,grantRevision:1},()=>{calls++;return{text:'Keep result on original host'};}),/Original server lost/);
    }
    await connection.stop();globalThis.fetch=originalFetch;const proof=await f.restoreFrom(backup.file);
    const send=async(taskId:string,body:ReturnType<typeof runtime.exportRecovery>,session=proof.session,subject='user_owner')=>{
      const response=await fetch(f.origin()+`/api/tasks/${taskId}/recovery-import`,{method:'POST',headers:{Authorization:`Bearer ${f.jwt(subject)}`,Origin:f.origin(),Connection:'close','Content-Type':'application/json','X-Briefsip-Protocol':'1','X-Briefsip-Request-Id':body.requestId,'X-Briefsip-Recovery':session},body:JSON.stringify(body)});
      return{status:response.status,body:await response.json()};
    };
    for(const {taskId,actionId} of actions){
      const metadata=runtime.exportRecovery(taskId,[actionId],randomUUID(),proof.recoveryGeneration);
      assert.equal((await send(taskId,metadata,Buffer.alloc(32).toString('base64url'))).status,403);
      assert.equal((await send(taskId,metadata,proof.session,'user_other')).status,403);
      const altered=structuredClone(metadata);altered.signature=Buffer.alloc(64).toString('base64url');assert.equal((await send(taskId,altered)).status,403);
      const result=await send(taskId,metadata);assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual(result.body.data.quarantinedActionIds,[actionId]);assert.deepEqual(result.body.data.importedActionIds,[]);assert.equal(result.body.data.dispatchable,false);
      assert.equal((await send(taskId,metadata)).body.receipt.requestId,result.body.receipt.requestId);
    }
    await f.restart();
    const restored=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{
      assert.equal(restored.prepare('SELECT count(*) n FROM tasks').get()!.n,1);
      assert.equal(restored.prepare('SELECT count(*) n FROM task_actions').get()!.n,0);
      assert.equal(restored.prepare('SELECT count(*) n FROM task_results').get()!.n,0);
      assert.equal(restored.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,2);
      const privateReceipt=restored.prepare('SELECT project,result_json FROM receipts WHERE scope=?').get(`tasks:recovery-import:${unknownTask}`)!;
      assert.equal(privateReceipt.project,null);assert.equal(JSON.parse(String(privateReceipt.result_json)).receipt.projectId,undefined);
      assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'read_only_recovery');
    }finally{restored.close();}
    assert.equal(calls,2);assert.equal((await f.send(`/api/tasks/${unknownTask}`)).status,404);
  }finally{globalThis.fetch=originalFetch;backup?.cleanup();await runtime.close();await f.close();}
});

test('canonical memory RPC isolates projects and retains committed memory after a lost reply',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),other=randomUUID(),agent=randomUUID();
    for(const id of [project,other])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:id})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Agent',model:'fixture',backupModel:'',instructions:'Remember',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    assert.equal((await f.send(`/api/projects/${other}/agents/${agent}`,{requestId:randomUUID(),expectedProjectRevision:1,expectedAgentRevision:1,expectedAuthorityRevision:1,expectedParticipationRevision:0,rules:'',capabilities:{v:1,tools:['remember_memory','search_memory','select_memory'],resources:[]}},'user_owner','PUT')).status,201);
    const start=async(projectId:string)=>{
      const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Remember here',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,projectId,agent,home.id,payload,expectedRevisions])})).status,202);
      return {...await runtime.startTask(taskId),sequence:0};
    };
    const first=await start(project);
    const run=async(task:typeof first,name:string,args:unknown,lose=false)=>{
      const detail=(await f.send(`/api/tasks/${task.taskId}`)).body.data,context=await runtime.taskContext(task.taskId,task.ownership,detail.revision),actionId=randomUUID();
      const input={taskId:task.taskId,actionId,sequence:task.sequence++,actionKind:'canonical' as const,ownership:task.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
      if(lose){
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost memory result');}return response;};
        await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost memory result/);globalThis.fetch=originalFetch;
        await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
      }else await runtime.executeAction(input,()=>assert.fail('Host effect'));
      return (await f.send(`/api/tasks/${task.taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===actionId).content;
    };
    const saved=await run(first,'remember_memory',{text:'Project A private memory'},true);assert.equal(saved.revision,1);
    assert.equal((await run(first,'select_memory',{items:[{id:saved.id,revision:1,essential:true}]})).items[0].revision,2);
    assert.equal((await run(first,'search_memory',{})).items[0].text,'Project A private memory');
    assert.equal((await run(first,'remember_memory',{text:'x'.repeat(2001)})).status,400);
    assert.equal((await run(first,'search_memory',{})).items.length,1);
    const second=await start(other);assert.deepEqual((await run(second,'search_memory',{})).items,[]);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{
      assert.equal(db.prepare('SELECT count(*) n FROM memories').get()!.n,1);assert.equal(db.prepare("SELECT project FROM record_scopes WHERE table_name='memories'").get()!.project,project);
      const scope=db.prepare('SELECT scope FROM memories').get()!.scope;
      db.prepare('INSERT INTO memories(scope,id,text,essential,revision,removed,selection_locked) VALUES (?,?,?,0,1,0,1)').run(scope,randomUUID(),'Unmapped legacy private content');
    }finally{db.close();}
    await assert.rejects(run(first,'search_memory',{}),error=>error instanceof ProtocolError&&error.code==='record_scope_missing');
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical history RPC pages scoped originals and retains exact reads after a lost reply',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),other=randomUUID(),agent=randomUUID(),thread=randomUUID(),channel=randomUUID();
    for(const id of [project,other])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:id})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Reader',model:'fixture',backupModel:'',instructions:'Read originals',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    await f.send('/api/session',undefined,'user_foreign');
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    const ownerId=String(db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_owner'").get()!.id),foreignId=String(db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_foreign'").get()!.id);
    const seed=(text:string,rootKind='agent',root=agent,visibility='owner',account=ownerId,projectId=project,mapped=true)=>{
      const id=randomUUID(),row=db.prepare("INSERT INTO turns(id,agent,text,reply,status,created) VALUES (?,?,?,?,'done','fixture')").run(id,agent,text,'Saved reply');
      if(mapped)db.prepare("INSERT INTO record_scopes VALUES ('turns',?,?,?,?,?,?)").run(JSON.stringify([id]),account,projectId,visibility,rootKind,root);
      return {id,seq:Number(row.lastInsertRowid)};
    };
    db.prepare('INSERT INTO threads(id,agent,name) VALUES (?,?,?)').run(thread,agent,'Side');
    db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),ownerId,project,thread);
    db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','Read',?)").run(channel,agent);
    db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);
    db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),ownerId,project,channel);
    const oldest=seed('x'.repeat(9000)+'ORIGINAL_END');
    const direct=Array.from({length:6},(_,i)=>seed(`Direct ${i}`));
    const side=seed('SIDE_ONLY','thread',thread),shared=seed('CHANNEL_SHARED','channel',channel,'project',foreignId);
    const hidden=[seed('PRIVATE_HUMAN','agent',agent,'owner',foreignId),seed('FOREIGN_PROJECT','agent',agent,'owner',ownerId,other),seed('UNMAPPED','agent',agent,'owner',ownerId,project,false)];
    db.close();
    const start=async(kind:'direct'|'side'|'channel')=>{
      const taskId=randomUUID(),payload={v:1,kind,...(kind==='side'?{threadId:thread}:kind==='channel'?{channelId:channel,routing:'assigned'}:{}),message:{text:'Read history',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='side'?{thread:1}:kind==='channel'?{channel:1}:{})};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
      return {...await runtime.startTask(taskId),sequence:0};
    };
    const first=await start('direct');
    const futureDb=new DatabaseSync(join(f.dir,'canonical.sqlite'));const future=randomUUID();
    futureDb.prepare("INSERT INTO turns(id,agent,text,reply,status,created) VALUES (?,?,'FUTURE','Future reply','done','fixture')").run(future,agent);
    futureDb.prepare("INSERT INTO record_scopes VALUES ('turns',?,?,?,'owner','agent',?)").run(JSON.stringify([future]),ownerId,project,agent);futureDb.close();
    const run=async(task:typeof first,name:string,args:unknown,lose=false)=>{
      const detail=(await f.send(`/api/tasks/${task.taskId}`)).body.data,context=await runtime.taskContext(task.taskId,task.ownership,detail.revision),actionId=randomUUID();
      const input={taskId:task.taskId,actionId,sequence:task.sequence++,actionKind:'canonical' as const,ownership:task.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
      if(lose){
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost history result');}return response;};
        await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost history result/);globalThis.fetch=originalFetch;
        const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));changed.prepare('UPDATE turns SET text=?,revision=revision+1 WHERE id=?').run('Changed after read',oldest.id);changed.close();
        await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
      }else await runtime.executeAction(input,()=>assert.fail('Host effect'));
      return (await f.send(`/api/tasks/${task.taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===actionId).content;
    };
    const page=await run(first,'read_history',{});assert.deepEqual(page.messages.map((row:{id:string})=>row.id),direct.slice(1).reverse().map(row=>row.id));assert.equal(page.next_before,direct[1].seq);
    const next=await run(first,'read_history',{before:page.next_before});assert.deepEqual(next.messages.map((row:{id:string})=>row.id),[direct[0].id,oldest.id]);assert.equal(next.next_before,null);assert.equal(next.messages[1].truncated,true);
    const original=await run(first,'read_message',{id:oldest.id},true);assert.equal(original.text,'x'.repeat(8000));assert.equal(original.next_offset,8000);assert.deepEqual(original.attachments,[]);assert.deepEqual(original.generatedFiles,[]);assert.deepEqual(original.questions,[]);
    const restored=new DatabaseSync(join(f.dir,'canonical.sqlite'));restored.prepare('UPDATE turns SET text=?,revision=revision+1 WHERE id=?').run('x'.repeat(9000)+'ORIGINAL_END',oldest.id);restored.close();
    const tail=await run(first,'read_message',{id:oldest.id,offset:8000});assert.equal(tail.text,'x'.repeat(1000)+'ORIGINAL_END');assert.equal(tail.next_offset,null);
    assert.match((await run(first,'read_message',{id:hidden[0].id})).error,/not found/);
    assert.equal((await run(first,'read_history',{before:0})).status,400);assert.equal((await run(first,'read_message',{id:oldest.id,offset:-1})).status,400);
    for(const [kind,id] of [['side',side.id],['channel',shared.id]] as const){const task=await start(kind),result=await run(task,'read_history',{});assert.deepEqual(result.messages.map((row:{id:string})=>row.id),[id]);}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical skill reads recover exact pinned text after lost response, disable and server restart', async () => {
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry});
  const originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID(),skill=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Skill reads'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Reader',model:'fixture',backupModel:'',instructions:'Read installed skills',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite')),owner=String(db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_owner'").get()!.id);
    try{
      saveSkill(db,skill,{revision:0,files:[{path:'SKILL.md',content:'---\nname: pinned-reader\ndescription: Read immutable support files\n---\nPINNED_CONTENT'},{path:'notes.txt',content:'x'.repeat(8000)+'ORIGINAL_TAIL'},{path:'asset.bin',content:Buffer.from('BINARY_PRIVATE').toString('base64'),encoding:'base64'}]});
      saveSkill(db,skill,{revision:1,files:[{path:'SKILL.md',content:'---\nname: latest-reader\ndescription: Uninstalled version\n---\nLATEST_PRIVATE'}]});
      db.prepare('INSERT INTO agent_skills(agent,skill,version,enabled,revision,removed) VALUES (?,?,1,1,1,0)').run(agent,skill);
      for(const [table,key] of [['skills',[skill]],['skill_versions',[skill,1]],['agent_skills',[agent,skill]],['skill_files',[skill,1]]] as const)db.prepare("INSERT INTO record_scopes VALUES (?,?,?,?,'owner','agent',?)").run(table,JSON.stringify(key),owner,project,agent);
    }finally{db.close();}
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Inspect pinned skill',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId);let sequence=0;
    const run=async(name:string,args:unknown,lose=false)=>{
      const detail=(await f.send(`/api/tasks/${taskId}`)).body.data,context=await runtime.taskContext(taskId,owned.ownership,detail.revision),actionId=randomUUID();
      const input={taskId,actionId,sequence:sequence++,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
      if(lose){
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost skill result');}return response;};
        await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost skill result/);globalThis.fetch=originalFetch;
        const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));changed.prepare('UPDATE agent_skills SET enabled=0,revision=revision+1 WHERE agent=? AND skill=?').run(agent,skill);changed.close();
        await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
      }else await runtime.executeAction(input,()=>assert.fail('Host effect'));
      return (await f.send(`/api/tasks/${taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===actionId).content;
    };
    assert.deepEqual((await run('list_skills',{})).items,[{id:skill,version:1,name:'pinned-reader',description:'Read immutable support files'}]);
    const read=await run('read_skill',{id:skill});assert.equal(read.content,'PINNED_CONTENT');assert.equal(read.version,1);assert(!JSON.stringify(read).includes('LATEST_PRIVATE'));assert(!JSON.stringify(read).includes('BINARY_PRIVATE'));
    const file=await run('read_skill_file',{id:skill,path:'notes.txt',offset:8000},true);assert.equal(file.content,'ORIGINAL_TAIL');assert.equal(file.next_offset,null);
    assert.match((await run('read_skill',{id:skill})).error,/not found/);
    assert.equal((await f.send(`/api/tasks/${taskId}`)).body.data.results.length,4);
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical agent directory isolates projects and recovers exact roster after lost reply', async () => {
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),other=randomUUID(),agent=randomUUID(),peer=randomUUID(),foreign=randomUUID();
    for(const id of [project,other])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:'Directory'})).status,201);
    for(const [id,projectId] of [[agent,project],[peer,project],[foreign,other]])assert.equal((await f.send('/api/agents',{requestId:id,id,name:id===peer?'Original teammate':'Agent',model:'fixture',backupModel:'',instructions:'Project teammate',threadLimit:2,projectId,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'List teammates',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId);let context=await runtime.taskContext(taskId,owned.ownership,owned.revision);const actionId=randomUUID(),cursorAction=randomUUID();
    assert((context.snapshot.tools as {function:{name:string}}[]).some(tool=>tool.function.name==='list_agents'));
    await runtime.executeAction({taskId,actionId:cursorAction,sequence:0,actionKind:'canonical',ownership:owned.ownership,payload:{toolCall:{id:cursorAction,function:{name:'list_agents',arguments:JSON.stringify({after:peer.toUpperCase()})}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1},()=>assert.fail('Host effect'));
    assert.deepEqual((await f.send(`/api/tasks/${taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===cursorAction).content,{agents:[],next_after:null});
    context=await runtime.taskContext(taskId,owned.ownership,(await f.send(`/api/tasks/${taskId}`)).body.data.revision);
    const input={taskId,actionId,sequence:1,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'list_agents',arguments:'{}'}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost directory result');}return response;};
    await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost directory result/);globalThis.fetch=originalFetch;
    const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{changed.prepare("UPDATE agents SET name='Later teammate',revision=revision+1 WHERE id=?").run(peer);changed.prepare('UPDATE agent_projects SET deleted=1,revision=revision+1 WHERE project=? AND agent=?').run(project,peer);}finally{changed.close();}
    await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(detail.results.length,2);assert.deepEqual(detail.results[1].content,{agents:[{id:peer,name:'Original teammate',description:'Project teammate',status:'idle',queuedMessages:0}],next_after:null});
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM task_results WHERE action=?').get(actionId)!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM task_reports WHERE action=?').get(actionId)!.n,1);}finally{db.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical teammate sends retain one scoped delivery on its fixed home after lost reply and restart', async () => {
  const f=await fixture(),keys=memoryKeys(),remoteKeys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'sender.sqlite'),server:f.origin(),development:true,entry:keys.entry}),remote=openDeviceRuntime({database:join(f.dir,'recipient.sqlite'),server:f.origin(),development:true,entry:remoteKeys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());await remote.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const homes=(await f.send('/api/devices')).body.data,home=homes.find((row:{id:string})=>row.id===runtime.deviceId()),otherHome=homes.find((row:{id:string})=>row.id===remote.deviceId()),project=randomUUID(),agent=randomUUID(),peer=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Messages'})).status,201);
    for(const [id,device] of [[agent,home],[peer,otherHome]])assert.equal((await f.send('/api/agents',{requestId:id,id,name:id===agent?'Sender':'Recipient',model:'fixture',backupModel:'',instructions:'Project teammate',threadLimit:2,projectId:project,homeDeviceId:device.id,expectedProjectRevision:1,expectedHomeDeviceRevision:device.revision,providerBinding:null})).status,201);
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'PRIVATE_SENDER_HISTORY',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    const input={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'send_message',arguments:JSON.stringify({recipients:[peer],text:'Only this text',expects_reply:false})}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost message result');}return response;};
    await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost message result/);globalThis.fetch=originalFetch;
    await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${taskId}`)).body.data,result=detail.results[0].content;
    assert.equal(result.status,'sent');assert.equal(result.expects_reply,false);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));let childId:string;
    try{
      const children=db.prepare('SELECT turn FROM agent_deliveries WHERE request=?').all(result.request);assert.equal(children.length,1);childId=String(children[0].turn);
      assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n,2);assert.equal(db.prepare('SELECT count(*) n FROM task_results WHERE action=?').get(actionId)!.n,1);
    }finally{db.close();}
    const child=(await f.send(`/api/tasks/${childId}`)).body.data;assert.equal(child.homeDeviceId,otherHome.id);assert.equal(child.state,'waiting_device');
    assert.equal((await f.send(`/api/tasks/${childId}`,undefined,'user_foreign')).status,404);
    const remoteConnection=remote.connect();await until(()=>remoteConnection.state().phase==='connected');const childOwned=await remote.startTask(childId),childContext=await remote.taskContext(childId,childOwned.ownership,childOwned.revision);
    const childConversation=childContext.snapshot.conversation as {message:{text:string;files:string[]};history:unknown[]};assert.deepEqual(childConversation.message,{text:'Only this text',files:[]});assert.deepEqual(childConversation.history,[]);assert(!JSON.stringify(childContext.snapshot).includes('PRIVATE_SENDER_HISTORY'));
    assert(!(childContext.snapshot.tools as {function:{name:string}}[]).some(tool=>['send_message','list_agents','interrupt_agent'].includes(tool.function.name)));
    const paused=await f.send(`/api/tasks/${taskId}/control`,{requestId:randomUUID(),expectedRevision:detail.revision,operation:'pause'});assert.equal(paused.status,200);
    await assert.rejects(remote.taskContext(childId,childOwned.ownership,childOwned.revision),(error:unknown)=>error instanceof ProtocolError&&error.code==='task_not_runnable');
    assert.equal((await f.send(`/api/tasks/${childId}/control`,{requestId:randomUUID(),expectedRevision:childOwned.revision,operation:'pause'})).status,200);
    const resumed=await f.send(`/api/tasks/${taskId}/control`,{requestId:randomUUID(),expectedRevision:paused.body.data.revision,operation:'resume'});assert.equal(resumed.status,200);
    assert.equal((await f.send(`/api/tasks/${childId}`)).body.data.state,'paused');
    const childResumed=await f.send(`/api/tasks/${childId}/control`,{requestId:randomUUID(),expectedRevision:childOwned.revision+1,operation:'resume'});assert.equal(childResumed.status,200);
    await remote.taskContext(childId,childOwned.ownership,childResumed.body.data.revision);
    const continued=await runtime.taskContext(taskId,owned.ownership,resumed.body.data.revision);assert((continued.snapshot.coordination as {request?:string}[]).some(row=>row.request===result.request));
  }finally{globalThis.fetch=originalFetch;await runtime.close();await remote.close();await f.close();}
});

test('canonical setup creation retains one restricted task and creation receipt after lost response and restart',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'setup-home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID(),binding=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Setup'})).status,201);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','synthetic-setup','Synthetic','ready',1)").run(binding,home.id,db.prepare('SELECT account FROM devices WHERE id=?').get(home.id)!.account);}finally{db.close();}
    const command={requestId:agent,id:agent,name:'New agent',model:'fixture',backupModel:'',instructions:'Build a careful research profile.',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:{bindingId:binding,expectedRevision:1},setup:true};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/api/agents')){assert.equal(response.status,201,await response.clone().text());await response.body?.cancel();throw new Error('Lost setup creation');}return response;};
    await assert.rejects(f.send('/api/agents',command),/Lost setup creation/);globalThis.fetch=originalFetch;
    await f.restart();const retry=await f.send('/api/agents',command);assert.equal(retry.status,200,JSON.stringify(retry.body));
    const lookup=await f.send(`/api/tasks/${agent}`),detail=lookup.body.data;assert.equal(detail.state,'waiting_device');assert.equal(lookup.body.receipt.requestId,agent);assert.equal(lookup.body.receipt.payloadDigest,retry.body.receipt.payloadDigest);
    const connection=runtime.connect();await until(()=>connection.state().phase==='connected');const owned=await runtime.startTask(agent),context=await runtime.taskContext(agent,owned.ownership,owned.revision);
    const tools=context.snapshot.tools as {function:{name:string;parameters?:{required:string[]}}}[];assert.deepEqual(tools.map(row=>row.function.name).sort(),['ask_user','edit_profile']);assert.deepEqual(tools.find(row=>row.function.name==='edit_profile')!.function.parameters!.required,['revision','name','instructions']);
    assert.match(JSON.stringify(context.snapshot.conversation),/Jangan mulai mengerjakan tugas bisnisnya/);assert.match(JSON.stringify(context.snapshot.conversation),/Build a careful research profile/);
    let providerCalls=0;const providerId=randomUUID();await runtime.executeAction({taskId:agent,actionId:providerId,sequence:0,actionKind:'provider',ownership:owned.ownership,payload:{prompt:'Synthetic setup request'},context,grantRevision:1,bindingId:binding,bindingRevision:1},async()=>{providerCalls++;return {name:'Research partner',instructions:'Compare sources and cite evidence.'};});
    const current=(await f.send(`/api/tasks/${agent}`)).body.data,next=await runtime.taskContext(agent,owned.ownership,current.revision),editId=randomUUID();
    await runtime.executeAction({taskId:agent,actionId:editId,sequence:1,actionKind:'canonical',ownership:owned.ownership,payload:{toolCall:{id:editId,function:{name:'edit_profile',arguments:JSON.stringify({revision:1,name:'Research partner',instructions:'Compare sources and cite evidence.'})}},expectedRevision:next.snapshot.taskRevision+1},context:next,grantRevision:1},()=>assert.fail('Host effect'));
    assert.equal((await f.send('/api/agents',command)).status,200);assert.equal(providerCalls,1);
    const saved=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{assert.equal(saved.prepare('SELECT count(*) n FROM tasks WHERE id=?').get(agent)!.n,1);assert.equal(saved.prepare('SELECT count(*) n FROM turns WHERE id=?').get(agent)!.n,1);assert.equal(saved.prepare('SELECT count(*) n FROM receipts WHERE request_id=?').get(agent)!.n,1);assert.equal(saved.prepare('SELECT name FROM agents WHERE id=?').get(agent)!.name,'Research partner');}finally{saved.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical caller interruption retains one notice and fences remote deliveries after lost result and restart',async()=>{
  const f=await fixture(),keys=memoryKeys(),remoteKeys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'caller.sqlite'),server:f.origin(),development:true,entry:keys.entry}),remote=openDeviceRuntime({database:join(f.dir,'worker.sqlite'),server:f.origin(),development:true,entry:remoteKeys.entry}),originalFetch=globalThis.fetch;
  let releaseEffect:(()=>void)|undefined;
  try{
    await runtime.enroll(f.jwt());await remote.enroll(f.jwt());const connection=runtime.connect(),remoteConnection=remote.connect();await until(()=>connection.state().phase==='connected'&&remoteConnection.state().phase==='connected');
    const homes=(await f.send('/api/devices')).body.data,home=homes.find((row:{id:string})=>row.id===runtime.deviceId()),otherHome=homes.find((row:{id:string})=>row.id===remote.deviceId()),project=randomUUID(),agent=randomUUID(),peer=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Interruption'})).status,201);
    for(const [id,device] of [[agent,home],[peer,otherHome]])assert.equal((await f.send('/api/agents',{requestId:id,id,name:id,model:'fixture',backupModel:'',instructions:'Project teammate',threadLimit:2,projectId:project,homeDeviceId:device.id,expectedProjectRevision:1,expectedHomeDeviceRevision:device.revision,providerBinding:null})).status,201);
    const admit=async()=>{
      const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Caller command',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
      return runtime.startTask(taskId);
    };
    const input=async(task:Awaited<ReturnType<typeof admit>>,name:string,args:unknown)=>{
      const detail=(await f.send(`/api/tasks/${task.taskId}`)).body.data,context=await runtime.taskContext(task.taskId,task.ownership,detail.revision),actionId=randomUUID();
      return {taskId:task.taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:task.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    };
    const parent=await admit();await runtime.executeAction(await input(parent,'send_message',{recipients:[peer],text:'Work that should stop',expects_reply:true}),()=>assert.fail('Host effect'));
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));let childId:string;
    try{childId=String(db.prepare('SELECT d.turn FROM agent_deliveries d JOIN agent_requests r ON r.id=d.request WHERE r.turn=?').get(parent.taskId)!.turn);}finally{db.close();}
    const child=await remote.startTask(childId),childContext=await remote.taskContext(childId,child.ownership,child.revision),effectId=randomUUID();let effectStarted=false;
    const hold=new Promise<void>(resolve=>{releaseEffect=resolve;});
    const pendingEffect=remote.executeAction({taskId:childId,actionId:effectId,sequence:0,actionKind:'read',ownership:child.ownership,payload:{operation:'synthetic read'},context:childContext,grantRevision:1},async()=>{effectStarted=true;await hold;return {text:'Accepted effect completed after interruption'};});
    await until(()=>effectStarted);const stopper=await admit(),stop=await input(stopper,'interrupt_agent',{recipient:peer,reason:'Changed direction'});
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost interruption result');}return response;};
    await assert.rejects(runtime.executeAction(stop,()=>assert.fail('Host effect')),/Lost interruption result/);globalThis.fetch=originalFetch;
    assert.equal((await f.send(`/api/tasks/${childId}`)).body.data.state,'cancelled');
    releaseEffect!();await pendingEffect;
    const cancelled=(await f.send(`/api/tasks/${childId}`)).body.data;assert.equal(cancelled.state,'cancelled');assert.deepEqual(cancelled.results[0].content,{text:'Accepted effect completed after interruption'});
    await f.restart();await until(()=>connection.state().phase==='connected'&&remoteConnection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===stop.actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${stopper.taskId}`)).body.data,result=detail.results[0].content;assert.equal(result.status,'interrupted');assert.deepEqual(result.cancelled,[childId]);
    await assert.rejects(remote.taskContext(childId,child.ownership,child.revision),(error:unknown)=>error instanceof ProtocolError&&error.code==='ownership_conflict');
    const saved=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{const notices=saved.prepare('SELECT t.text,r.expects_reply FROM agent_requests r JOIN agent_deliveries d ON d.request=r.id JOIN turns t ON t.id=d.turn WHERE r.turn=?').all(stopper.taskId);assert.equal(notices.length,1);assert.equal(notices[0].expects_reply,0);assert.match(String(notices[0].text),/Changed direction/);assert.equal(saved.prepare('SELECT count(*) n FROM task_results WHERE action=?').get(stop.actionId)!.n,1);}finally{saved.close();}
    const parentDetail=(await f.send(`/api/tasks/${parent.taskId}`)).body.data;await runtime.taskContext(parent.taskId,parent.ownership,parentDetail.revision);
  }finally{releaseEffect?.();globalThis.fetch=originalFetch;await runtime.close();await remote.close();await f.close();}
});

test('canonical profile edits recover exact result without replacing later edits or current task instructions', async () => {
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Profile edits'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Reader',model:'fixture',backupModel:'',instructions:'Original instructions',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const admit=async(agentRevision:number)=>{
      const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Edit profile',files:[]}},expectedRevisions={project:1,agent:agentRevision,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);return taskId;
    };
    const taskId=await admit(1),owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();
    const input={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'edit_profile',arguments:JSON.stringify({revision:1,name:'Edited',instructions:'Saved instructions'})}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost profile edit result');}return response;};
    await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost profile edit result/);globalThis.fetch=originalFetch;
    const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{changed.prepare("UPDATE agents SET name='Later edit',instructions='Later instructions',revision=revision+1 WHERE id=?").run(agent);}finally{changed.close();}
    await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.results.length,1);assert.deepEqual(detail.results[0].content,{name:'Edited',instructions:'Saved instructions',revision:2});
    const continued=await runtime.taskContext(taskId,owned.ownership,detail.revision),continuedSources=continued.snapshot.sourceRevisions as {kind:string;revision:number}[];assert.deepEqual(continued.snapshot.profile,context.snapshot.profile);assert.equal(continuedSources.find(row=>row.kind==='agent')!.revision,3);
    const nextId=await admit(3),next=await runtime.startTask(nextId),fresh=await runtime.taskContext(nextId,next.ownership,next.revision),freshProfile=fresh.snapshot.profile as {instructions:string;name:string;revision:number};assert.equal(freshProfile.instructions,'Later instructions');assert.equal(freshProfile.name,'Later edit');assert.equal(freshProfile.revision,3);
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical provider settings use home binding metadata and recover saved result after lost reply', async () => {
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID(),binding=randomUUID();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Provider reads'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Reader',model:'fixture',backupModel:'backup',instructions:'Read settings',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{
      const owner=String(db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_owner'").get()!.id);
      db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','bound-account','Owner','ready',1)").run(binding,home.id,owner);
      db.prepare('UPDATE agent_authority SET provider_binding=? WHERE agent=?').run(binding,agent);
      db.prepare("UPDATE agents SET provider_account='LEGACY_MUST_NOT_LEAK' WHERE id=?").run(agent);
    }finally{db.close();}
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Read provider settings',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),detail=(await f.send(`/api/tasks/${taskId}`)).body.data,context=await runtime.taskContext(taskId,owned.ownership,detail.revision),actionId=randomUUID();
    const input={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'read_provider_settings',arguments:'{}'}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost provider settings result');}return response;};
    await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost provider settings result/);globalThis.fetch=originalFetch;
    const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try{changed.prepare("UPDATE provider_bindings SET provider_account_id='Changed',readiness='revoked',revision=2 WHERE id=?").run(binding);}finally{changed.close();}
    await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    const results=(await f.send(`/api/tasks/${taskId}`)).body.data.results;
    assert.equal(results.length,1);assert.deepEqual(results[0].content,{revision:1,providerAccount:'bound-account',model:'fixture',backupModel:'backup',configured:true});
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical routine reads and edits isolate project configuration and recover original flow after lost reply', async () => {
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),other=randomUUID(),agent=randomUUID(),routine=randomUUID(),hidden=randomUUID();
    for(const id of [project,other])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:id})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Routine reader',model:'fixture',backupModel:'',instructions:'Read project routines',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const graph={root:agent,nodes:[agent],links:[]},db=new DatabaseSync(join(f.dir,'canonical.sqlite')),owner=String(db.prepare("SELECT id FROM accounts WHERE clerk_sub='user_owner'").get()!.id);
    try{
      db.exec('CREATE TABLE routines(id TEXT PRIMARY KEY,agent TEXT,name TEXT,prompt TEXT,next_at INTEGER,interval_ms INTEGER,enabled INTEGER,revision INTEGER,trigger TEXT,secret TEXT); CREATE TABLE routine_flows(routine TEXT PRIMARY KEY,graph TEXT,revision INTEGER);');
      for(const [id,projectId] of [[routine,project],[hidden,other]]){
        db.prepare("INSERT INTO routines VALUES (?,?,'Routine','Original prompt',123456,NULL,1,1,'webhook','WEBHOOK_SECRET')").run(id,agent);
        db.prepare("INSERT INTO record_scopes VALUES ('routines',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),owner,projectId,agent);
      }
      db.prepare('INSERT INTO routine_flows VALUES (?,?,1)').run(routine,JSON.stringify(graph));db.prepare("INSERT INTO record_scopes VALUES ('routine_flows',?,?,?,'owner','agent',?)").run(JSON.stringify([routine]),owner,project,agent);
    }finally{db.close();}
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Read routine',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId);let sequence=0;
    const run=async(name:string,args:unknown,lose=false)=>{
      const detail=(await f.send(`/api/tasks/${taskId}`)).body.data,context=await runtime.taskContext(taskId,owned.ownership,detail.revision),actionId=randomUUID();
      const input={taskId,actionId,sequence:sequence++,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
      if(lose){
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost routine result');}return response;};
        await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost routine result/);globalThis.fetch=originalFetch;
        const changed=new DatabaseSync(join(f.dir,'canonical.sqlite'));changed.prepare("UPDATE routines SET prompt='Changed prompt',revision=revision+1 WHERE id=?").run(routine);changed.prepare("UPDATE routine_flows SET graph='{}',revision=revision+1 WHERE routine=?").run(routine);changed.close();
        await f.restart();await until(()=>connection.state().phase==='connected');await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
      }else await runtime.executeAction(input,()=>assert.fail('Host effect'));
      return (await f.send(`/api/tasks/${taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===actionId).content;
    };
    const list=await run('list_routines',{});assert.deepEqual(list.routines.map((row:{id:string})=>row.id),[routine]);assert.equal(list.next_after,null);assert(!JSON.stringify(list).includes('WEBHOOK_SECRET'));
    const read=await run('read_routine',{id:routine},true);assert.equal(read.prompt,'Original prompt');assert.deepEqual(read.flow,{graph,revision:1});assert(!JSON.stringify(read).includes('WEBHOOK_SECRET'));
    assert.match((await run('read_routine',{id:hidden})).error,/not found/);
    const edit=await run('set_routine_flow',{id:routine,revision:2,links:[]},true);assert.deepEqual(edit,{graph,revision:3});
    const final=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(final.prepare('SELECT revision FROM routine_flows WHERE routine=?').get(routine)!.revision,4);assert.equal(final.prepare('SELECT count(*) n FROM task_results WHERE task=?').get(taskId)!.n,4);}finally{final.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});
