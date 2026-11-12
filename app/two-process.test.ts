import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkClient } from '@clerk/backend';
import { generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startCanonicalApp } from './server.ts';
import { openDeviceRuntime } from './device-runtime.ts';
import type { AuthConfig } from './auth.ts';
import { canonicalJson, ProtocolError, digestCommand, sha256 } from './protocol.ts';
import { parseOwnership } from './task-recovery.ts';
import sharp from 'sharp';

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
  return { dir, jwt, send, origin: () => app.origin, async restart() { const port = new URL(app.origin).port; await app.close(); app = await startCanonicalApp({ ...options, port: Number(port) }); }, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Device state did not settle');
}

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
