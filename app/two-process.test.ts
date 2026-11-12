import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkClient } from '@clerk/backend';
import { generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs';
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

function memoryKeys() {
  const values = new Map<string, string>();
  return { values, entry(service: string, name: string) { const key = `${service}/${name}`; return { getPassword: () => values.get(key) ?? null, setPassword: (value: string) => { values.set(key, value); } }; } };
}
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
  return { dir, jwt, send, origin: () => app.origin, async restart() { const port = new URL(app.origin).port; await app.close(); app = await startCanonicalApp({ ...options, port: Number(port) }); }, async restoreFrom(backup:string){
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

test('canonical routine reads isolate project configuration and recover original flow after lost reply', async () => {
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
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});
