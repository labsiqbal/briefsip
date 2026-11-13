import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkClient } from '@clerk/backend';
import { createHmac, createDecipheriv, createPublicKey, diffieHellman, hkdfSync, generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startCanonicalApp } from './server.ts';
import { openDeviceRuntime } from './device-runtime.ts';
import type { ActionContext } from './executor-journal.ts';
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

async function protectedWaitFixture() {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'event-home.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Events' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Waiter', model: 'fixture', backupModel: '', instructions: 'Wait', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const taskId = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Wait', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) })).status, 202);
    const owned = await runtime.startTask(taskId), context = await runtime.taskContext(taskId, owned.ownership, owned.revision), actionId = randomUUID();
    await assert.rejects(runtime.executeAction({ taskId, actionId, sequence: 0, actionKind: 'canonical', ownership: owned.ownership, payload: { toolCall: { id: 'wait-ready', function: { name: 'wait_for_event', arguments: JSON.stringify({ event: 'ready', timeoutSeconds: 60 }) } }, expectedRevision: context.snapshot.taskRevision + 1 }, context, grantRevision: 1 }, () => assert.fail('No host effect')), { code: 'device_offline' });
    let waitId = '';
    await until(async () => { const detail = (await f.send(`/api/tasks/${taskId}`)).body.data; waitId = detail.results[0]?.content?.id; return !!waitId; });
    await runtime.recoverPending();
    return { ...f, keys, runtime, connection, home, project, agent, taskId, waitId, ownership: owned.ownership };
  } catch (error) { await runtime.close(); await f.close(); throw error; }
}

test('protected turn event verifies on home, saves one receipt and resumes with exact raw payload', async () => {
  const f = await protectedWaitFixture(), { keys, runtime, connection, taskId, waitId, ownership } = f;
  try {
    const secret = [...keys.values].find(([key]) => key.includes('/event-wait/'))![1], delivery = randomUUID();
    const small = '{ "event": "ready", "payload": {"message":"hello 🌏"} }', body = small + ' '.repeat(65536 - Buffer.byteLength(small));
    const eventPath = `/api/turn-waits/${waitId}/events`, timestamp = String(Math.floor(Date.now() / 1000));
    const sendEvent = async (text = body, eventId = delivery, time = timestamp, extra: Record<string,string> = {}) => {
      const headers = { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': eventId, 'X-Briefsip-Signature': createHmac('sha256', secret).update(`${time}\n${eventId}\n${text}`).digest('hex'), ...extra };
      const response = await fetch(f.origin() + eventPath, { method: 'POST', headers, body: text });
      return { status: response.status, body: await response.json() };
    };
    const oversize = await sendEvent(body + ' '); assert.equal(oversize.status, 413, JSON.stringify(oversize.body)); await until(() => connection.state().phase === 'connected');
    assert.equal((await sendEvent(body, delivery, timestamp, { Origin: f.origin() })).status, 403);
    const wrongSignature = await sendEvent(body, delivery, timestamp, { 'X-Briefsip-Signature': '0'.repeat(64) }); assert.equal(wrongSignature.status, 401, JSON.stringify(wrongSignature.body));
    assert.equal((await sendEvent(body, delivery, '1')).status, 401, 'Stale unaccepted delivery denies');
    assert.equal((await sendEvent('{')).status, 400);
    assert.equal((await sendEvent('{"event":"other"}')).status, 409);
    assert.equal((await sendEvent('{"event":"ready","payload":1e999}')).status, 400);
    assert.equal((await sendEvent('{"event":"ready","extra":true}')).status, 400);
    await connection.stop(); assert.equal((await sendEvent()).body.error.code, 'device_offline');
    const reconnected = runtime.connect(); await until(() => reconnected.state().phase === 'connected');
    const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try { db.exec("CREATE TRIGGER fail_event_receipt BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'turn-wait-event:%' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END"); } finally { db.close(); }
    assert.equal((await sendEvent()).status, 500);
    assert.equal((await f.send(`/api/turn-waits/${waitId}`)).body.data.status, 'waiting', 'Receipt storage failure rolls back delivery and tool result');
    const repair = new DatabaseSync(join(f.dir, 'canonical.sqlite')); repair.exec('DROP TRIGGER fail_event_receipt'); repair.close();
    const accepted = await sendEvent(); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.accepted, true); assert.equal(accepted.body.data.delivery, delivery);
    assert.deepEqual((await sendEvent()).body, accepted.body);
    assert.deepEqual((await sendEvent(body, delivery, '1')).body, accepted.body, 'Accepted retry skips freshness after verifying HMAC');
    assert.equal((await sendEvent(body, delivery, '1', { 'X-Briefsip-Signature': '0'.repeat(64) })).status, 401);
    assert.equal((await sendEvent(small)).status, 409, 'Whitespace is part of exact raw body digest');
    assert.equal((await sendEvent(body, randomUUID())).status, 409);
    assert.equal((await f.send(`/api/turn-waits/${waitId}`)).body.data.status, 'received');
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data, next = await runtime.taskContext(taskId, ownership, detail.revision);
    const journal = next.snapshot.toolJournal as {kind:string;callId?:string;result:{payload?:{message?:string}}}[];
    assert.equal(journal.filter(row => row.kind === 'flow_tool' && row.callId === 'wait-ready' && row.result.payload?.message === 'hello 🌏').length, 1);
    const generation = reconnected.state().generation; await f.restart(); await until(() => reconnected.state().phase === 'connected' && reconnected.state().generation > generation);
    assert.deepEqual((await sendEvent()).body, accepted.body, 'Canonical restart retains exact receipt');
    const after = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(after.revision, detail.revision, 'Retry cannot advance task revision');
    assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: after.revision, operation: 'cancel' })).status, 200);
    assert.deepEqual((await sendEvent()).body, accepted.body, 'Accepted delivery remains evidence after task ends');
    assert.equal([...keys.values].filter(([key]) => key.includes('/event-wait/')).length, 1);
    const source = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    const owner = (await f.send('/api/session')).body.data.accountId;
    const snapshot = await workspaceSnapshot(source, owner); source.close();
    try {
      await reconnected.stop(); await f.restoreFrom(snapshot.file);
      assert.equal((await sendEvent()).status, 404, 'Restore disables old event admissions');
      const restored = await f.send(`/api/turn-waits/${waitId}`);
      assert.equal(restored.status, 200); assert.equal(restored.body.data.status, 'received');
      assert.deepEqual(restored.body.data.receipt, accepted.body.receipt, 'Owner retains delivered evidence while recovery is read-only');
      assert.equal((await f.send(`/api/turn-waits/${waitId}`, undefined, 'user_collaborator')).status, 404);
    } finally { await snapshot.cleanup(); }
  } finally { await runtime.close(); await f.close(); }
});

test('protected turn event rejects delayed verification after scope or connection changes', async t => {
  for (const change of ['pause','rules','cancel','revoke','timeout'] as const) await t.test(change, async () => {
    const f = await protectedWaitFixture(), originalFetch = globalThis.fetch;
    let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const secret = [...f.keys.values].find(([key]) => key.includes('/event-wait/'))![1], delivery = randomUUID(), body = '{"event":"ready","payload":{"ok":true}}', time = String(Math.floor(Date.now() / 1000));
    const sendEvent = async () => {
      const response = await originalFetch(f.origin() + `/api/turn-waits/${f.waitId}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': delivery, 'X-Briefsip-Signature': createHmac('sha256', secret).update(`${time}\n${delivery}\n${body}`).digest('hex') }, body });
      return { status: response.status, body: await response.json() };
    };
    try {
      globalThis.fetch = async (url, init) => { if (String(url).endsWith('/wait-event-results')) { held = true; await gate; } return originalFetch(url, init); };
      const pending = sendEvent(); await until(() => held);
      assert.equal((await sendEvent()).status, 429, 'At most one pending event per home');
      assert.equal((await f.send(`/api/turn-waits/${f.waitId}`)).body.data.status, 'waiting');
      if (change === 'rules') assert.equal((await f.send(`/api/projects/${f.project}/agents/${f.agent}/rules`, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'Changed context' }, 'user_owner', 'PUT')).status, 200);
      else if (change === 'revoke') { const device = (await f.send('/api/devices')).body.data[0]; assert.equal((await f.send(`/api/devices/${device.id}/revoke`, { requestId: randomUUID(), expectedRevision: device.revision })).status, 200); }
      else if (change !== 'timeout') { const task = (await f.send(`/api/tasks/${f.taskId}`)).body.data; assert.equal((await f.send(`/api/tasks/${f.taskId}/control`, { requestId: randomUUID(), expectedRevision: task.revision, operation: change })).status, 200); }
      const timedOut = change === 'timeout' ? await pending : undefined;
      release(); globalThis.fetch = originalFetch;
      const denied = timedOut ?? await pending;
      assert.equal(denied.status, ['revoke','timeout'].includes(change) ? 503 : 409, JSON.stringify(denied.body));
      if (change === 'rules' || change === 'pause' || change === 'timeout') {
        assert.equal((await sendEvent()).status, 200, 'Fresh verification may accept without replaying an effect');
        if (change === 'pause') assert.equal((await f.send(`/api/tasks/${f.taskId}`)).body.data.state, 'paused', 'Event cannot undo manual pause');
      }
    } finally { release(); globalThis.fetch = originalFetch; await f.runtime.close(); await f.close(); }
  });
});

test('protected turn wait uses outbound stream and recovers lost host ACK without another key or wait', async () => {
  const f = await fixture(), keys = memoryKeys(), originalFetch = globalThis.fetch;
  const database = join(f.dir, 'wait-home.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
  let lost = false;
  try {
    await runtime.enroll(f.jwt());
    let connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Waits' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Waiter', model: 'fixture', backupModel: '', instructions: 'Wait', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const taskId = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Wait for ready', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) })).status, 202);
    const owned = await runtime.startTask(taskId), context = await runtime.taskContext(taskId, owned.ownership, owned.revision), actionId = randomUUID();
    const input = { taskId, actionId, sequence: 0, actionKind: 'canonical' as const, ownership: owned.ownership, payload: { toolCall: { id: 'wait-ready', function: { name: 'wait_for_event', arguments: JSON.stringify({ event: 'ready', timeoutSeconds: 60 }) } }, expectedRevision: context.snapshot.taskRevision + 1 }, context, grantRevision: 1 };
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (String(url).endsWith('/wait-secret-results') && !lost) { assert.equal(response.status, 200, await response.clone().text()); lost = true; await response.body?.cancel(); throw new Error('Lost wait ACK'); }
      return response;
    };
    await assert.rejects(runtime.executeAction(input, () => assert.fail('Wait cannot execute a host effect')), error => error instanceof ProtocolError && error.code === 'device_offline');
    await until(() => lost);
    globalThis.fetch = originalFetch;
    await connection.stop();
    const keyFile = join(f.dir, 'wait-probe-keys.json'); writeFileSync(keyFile, JSON.stringify(Object.fromEntries(keys.values)), { mode: 0o600 });
    const source = `import { openDeviceRuntime } from ${JSON.stringify(new URL('./device-runtime.ts', import.meta.url).href)};
      import { readFileSync } from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
      const keys=JSON.parse(readFileSync(process.argv[2],'utf8')); let posts=0; const original=globalThis.fetch;
      globalThis.fetch=(url,init)=>{if(String(url).endsWith('/wait-secret-results'))posts++;return original(url,init);};
      const runtime=openDeviceRuntime({database:process.argv[1],server:process.argv[3],development:true,entry:(service,name)=>({getPassword:()=>keys[service+'/'+name]??null,setPassword:()=>{throw new Error('No writes expected');}})});
      const connection=runtime.connect(),until=Date.now()+10000;while(connection.state().phase!=='connected'){if(Date.now()>until)throw new Error('Probe connection timeout');await new Promise(resolve=>setTimeout(resolve,50));}
      await new Promise(resolve=>setTimeout(resolve,500));const db=new DatabaseSync(process.argv[1]);const state=db.prepare('SELECT state FROM device_wait_secrets').get().state;db.close();
      process.send({posts,state});await runtime.close();process.disconnect();`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, database, keyFile, f.origin()], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const childExit = once(child, 'exit');
    try {
      const [probe] = await once(child, 'message', { signal: AbortSignal.timeout(12000) });
      assert.deepEqual(probe, { posts: 0, state: 'ready' }, 'Second host must not ACK or change wait evidence while original runner holds lock');
      const [status] = await childExit; assert.equal(status, 0);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await childExit; }
    await f.restart();
    connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    await until(() => {
      const host = new DatabaseSync(database);
      try { return host.prepare('SELECT state FROM device_wait_secrets').get()?.state === 'acknowledged'; } finally { host.close(); }
    });
    const canonical = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      assert.equal(canonical.prepare('SELECT count(*) n FROM wait_provisions').get()!.n, 1);
      assert.equal(canonical.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 1);
      assert.equal(canonical.prepare('SELECT state FROM wait_provisions').get()!.state, 'activated');
      assert.equal(canonical.prepare("SELECT count(*) n FROM receipts WHERE scope='wait-secret-results'").get()!.n, 1);
      const secrets = [...keys.values].filter(([reference]) => reference.includes('/event-wait/'));
      assert.equal(secrets.length, 1);
      for (const table of ['wait_provisions', 'turn_waits', 'receipts', 'task_results']) assert(!JSON.stringify(canonical.prepare('SELECT * FROM ' + table).all()).includes(secrets[0][1]));
    } finally { canonical.close(); }
    await runtime.recoverPending();
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(detail.results.length, 1); assert.equal(detail.results[0].content.status, 'waiting');
    assert.equal((await runtime.runTask(taskId, () => assert.fail('Waiting task must not call provider'))).state, 'event_pending');
    const waitId = detail.results[0].content.id;
    const path = `/api/turn-waits/${waitId}/connection`, status = await f.send(path);
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(status.body.data).sort(), ['id','event','deadline','status','secretGeneration','sourceDeviceId'].sort());
    const browser = generateKeyPairSync('x25519'), ephemeralPublicKey = browser.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const reveal = { requestId: randomUUID(), ephemeralPublicKey, expectedSecretGeneration: 1 };
    const encrypted = await f.send(path, reveal); assert.equal(encrypted.status, 200, JSON.stringify(encrypted.body));
    const value = encrypted.body.data, device = (await f.send('/api/devices')).body.data.find((row: { id: string }) => row.id === home.id), owner = (await f.send('/api/session')).body.data.accountId;
    assert.deepEqual(Object.keys(value).sort(), ['requestId','waitKey','sourceDeviceId','deviceGeneration','secretGeneration','expiresAt','iv','ciphertext','tag'].sort());
    const secret = [...keys.values].find(([key]) => key.includes('/event-wait/'))![1];
    assert(!JSON.stringify(encrypted.body).includes(secret));
    const decrypt = (privateKey = browser.privateKey, associatedOwner = owner) => {
      const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.from(JSON.parse(device.descriptor_json).encryptionPublicKey, 'base64url'), type: 'spki', format: 'der' }) });
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', shared, reveal.requestId, 'briefsip-wait-reveal-v1', 32)), Buffer.from(value.iv, 'base64url'));
      cipher.setAAD(Buffer.from(JSON.stringify([value.requestId,value.waitKey,associatedOwner,value.deviceGeneration,value.secretGeneration,value.expiresAt]))); cipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
      return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64url')), cipher.final()]).toString('utf8');
    };
    assert.equal(decrypt(), secret);
    assert.throws(() => decrypt(generateKeyPairSync('x25519').privateKey));
    assert.throws(() => decrypt(browser.privateKey, randomUUID()));
    assert.equal((await f.send(path, { ...reveal, requestId: randomUUID(), expectedSecretGeneration: 2 })).status, 409);
    assert.equal((await f.send(path, { ...reveal, requestId: randomUUID(), ephemeralPublicKey: 'invalid' })).status, 400);
    assert.equal((await f.send(path, { ...reveal, requestId: randomUUID() }, 'user_collaborator')).status, 404);
    const wrongOrigin = await originalFetch(f.origin() + path, { method: 'POST', headers: { Authorization: `Bearer ${f.jwt()}`, Origin: 'https://foreign.invalid', 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': reveal.requestId }, body: JSON.stringify(reveal) });
    assert.equal(wrongOrigin.status, 403); await wrongOrigin.body?.cancel();
    let held = false, releaseResult!: () => void;
    const gate = new Promise<void>(resolve => { releaseResult = resolve; });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/wait-reveal-results')) { held = true; await gate; }
      return originalFetch(url, init);
    };
    const pendingReveal = f.send(path, { ...reveal, requestId: randomUUID() });
    try {
      await until(() => held);
      assert.equal((await f.send(path, { ...reveal, requestId: randomUUID() })).status, 429);
      const latest = (await f.send(`/api/tasks/${taskId}`)).body.data;
      assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: latest.revision, operation: 'pause' })).status, 200);
    } finally { releaseResult(); globalThis.fetch = originalFetch; }
    assert.equal((await pendingReveal).status, 409, 'Delayed reveal cannot cross a task scope change');
    const fresh = await f.send(path, { ...reveal, requestId: randomUUID() });
    assert.equal(fresh.status, 200, 'Paused wait can obtain a fresh owner connection');
    assert.notEqual(fresh.body.data.iv, value.iv);
    held = false;
    const rulesGate = new Promise<void>(resolve => { releaseResult = resolve; });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/wait-reveal-results')) { held = true; await rulesGate; }
      return originalFetch(url, init);
    };
    const beforeRulesChange = f.send(path, { ...reveal, requestId: randomUUID() });
    try {
      await until(() => held);
      assert.equal((await f.send(`/api/projects/${project}/agents/${agent}/rules`, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'Updated project context' }, 'user_owner', 'PUT')).status, 200);
    } finally { releaseResult(); globalThis.fetch = originalFetch; }
    assert.equal((await beforeRulesChange).status, 409, 'Delayed reveal cannot cross project rules/capability revisions');
    const retained = [...keys.values].filter(([key]) => key.includes('/event-wait/'));
    assert.equal(retained.length, 1); assert.equal(retained[0][1], secret);
    const inspect = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try { for (const table of ['wait_provisions','turn_waits','receipts','task_results','sync_events']) assert(!JSON.stringify(inspect.prepare('SELECT * FROM ' + table).all()).includes(secret)); }
    finally { inspect.close(); }
    await connection.stop();
    assert.equal((await f.send(path, { ...reveal, requestId: randomUUID() })).status, 503);
    assert.equal((await f.send(path)).status, 200, 'Offline wait metadata remains owner-readable');
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('canonical shared data isolates project images and recovers one write after lost reply and restart',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),other=randomUUID(),agent=randomUUID();
    for(const id of [project,other])assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id,name:id})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Data agent',model:'fixture',backupModel:'',instructions:'Use project data',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    assert.equal((await f.send(`/api/projects/${other}/agents/${agent}`,{requestId:randomUUID(),expectedProjectRevision:1,expectedAgentRevision:1,expectedAuthorityRevision:1,expectedParticipationRevision:0,rules:'',capabilities:{v:1,tools:['list_data_tables','query_data'],resources:[]}},'user_owner','PUT')).status,201);
    const start=async(projectId:string)=>{
      const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Use data',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
      assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,projectId,agent,home.id,payload,expectedRevisions])})).status,202);
      return {...await runtime.startTask(taskId),sequence:0};
    };
    const first=await start(project);
    const run=async(task:typeof first,name:string,args:unknown,lose=false)=>{
      const detail=(await f.send(`/api/tasks/${task.taskId}`)).body.data,context=await runtime.taskContext(task.taskId,task.ownership,detail.revision),actionId=randomUUID();
      const input={taskId:task.taskId,actionId,sequence:task.sequence++,actionKind:'canonical' as const,ownership:task.ownership,payload:{toolCall:{id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
      if(lose){
        globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost data result');}return response;};
        await assert.rejects(runtime.executeAction(input,()=>assert.fail('Host effect')),/Lost data result/);globalThis.fetch=originalFetch;
        const generation=connection.state().generation;await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>generation);
        await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
      }else await runtime.executeAction(input,()=>assert.fail('Host effect'));
      return (await f.send(`/api/tasks/${task.taskId}`)).body.data.results.find((row:{actionId:string})=>row.actionId===actionId).content;
    };
    assert.equal((await run(first,'query_data',{sql:'CREATE TABLE notes(text TEXT)'})).revision,1);
    assert.equal((await run(first,'query_data',{sql:'INSERT INTO notes VALUES (?)',parameters:['Project A only']},true)).revision,2);
    assert.deepEqual((await run(first,'query_data',{sql:'SELECT text FROM notes'})).rows,[['Project A only']]);
    assert.deepEqual((await run(first,'list_data_tables',{})).tables.map((row:{name:string})=>row.name),['notes']);
    const second=await start(other);assert.deepEqual((await run(second,'list_data_tables',{})).tables,[]);
    assert.match((await run(second,'query_data',{sql:'SELECT * FROM notes'})).error,/no such table/);
    assert.equal((await run(second,'query_data',{sql:'CREATE TABLE notes(text TEXT)'})).revision,1);
    assert.deepEqual((await run(second,'query_data',{sql:'SELECT * FROM notes'})).rows,[]);
    const inspect=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(inspect.prepare('SELECT revision FROM shared_data WHERE project=?').get(project)!.revision,2);assert.equal(inspect.prepare('SELECT revision FROM shared_data WHERE project=?').get(other)!.revision,1);}finally{inspect.close();}
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

test('canonical avatar removal recovers its original result after a lost reply, later image and restart',async()=>{
  const f=await fixture(),keys=memoryKeys(),runtime=openDeviceRuntime({database:join(f.dir,'home.sqlite'),server:f.origin(),development:true,entry:keys.entry}),originalFetch=globalThis.fetch;
  try{
    await runtime.enroll(f.jwt());const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    const home=(await f.send('/api/devices')).body.data[0],project=randomUUID(),agent=randomUUID(),image=await sharp({create:{width:256,height:256,channels:4,background:'#206060'}}).png().toBuffer();
    assert.equal((await f.send('/api/projects',{requestId:randomUUID(),id:project,name:'Avatar project'})).status,201);
    assert.equal((await f.send('/api/agents',{requestId:agent,id:agent,name:'Avatar owner',model:'fixture',backupModel:'',instructions:'Remove avatar',threadLimit:2,projectId:project,homeDeviceId:home.id,expectedProjectRevision:1,expectedHomeDeviceRevision:home.revision,providerBinding:null})).status,201);
    const seed=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{seed.prepare('INSERT INTO agent_avatars VALUES (?,1,?)').run(agent,image);}finally{seed.close();}
    const taskId=randomUUID(),payload={v:1,kind:'direct',message:{text:'Remove my avatar',files:[]}},expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1};
    assert.equal((await f.send('/api/tasks',{requestId:taskId,projectId:project,agentId:agent,homeDeviceId:home.id,payload,expectedRevisions,payloadDigest:digestCommand(['briefsip-task-payload-v1',taskId,project,agent,home.id,payload,expectedRevisions])})).status,202);
    const owned=await runtime.startTask(taskId),context=await runtime.taskContext(taskId,owned.ownership,owned.revision),actionId=randomUUID();assert.equal((context.snapshot.profile as {avatarRevision:number}).avatarRevision,1);
    const action={taskId,actionId,sequence:0,actionKind:'canonical' as const,ownership:owned.ownership,payload:{toolCall:{id:actionId,function:{name:'set_avatar',arguments:JSON.stringify({image:null,revision:1})}},expectedRevision:context.snapshot.taskRevision+1},context,grantRevision:1};
    globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(String(url).endsWith('/context-mutations')){assert.equal(response.status,200,await response.clone().text());await response.body?.cancel();throw new Error('Lost avatar removal');}return response;};
    await assert.rejects(runtime.executeAction(action,()=>assert.fail('Host effect')),/Lost avatar removal/);globalThis.fetch=originalFetch;
    const newer=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{assert.equal(newer.prepare('SELECT image FROM agent_avatars WHERE agent=?').get(agent)!.image,null);newer.prepare('UPDATE agent_avatars SET revision=3,image=? WHERE agent=?').run(image,agent);}finally{newer.close();}
    const generation=connection.state().generation;await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>generation);
    await until(()=>runtime.recoveryStatus().results.some(row=>row.actionId===actionId&&row.state==='acknowledged'),15000);
    const detail=(await f.send(`/api/tasks/${taskId}`)).body.data;assert.equal(detail.results.length,1);assert.deepEqual(detail.results[0].content,{revision:2,present:false});
    const inspect=new DatabaseSync(join(f.dir,'canonical.sqlite'));try{const row=inspect.prepare('SELECT revision,image FROM agent_avatars WHERE agent=?').get(agent)!;assert.equal(row.revision,3);assert.deepEqual(Buffer.from(row.image as Uint8Array),image);}finally{inspect.close();}
    const latest=await runtime.taskContext(taskId,owned.ownership,detail.revision);assert.equal((latest.snapshot.profile as {avatarRevision:number}).avatarRevision,3);
  }finally{globalThis.fetch=originalFetch;await runtime.close();await f.close();}
});

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
  const syncSecret = randomBytes(32);
  const options = { database: join(dir, 'canonical.sqlite'), auth, clerk, syncKey: () => syncSecret };
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

async function workflowConfigurationFixture() {
  const f = await fixture(), runtime = openDeviceRuntime({ database: join(f.dir, 'workflow-home.sqlite'), server: f.origin(), development: true, entry: memoryKeys().entry });
  try {
    await runtime.enroll(f.jwt());
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), other = randomUUID(), agent = randomUUID(), workflow = randomUUID();
    for (const id of [project, other]) assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id, name: 'Workflows' })).status, 201);
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Workflow agent', model: 'fixture', backupModel: '', instructions: 'Help', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const graph = { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] }, list = `/api/projects/${project}/agents/${agent}/workflows`, detail = `/api/projects/${project}/workflows/${workflow}`;
    return { ...f, runtime, home, project, other, agent, workflow, graph, list, detail, close: async () => { await runtime.close(); await f.close(); } };
  } catch (error) { await runtime.close(); await f.close(); throw error; }
}

test('canonical workflow executes conditions and approval once across restart', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail } = f;
  try {
    const graph = { entry: 'check', maxSteps: 3, nodes: [
      { id: 'check', kind: 'condition', operator: 'equals', value: 'Original input', yes: 'approve', no: 'out' },
      { id: 'approve', kind: 'approval', prompt: 'Proceed?', yes: 'out' }, { id: 'out', kind: 'output' },
    ] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Execution', graph })).status, 201);
    const run = randomUUID(), command = { requestId: run, id: run, revision: 1, input: 'Original input' }, path = `/api/projects/${project}/workflow-runs/${run}`;
    const admission = await f.send(detail + '/run', command); assert.equal(admission.status, 201);
    let current: any;
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'approval'; });
    assert.deepEqual(current.steps.map((step: { node: string; status: string }) => [step.node, step.status]), [['check', 'done'], ['approve', 'approval']]);
    await f.restart();
    assert.deepEqual((await f.send(path)).body.data.steps, current.steps);
    const decision = randomUUID(), approval = { requestId: decision, id: decision, revision: current.revision, accepted: true };
    const accepted = await f.send(path + '/approve', approval); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'done'; });
    assert.equal(current.last, 'Original input'); assert.equal(current.stepCount, 3);
    assert.deepEqual((await f.send(path + '/approve', approval)).body, accepted.body);
    assert.deepEqual((await f.send(detail + '/run', command)).body.receipt, admission.body.receipt);
    await f.restart(); assert.equal((await f.send(path)).body.data.stepCount, 3);
  } finally { await f.close(); }
});

test('canonical workflow admits isolated home tasks and keeps model nodes tool-free', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f;
  try {
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const graph = { entry: 'agent', maxSteps: 3, nodes: [
      { id: 'agent', kind: 'agent', agent: f.agent, prompt: 'Agent work', next: 'model' },
      { id: 'model', kind: 'model', model: 'workflow-model', prompt: 'Model work', next: 'out' }, { id: 'out', kind: 'output' },
    ] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Home tasks', graph })).status, 201);
    const db = new DatabaseSync(join(f.dir, 'canonical.sqlite')), binding = randomUUID();
    try {
      db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','workflow-fixture','Fixture','ready',1)").run(binding, f.home.id, (await f.send('/api/session')).body.data.accountId);
      db.prepare('UPDATE agent_authority SET provider_binding=?,revision=revision+1 WHERE agent=?').run(binding, f.agent);
    } finally { db.close(); }
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: 'Synthetic input' })).status, 201);
    let current: any;
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'waiting'; });
    const first = current.steps[0].turn, task = (await f.send(`/api/tasks/${first}`)).body.data;
    assert.equal(task.homeDeviceId, f.home.id); assert.equal(task.agentId, f.agent);
    const owned = await runtime.startTask(first), context = await runtime.taskContext(first, owned.ownership, owned.revision);
    const agentSnapshot = context.snapshot as any;
    assert(agentSnapshot.tools.length > 0); assert.equal(agentSnapshot.admission.initiatorAccountId, (await f.send('/api/session')).body.data.accountId);
    assert.equal(agentSnapshot.conversation.history.length, 0); assert.match(agentSnapshot.conversation.message.text, /Agent work\n\nWorkflow input:\nSynthetic input/);
    // Supply provider evidence through the real executor protocol, without external inference.
    const cancel = randomUUID();
    assert.equal((await f.send(path + '/cancel', { requestId: cancel, id: cancel, revision: current.revision })).status, 200);
    assert.equal((await f.send(`/api/tasks/${first}`)).body.data.state, 'cancelled');
    await assert.rejects(runtime.taskContext(first, owned.ownership, owned.revision));
    const next = randomUUID(), nextPath = `/api/projects/${project}/workflow-runs/${next}`;
    assert.equal((await f.send(detail + '/run', { requestId: next, id: next, revision: 1, input: 'Synthetic input' })).status, 201);
    await until(async () => { current = (await f.send(nextPath)).body.data; return current.status === 'waiting'; });
    assert.equal((await runtime.runTask(current.steps[0].turn, () => ({ text: 'Agent result' }))).state, 'completed');
    await until(async () => { current = (await f.send(nextPath)).body.data; return current.steps.length === 2; });
    const modelTask = current.steps[1].turn;
    assert.equal((await runtime.runTask(modelTask, modelContext => {
      const modelSnapshot = modelContext.snapshot as any;
      assert.equal(modelSnapshot.profile.model, 'workflow-model'); assert.equal(modelSnapshot.profile.instructions, 'Help');
      for (const field of ['tools','memories','skills','skillAssets']) assert.deepEqual(modelSnapshot[field], []);
      assert.equal(modelSnapshot.conversation.history.length, 0);
      assert.match(modelSnapshot.conversation.message.text, /Previous step result:\nAgent result$/);
      return { text: 'Model result' };
    })).state, 'completed');
    await until(async () => { current = (await f.send(nextPath)).body.data; return current.status === 'done'; });
    assert.equal(current.last, 'Model result'); assert.equal(current.stepCount, 3);
  } finally { await f.close(); }
});

test('canonical workflow dispatch retains original collaborator and owner cancellation fences revoked work', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir,'canonical.sqlite'));
  try {
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const owner = (await f.send('/api/session')).body.data.accountId, collaborator = (await f.send('/api/session',undefined,'user_collaborator')).body.data.accountId;
    db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project,collaborator);
    db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(project,collaborator,f.agent);
    db.prepare('INSERT INTO response_policies VALUES (?,?,?,0,1)').run(project,collaborator,f.agent);
    const graph = { entry:'work', maxSteps:2, nodes:[{id:'work',kind:'agent',agent:f.agent,prompt:'Synthetic work',next:'out'},{id:'out',kind:'output'}] };
    assert.equal((await f.send(list,{requestId:workflow,id:workflow,revision:0,name:'Collaborator',graph})).status,201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail+'/run',{requestId:run,id:run,revision:1,input:'Input'},'user_collaborator')).status,201);
    db.prepare("UPDATE record_scopes SET account=? WHERE table_name='workflow_runs' AND key_json=?").run(owner,canonicalJson([run]));
    let current = (await f.send(path)).body.data;
    await until(async()=>{current=(await f.send(path)).body.data;return current.status==='waiting';});
    const child=current.steps[0].turn, owned=await runtime.startTask(child), context=await runtime.taskContext(child,owned.ownership,owned.revision);
    assert.equal((context.snapshot.admission as {initiatorAccountId:string}).initiatorAccountId,collaborator);
    assert.equal((await f.send(`/api/tasks/${child}`,undefined,'user_collaborator')).status,200,'Response OFF preserves execution and project visibility');
    db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=?').run(project,collaborator);
    await assert.rejects(runtime.taskContext(child,owned.ownership,owned.revision),{code:'execution_denied'});
    const cancel = randomUUID(), command={requestId:cancel,id:cancel,revision:current.revision};
    db.exec("CREATE TRIGGER fail_workflow_cancel BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'retained:%/workflow-runs/%/cancel' BEGIN SELECT RAISE(ABORT,'cancel receipt failure'); END");
    assert.equal((await f.send(path+'/cancel',command)).status,500);
    assert.equal((await f.send(`/api/tasks/${child}`)).body.data.state,'running','Failed parent receipt rolls back child fencing');
    db.exec('DROP TRIGGER fail_workflow_cancel');
    assert.equal((await f.send(path+'/cancel',command)).status,200);
    assert.equal((await f.send(path)).body.data.status,'cancelled'); assert.equal((await f.send(`/api/tasks/${child}`)).body.data.state,'cancelled');
    await assert.rejects(runtime.startTask(child));
  } finally {db.close();await f.close();}
});

test('canonical workflow completion recovers a lost ACK after advancing to approval', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite')), originalFetch = globalThis.fetch;
  try {
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const binding = randomUUID(), owner = (await f.send('/api/session')).body.data.accountId;
    db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','workflow-fixture','Fixture','ready',1)").run(binding, f.home.id, owner);
    db.prepare('UPDATE agent_authority SET provider_binding=?,revision=revision+1 WHERE agent=?').run(binding, f.agent);
    const graph = { entry: 'work', maxSteps: 3, nodes: [{ id: 'work', kind: 'agent', agent: f.agent, prompt: 'Answer once', next: 'approve' }, { id: 'approve', kind: 'approval', prompt: 'Proceed?', yes: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Completion recovery', graph })).status, 201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: 'Synthetic' })).status, 201);
    let current: any, actionId = '', calls = 0, saved: any;
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'waiting'; });
    const taskId = current.steps[0].turn;
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (String(url).endsWith('/complete')) {
        assert.equal(response.status, 200, await response.clone().text()); saved = await response.clone().json();
        actionId = JSON.parse(String(init!.body)).actionId; await response.body?.cancel(); throw new Error('Lost workflow completion ACK');
      }
      return response;
    };
    await assert.rejects(runtime.runTask(taskId, () => { calls++; return { text: 'Saved once' }; }), /Lost workflow completion ACK/);
    globalThis.fetch = originalFetch;
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'approval'; });
    assert.deepEqual((await runtime.completeTask(taskId, actionId)).receipt, saved.receipt);
    await f.restart(); await until(() => connection.state().phase === 'connected');
    assert.deepEqual((await runtime.completeTask(taskId, actionId)).receipt, saved.receipt);
    assert.equal(calls, 1); assert.equal(db.prepare('SELECT count(*) n FROM receipts WHERE scope=?').get(`tasks:complete:${taskId}`)!.n, 1);
    db.prepare('UPDATE agent_projects SET deleted=1 WHERE project=? AND agent=?').run(project, f.agent);
    await assert.rejects(runtime.completeTask(taskId, actionId), { code: 'execution_denied' });
  } finally { globalThis.fetch = originalFetch; db.close(); await f.close(); }
});

test('canonical workflow cancellation fences no-reply descendants of completed steps', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const binding = randomUUID(), peer = randomUUID(), owner = (await f.send('/api/session')).body.data.accountId, home = (await f.send('/api/devices')).body.data[0];
    db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','workflow-fixture','Fixture','ready',1)").run(binding, f.home.id, owner);
    db.prepare('UPDATE agent_authority SET provider_binding=?,revision=revision+1 WHERE agent=?').run(binding, f.agent);
    assert.equal((await f.send('/api/agents', { requestId: peer, id: peer, name: 'Teammate', model: 'fixture', backupModel: '', instructions: 'Help', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const graph = { entry: 'work', maxSteps: 3, nodes: [{ id: 'work', kind: 'agent', agent: f.agent, prompt: 'Delegate without waiting', next: 'approve' }, { id: 'approve', kind: 'approval', prompt: 'Proceed?', yes: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Cancel descendants', graph })).status, 201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: 'Synthetic' })).status, 201);
    let current: any, calls = 0;
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'waiting'; });
    const parent = current.steps[0].turn;
    assert.equal((await runtime.runTask(parent, () => ++calls === 1 ? { toolCall: { id: 'delegate', function: { name: 'send_message', arguments: JSON.stringify({ recipients: [peer], text: 'Background work', expects_reply: false }) } } } : { text: 'Parent done' })).state, 'completed');
    await until(async () => { current = (await f.send(path)).body.data; return current.status === 'approval'; });
    const child = String(db.prepare('SELECT id FROM turns WHERE parent=?').get(parent)!.id);
    const childOwned = await runtime.startTask(child);
    await runtime.taskContext(child, childOwned.ownership, childOwned.revision);
    const cancel = randomUUID(); assert.equal((await f.send(path + '/cancel', { requestId: cancel, id: cancel, revision: current.revision })).status, 200);
    assert.equal((await f.send(`/api/tasks/${child}`)).body.data.state, 'cancelled');
    assert.equal((await f.send(`/api/tasks/${parent}`)).body.data.state, 'completed');
    assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(parent)!.reply, 'Parent done');
    assert.equal(db.prepare('SELECT stopped FROM execution_owners WHERE task=?').get(child)!.stopped, 1);
    await assert.rejects(runtime.startTask(child));
  } finally { db.close(); await f.close(); }
});

test('canonical workflow oversized handoff fails once without starving later runs', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const binding = randomUUID(), owner = (await f.send('/api/session')).body.data.accountId;
    db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','workflow-fixture','Fixture','ready',1)").run(binding, f.home.id, owner);
    db.prepare('UPDATE agent_authority SET provider_binding=?,revision=revision+1 WHERE agent=?').run(binding, f.agent);
    const graph = { entry: 'first', maxSteps: 3, nodes: [{ id: 'first', kind: 'agent', agent: f.agent, prompt: 'First', next: 'work' }, { id: 'work', kind: 'agent', agent: f.agent, prompt: 'x'.repeat(16000), next: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Oversized', graph })).status, 201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: '' })).status, 201);
    let current: any; await until(async () => { current = (await f.send(path)).body.data; return current.status === 'waiting'; });
    assert.equal((await runtime.runTask(current.steps[0].turn, () => ({ text: 'y'.repeat(250000) }))).state, 'completed');
    const later = randomUUID(), laterPath = `/api/projects/${project}/workflow-runs/${later}`;
    assert.equal((await f.send(detail + '/run', { requestId: later, id: later, revision: 1, input: 'Later' })).status, 201);
    await until(async () => (await f.send(path)).body.data.status === 'failed');
    assert.match((await f.send(path)).body.data.error, /Input langkah melebihi 256 KiB/);
    await until(async () => (await f.send(laterPath)).body.data.status === 'waiting');
    const revision = (await f.send(path)).body.data.revision; await f.restart();
    assert.equal((await f.send(path)).body.data.revision, revision);
  } finally { db.close(); await f.close(); }
});

test('canonical workflow capacity retries leave no empty threads before admission', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    const expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 }, payload = { v: 1, kind: 'direct', message: { text: 'Fill queue', files: [] } };
    for (let index = 0; index < 100; index++) {
      const requestId = randomUUID();
      assert.equal((await f.send('/api/tasks', { requestId, projectId: project, agentId: f.agent, homeDeviceId: f.home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', requestId, project, f.agent, f.home.id, payload, expectedRevisions]) })).status, 202);
    }
    const graph = { entry: 'work', maxSteps: 2, nodes: [{ id: 'work', kind: 'agent', agent: f.agent, prompt: 'Wait for capacity', next: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Capacity', graph })).status, 201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: '' })).status, 201);
    const edit = randomUUID(); assert.equal((await f.send(detail + '/edit', { requestId: edit, id: edit, revision: 1, name: 'Output', graph: f.graph })).status, 200);
    const later = randomUUID(), laterPath = `/api/projects/${project}/workflow-runs/${later}`;
    assert.equal((await f.send(detail + '/run', { requestId: later, id: later, revision: 2, input: 'Later' })).status, 201);
    await until(async () => (await f.send(laterPath)).body.data.status === 'done');
    assert.equal((await f.send(path)).body.data.status, 'ready');
    assert.equal(db.prepare('SELECT count(*) n FROM threads').get()!.n, 0, 'Queue backpressure must not persist empty workflow threads');
    const task = db.prepare('SELECT id,revision FROM tasks ORDER BY created LIMIT 1').get()!;
    assert.equal((await f.send(`/api/tasks/${task.id}/control`, { requestId: randomUUID(), expectedRevision: task.revision, operation: 'cancel' })).status, 200);
    await until(async () => (await f.send(path)).body.data.status === 'waiting');
    assert.equal(db.prepare('SELECT count(*) n FROM threads').get()!.n, 1);
  } finally { db.close(); await f.close(); }
});

test('canonical workflow revoked assignment before host ACK closes the original run', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite')), originalFetch = globalThis.fetch;
  try {
    const collaborator = (await f.send('/api/session', undefined, 'user_collaborator')).body.data.accountId;
    db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project, collaborator);
    db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(project, collaborator, f.agent);
    const graph = { entry: 'event', maxSteps: 2, nodes: [{ id: 'event', kind: 'wait', event: 'ready', timeoutSeconds: 60, next: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Revoked reservation', graph })).status, 201);
    const run = randomUUID(), path = `/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail + '/run', { requestId: run, id: run, revision: 1, input: '' }, 'user_collaborator')).status, 201);
    await until(() => !!db.prepare('SELECT 1 FROM wait_provisions WHERE target_key=?').get(JSON.stringify(['workflow', run, 1])));
    let revoked = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/wait-secret-results') && !revoked) { revoked = true; db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=?').run(project, collaborator); }
      return originalFetch(url, init);
    };
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    await until(() => !!db.prepare("SELECT 1 FROM wait_provisions WHERE state='closed' AND result_request_id IS NOT NULL").get());
    globalThis.fetch = originalFetch;
    db.prepare('UPDATE collaborator_agents SET enabled=1,revision=revision+1 WHERE project=? AND account=?').run(project, collaborator);
    assert.equal((await f.send(path)).body.data.status, 'failed');
    assert.equal((await f.send(path)).body.data.error, 'wait_invalid');
    assert.equal((await f.send(`/api/workflow-waits/${run}/1`)).status, 404);
    await f.restart(); assert.equal((await f.send(path)).body.data.status, 'failed'); assert.equal(db.prepare('SELECT count(*) n FROM wait_provisions').get()!.n, 1);
  } finally { globalThis.fetch = originalFetch; db.close(); await f.close(); }
});

test('canonical workflow wait reserves once offline and activates only after home keyring acknowledgement', async () => {
  const f = await workflowConfigurationFixture(), { workflow, project, list, detail, runtime } = f, db = new DatabaseSync(join(f.dir,'canonical.sqlite'));
  try {
    const graph={entry:'event',maxSteps:2,nodes:[{id:'event',kind:'wait',event:'ready',timeoutSeconds:60,next:'out'},{id:'out',kind:'output'}]};
    assert.equal((await f.send(list,{requestId:workflow,id:workflow,revision:0,name:'Protected wait',graph})).status,201);
    const run=randomUUID(),path=`/api/projects/${project}/workflow-runs/${run}`,waitPath=`/api/workflow-waits/${run}/1`;
    assert.equal((await f.send(detail+'/run',{requestId:run,id:run,revision:1,input:'Synthetic'})).status,201);
    await until(()=>!!db.prepare("SELECT 1 FROM wait_provisions WHERE target_key=?").get(JSON.stringify(['workflow',run,1])));
    const reservation=db.prepare("SELECT * FROM wait_provisions WHERE target_key=?").get(JSON.stringify(['workflow',run,1]))!;
    assert.equal((await f.send(path)).body.data.status,'ready'); assert.equal((await f.send(path)).body.data.stepCount,0);
    await f.restart();
    assert.deepEqual(db.prepare('SELECT * FROM wait_provisions WHERE id=?').get(reservation.id),reservation);
    const connection=runtime.connect();await until(()=>connection.state().phase==='connected');
    await until(async()=> (await f.send(waitPath)).body.data?.status==='waiting');
    const current=(await f.send(path)).body.data,wait=(await f.send(waitPath)).body.data;
    assert.equal(current.status,'waiting');assert.equal(current.stepCount,1);assert.equal(current.steps[0].node,'event');
    assert.equal(wait.deadline,reservation.deadline);assert.equal(wait.sourceDeviceId,f.home.id);assert.equal(wait.secretGeneration,1);
    assert.equal(Object.hasOwn(wait,'secret'),false);assert.equal(Object.hasOwn(wait,'secretRef'),false);
    assert(!db.prepare('PRAGMA table_info(workflow_waits)').all().some(row=>row.name==='secret'));
    const generation=connection.state().generation;await f.restart();await until(()=>connection.state().phase==='connected'&&connection.state().generation>generation);
    assert.equal((await f.send(path)).body.data.stepCount,1);assert.deepEqual((await f.send(waitPath)).body.data,wait);
    const cancel=randomUUID();assert.equal((await f.send(path+'/cancel',{requestId:cancel,id:cancel,revision:current.revision})).status,200);
    assert.equal((await f.send(waitPath)).body.data.status,'closed');
  } finally {db.close();await f.close();}
});

test('canonical workflow timeout fails offline reservation without generating a second wait', async () => {
  const f=await workflowConfigurationFixture(),{workflow,project,list,detail}=f,db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
  try{
    const graph={entry:'event',maxSteps:2,nodes:[{id:'event',kind:'wait',event:'ready',timeoutSeconds:1,next:'out'},{id:'out',kind:'output'}]};
    assert.equal((await f.send(list,{requestId:workflow,id:workflow,revision:0,name:'Timeout',graph})).status,201);
    const run=randomUUID(),path=`/api/projects/${project}/workflow-runs/${run}`;
    assert.equal((await f.send(detail+'/run',{requestId:run,id:run,revision:1,input:'Offline'})).status,201);
    await until(async()=> (await f.send(path)).body.data.status==='failed');
    const current=(await f.send(path)).body.data;
    assert.equal(current.error,'wait_expired');assert.equal(current.stepCount,1);assert.equal(current.steps[0].status,'failed');
    const before=db.prepare('SELECT * FROM wait_provisions').all();assert.equal(before.length,1);assert.equal(before[0].state,'closed');
    const connection=f.runtime.connect();await until(()=>connection.state().phase==='connected');
    assert.equal((await f.send(path)).body.data.status,'failed');assert.deepEqual(db.prepare('SELECT * FROM wait_provisions').all(),before);
    assert.equal((await f.send(`/api/workflow-waits/${run}/1`)).status,404);
  }finally{db.close();await f.close();}
});

test('canonical workflow channel output is atomic and does not duplicate after restart', async () => {
  const f=await workflowConfigurationFixture(),{workflow,project,list,detail}=f,db=new DatabaseSync(join(f.dir,'canonical.sqlite'));
  try{
    const owner=(await f.send('/api/session')).body.data.accountId,channel=randomUUID();
    db.prepare("INSERT INTO channels VALUES (?,?,'',?,1,0)").run(channel,'Workflow output',f.agent);db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);
    db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(canonicalJson([channel]),owner,project,channel);
    const graph={entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output',channel}]};
    assert.equal((await f.send(list,{requestId:workflow,id:workflow,revision:0,name:'Output',graph})).status,201);
    const run=randomUUID(),path=`/api/projects/${project}/workflow-runs/${run}`;
    db.exec("CREATE TRIGGER fail_workflow_output BEFORE INSERT ON record_scopes WHEN NEW.table_name='workflow_steps' BEGIN SELECT RAISE(ABORT,'output mapping failure'); END");
    assert.equal((await f.send(detail+'/run',{requestId:run,id:run,revision:1,input:'Exact result'})).status,201);
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal((await f.send(path)).body.data.status,'ready');assert.equal(db.prepare('SELECT count(*) n FROM turns WHERE channel=?').get(channel)!.n,0,'Failed step mapping rolls back channel output');
    db.exec('DROP TRIGGER fail_workflow_output');
    await until(async()=> (await f.send(path)).body.data.status==='done');
    const result=(await f.send(path)).body.data;assert.equal(result.last,'Exact result');assert(result.steps[0].turn);
    assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(result.steps[0].turn)!.reply,'Exact result');
    await f.restart();assert.equal((await f.send(path)).body.data.stepCount,1);assert.equal(db.prepare('SELECT count(*) n FROM turns WHERE channel=?').get(channel)!.n,1);
  }finally{db.close();await f.close();}
});

test('canonical workflow run admission keeps its graph and receipt across restart and revision changes', async () => {
  const f = await workflowConfigurationFixture(), { project, workflow, graph, list, detail } = f;
  try {
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Run', graph })).status, 201);
    const requestId = randomUUID(), command = { requestId, id: requestId, revision: 1, input: 'Original input' }, path = `/api/projects/${project}/workflow-runs/${requestId}`;
    const accepted = await f.send(detail + '/run', command); assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.id, requestId); assert.equal(accepted.body.data.homeDeviceId, f.home.id);
    const read = await f.send(path); assert.equal(read.status, 200); assert.deepEqual(read.body.data.graph, graph); assert.equal(read.body.data.input, command.input);
    const editId = randomUUID();
    assert.equal((await f.send(detail + '/edit', { requestId: editId, id: editId, revision: 1, name: 'Changed', graph: { ...graph, maxSteps: 2 } })).status, 200);
    await f.restart();
    const replay = await f.send(detail + '/run', command); assert.equal(replay.status, 200); assert.deepEqual(replay.body.receipt, accepted.body.receipt);
    assert.deepEqual((await f.send(path)).body.data.graph, graph); assert.equal((await f.send(path)).body.data.version, 1);
    assert.equal((await f.send(`/api/projects/${f.other}/workflow-runs/${requestId}`)).status, 404);
    const listed = (await f.send(detail + '/runs')).body.data; assert.deepEqual(listed.items.map((row:{id:string}) => row.id), [requestId]); assert.equal(listed.nextCursor, null);
    assert.equal((await f.send(detail + '/run', { ...command, input: 'Changed payload' })).status, 409);
    const staleId = randomUUID(); assert.equal((await f.send(detail + '/run', { ...command, requestId: staleId, id: staleId })).status, 409);
    const cancelId = randomUUID(), cancel = { requestId: cancelId, id: cancelId, revision: read.body.data.revision };
    const cancelled = await f.send(path + '/cancel', cancel); assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await f.send(path)).body.data.status, 'cancelled'); assert.deepEqual((await f.send(path + '/cancel', cancel)).body, cancelled.body);
    const nextId = randomUUID(); assert.equal((await f.send(path + '/cancel', { ...cancel, requestId: nextId, id: nextId })).status, 409);
    assert.equal((await f.send(`/api/workflow-runs/${requestId}?before=1`)).status, 404);
  } finally { await f.close(); }
});

test('canonical workflow runs deny revoked private and unmapped state and roll back controls with receipts', async () => {
  const f = await workflowConfigurationFixture(), { project, workflow, detail, list, agent } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    const graph = { entry: 'approve', maxSteps: 2, nodes: [{ id: 'approve', kind: 'approval', prompt: 'Accept?', yes: 'out' }, { id: 'out', kind: 'output' }] };
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Approval', graph })).status, 201);
    const owner = (await f.send('/api/session')).body.data.accountId, collaborator = (await f.send('/api/session', undefined, 'user_collaborator')).body.data.accountId;
    db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project, collaborator);
    db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(project, collaborator, agent);
    db.prepare('INSERT INTO response_policies VALUES (?,?,?,0,1)').run(project, collaborator, agent);
    const run = randomUUID(), command = { requestId: run, id: run, revision: 1, input: 'Approval input' }, path = `/api/projects/${project}/workflow-runs/${run}`;
    const accepted = await f.send(detail + '/run', command, 'user_collaborator'); assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=?').run(project, collaborator);
    assert.equal((await f.send(path, undefined, 'user_collaborator')).status, 404);
    assert.equal((await f.send(detail + '/run', command, 'user_collaborator')).status, 404);
    assert.equal((await f.send(detail + '/runs', undefined, 'user_collaborator')).status, 404);
    db.prepare('UPDATE collaborator_agents SET enabled=1,revision=revision+1 WHERE project=? AND account=?').run(project, collaborator);
    db.prepare("UPDATE record_scopes SET visibility='owner',account=? WHERE table_name='workflow_runs' AND key_json=?").run(owner, JSON.stringify([run]));
    assert.equal((await f.send(path, undefined, 'user_collaborator')).status, 404); assert.deepEqual((await f.send(detail + '/runs', undefined, 'user_collaborator')).body.data.items, []);
    db.prepare("UPDATE record_scopes SET visibility='project' WHERE table_name='workflow_runs' AND key_json=?").run(JSON.stringify([run]));
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(f.other, JSON.stringify([workflow, 1]));
    assert.equal((await f.send(path)).status, 404); assert.equal((await f.send(detail + '/run', command, 'user_collaborator')).status, 404);
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(project, JSON.stringify([workflow, 1]));
    db.prepare("INSERT INTO workflow_steps(run,seq,node,status,settings) VALUES (?,1,'approve','approval',?)").run(run, JSON.stringify(graph.nodes[0]));
    db.prepare("UPDATE workflow_runs SET steps=1,status='approval',revision=2 WHERE id=?").run(run);
    const approvalId = randomUUID(), approval = { requestId: approvalId, id: approvalId, revision: 2, accepted: true };
    assert.equal((await f.send(path + '/approve', approval)).status, 404, 'Unmapped step cannot be approved');
    const cancellationId = randomUUID(); assert.equal((await f.send(path + '/cancel', { requestId: cancellationId, id: cancellationId, revision: 2 })).status, 404, 'Unmapped step cannot be cancelled');
    db.prepare("INSERT INTO record_scopes VALUES ('workflow_steps',?,?,?,'project','workflow',?)").run(JSON.stringify([run, 1]), collaborator, project, workflow);
    db.exec("CREATE TRIGGER fail_run_receipt BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'retained:%/workflow-runs/%/approve' BEGIN SELECT RAISE(ABORT,'run receipt failure'); END");
    assert.equal((await f.send(path + '/approve', approval)).status, 500);
    assert.equal((await f.send(path)).body.data.status, 'approval'); assert.equal((await f.send(path)).body.data.steps[0].status, 'approval');
    db.exec('DROP TRIGGER fail_run_receipt');
    const approved = await f.send(path + '/approve', approval); assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await f.send(path)).body.data.status, 'ready'); assert.equal((await f.send(path)).body.data.cursor, 'out');
    await f.restart(); assert.deepEqual((await f.send(path + '/approve', approval)).body, approved.body);
    const staleId = randomUUID(); assert.equal((await f.send(path + '/approve', { ...approval, requestId: staleId, id: staleId })).status, 409);
    const failedId = randomUUID(), failed = { ...command, requestId: failedId, id: failedId };
    db.exec("CREATE TRIGGER fail_run_mapping BEFORE INSERT ON record_scopes WHEN NEW.table_name='workflow_runs' BEGIN SELECT RAISE(ABORT,'run mapping failure'); END");
    assert.equal((await f.send(detail + '/run', failed)).status, 500); assert.equal(db.prepare('SELECT count(*) n FROM workflow_runs WHERE id=?').get(failedId)!.n, 0); assert.equal(db.prepare('SELECT count(*) n FROM receipts WHERE request_id=?').get(failedId)!.n, 0);
    db.exec('DROP TRIGGER fail_run_mapping'); assert.equal((await f.send(detail + '/run', failed)).status, 201);
    for (const query of ['projectId=' + project, 'before=0', 'before=1&before=2', 'before=x']) assert.equal((await f.send(detail + '/runs?' + query)).status, 404);
    assert.equal((await f.send(path + '?after=0')).status, 404);
    assert.equal((await f.send(path + '/cancel', { requestId: randomUUID(), id: randomUUID(), revision: 3, projectId: project })).status, 404);
  } finally { db.close(); await f.close(); }
});

test('canonical workflow run and step pages preserve old approvals and admission rolls back failed receipts', async () => {
  const f = await workflowConfigurationFixture(), { project, workflow, graph, detail, list } = f, db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    assert.equal((await f.send(list, { requestId: workflow, id: workflow, revision: 0, name: 'Pages', graph })).status, 201);
    const runs: string[] = [];
    for (let index = 0; index < 23; index++) {
      const requestId = randomUUID(); runs.push(requestId);
      assert.equal((await f.send(detail + '/run', { requestId, id: requestId, revision: 1, input: String(index) })).status, 201);
    }
    const first = (await f.send(detail + '/runs')).body.data, second = (await f.send(detail + '/runs?before=' + first.nextCursor)).body.data;
    assert.equal(first.items.length, 20); assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map((row:{id:string}) => row.id), runs.toReversed());
    const run = runs[0], path = `/api/projects/${project}/workflow-runs/${run}`, owner = (await f.send('/api/session')).body.data.accountId;
    for (let seq = 1; seq <= 21; seq++) {
      db.prepare("INSERT INTO workflow_steps(run,seq,node,status) VALUES (?,?,?,'approval')").run(run, seq, 'out');
      db.prepare("INSERT INTO record_scopes VALUES ('workflow_steps',?,?,?,'project','workflow',?)").run(JSON.stringify([run, seq]), owner, project, workflow);
    }
    const steps = (await f.send(path)).body.data, tail = (await f.send(path + '?after=' + steps.nextCursor)).body.data;
    assert.equal(steps.steps.length, 20); assert.equal(tail.steps.length, 1); assert.equal(tail.nextCursor, null); assert.equal(tail.steps[0].seq, 21);
    const requestId = randomUUID(), command = { requestId, id: requestId, revision: 1, input: 'Atomic' };
    db.exec("CREATE TRIGGER fail_run_receipt BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'retained:%/workflows/%/run' BEGIN SELECT RAISE(ABORT,'run receipt failure'); END");
    assert.equal((await f.send(detail + '/run', command)).status, 500);
    assert.equal(db.prepare('SELECT count(*) n FROM workflow_runs WHERE id=?').get(requestId)!.n, 0); assert.equal(db.prepare("SELECT count(*) n FROM record_scopes WHERE table_name='workflow_runs' AND key_json=?").get(JSON.stringify([requestId]))!.n, 0);
    db.exec('DROP TRIGGER fail_run_receipt'); assert.equal((await f.send(detail + '/run', command)).status, 201);
    const foreign = (await f.send('/api/session', undefined, 'user_stranger')).body.data.accountId;
    db.prepare('UPDATE installations SET account=? WHERE id=(SELECT installation FROM devices WHERE id=?)').run(foreign, f.home.id);
    const foreignId = randomUUID(); assert.equal((await f.send(detail + '/run', { ...command, requestId: foreignId, id: foreignId })).status, 404, 'Device installation must belong to its account');
    assert.equal(db.prepare('SELECT count(*) n FROM workflow_runs WHERE id=?').get(foreignId)!.n, 0); assert.equal(db.prepare('SELECT count(*) n FROM receipts WHERE request_id=?').get(foreignId)!.n, 0);
    db.prepare('UPDATE installations SET account=? WHERE id=(SELECT installation FROM devices WHERE id=?)').run(owner, f.home.id);
    db.prepare("UPDATE devices SET status='revoked' WHERE id=?").run(f.home.id);
    const deniedId = randomUUID(); assert.equal((await f.send(detail + '/run', { ...command, requestId: deniedId, id: deniedId })).status, 404);
    assert.equal((await f.send(detail + '/run', command)).status, 200, 'Revoked device never re-dispatches an already accepted command');
  } finally { db.close(); await f.close(); }
});

test('canonical workflow configuration stays project scoped with immutable versions and retry receipts', async () => {
  const f = await workflowConfigurationFixture(), { home, project, other, workflow, graph, list, detail } = f;
  try {
    const command = { requestId: workflow, id: workflow, revision: 0, name: 'Original', graph };
    const created = await f.send(list, command); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.projectId, project); assert.equal(created.body.data.homeDeviceId, home.id);
    const replay = await f.send(list, command); assert.equal(replay.status, 200); assert.deepEqual(replay.body.receipt, created.body.receipt);
    assert.deepEqual((await f.send(detail)).body.data.graph, graph);
    assert.deepEqual((await f.send(`/api/projects/${other}/workflows`)).body.data.items, []);
    assert.equal((await f.send(`/api/projects/${other}/workflows/${workflow}`)).status, 404);
    assert.equal((await f.send(`/api/projects/${other}/agents/${f.agent}`, { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 0, rules: 'Separate', capabilities: { v: 1, tools: [], resources: [] } }, 'user_owner', 'PUT')).status, 201);
    const otherWorkflow = randomUUID();
    assert.equal((await f.send(`/api/projects/${other}/agents/${f.agent}/workflows`, { ...command, requestId: otherWorkflow, id: otherWorkflow, name: 'Other project' })).status, 201);
    assert.deepEqual((await f.send(`/api/projects/${other}/workflows`)).body.data.items.map((row:{id:string}) => row.id), [otherWorkflow]);
    assert.equal((await f.send(`/api/projects/${other}/workflows/${workflow}`)).status, 404, 'Same agent participation cannot transfer workflows');
    assert.equal((await f.send(`/api/workflows/${workflow}`)).status, 404);
    for (const path of ['/api/workflows?deleted=1', `/api/agents/${f.agent}/workflows?after=${workflow}`, `/api/workflows/${workflow}/versions?before=2`, detail + '/run?before=2']) assert.equal((await f.send(path)).status, 404, path);
    const edited = { requestId: randomUUID(), revision: 1, name: 'Edited', graph: { ...graph, maxSteps: 2 } };
    const saved = await f.send(detail + '/edit', { ...edited, id: edited.requestId }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await f.restart();
    assert.deepEqual((await f.send(detail + '/edit', { ...edited, id: edited.requestId })).body.receipt, saved.body.receipt);
    const versions = (await f.send(detail + '/versions')).body.data.items;
    assert.deepEqual(versions.map((row: {revision:number}) => row.revision), [2, 1]); assert.deepEqual(versions[1].graph, graph);
    const restore = { requestId: randomUUID(), revision: 2, version: 1 };
    assert.equal((await f.send(detail + '/restore', { ...restore, id: restore.requestId })).body.data.revision, 3);
    const deletion = { requestId: randomUUID(), revision: 3 };
    const deleted = await f.send(detail + '/delete', { ...deletion, id: deletion.requestId }); assert.equal(deleted.status, 200);
    assert.deepEqual((await f.send(detail + '/delete', { ...deletion, id: deletion.requestId })).body.receipt, deleted.body.receipt);
    assert.deepEqual((await f.send(`/api/projects/${project}/workflows`)).body.data.items, []);
    assert.equal((await f.send(`/api/projects/${project}/workflows?deleted=1`)).body.data.items[0].id, workflow);
    const runId = randomUUID(); assert.equal((await f.send(detail + '/run', { requestId: runId, id: runId, revision: 3, input: 'Must not execute' })).status, 404);
  } finally { await f.close(); }
});

test('canonical workflows enforce current assignments private mappings selectors and atomic receipt storage', async () => {
  const f = await workflowConfigurationFixture(), { project, other, agent, workflow, graph, list, detail } = f;
  const command = { requestId: workflow, id: workflow, revision: 0, name: 'Shared', graph };
  const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
  try {
    const accepted = await f.send(list, command); assert.equal(accepted.status, 201);
    const collaborator = (await f.send('/api/session', undefined, 'user_collaborator')).body.data.accountId;
    db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project, collaborator);
    assert.equal((await f.send(detail, undefined, 'user_collaborator')).status, 404);
    assert.deepEqual((await f.send(`/api/projects/${project}/workflows`, undefined, 'user_collaborator')).body.data.items, []);
    db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(project, collaborator, agent);
    db.prepare('INSERT INTO response_policies VALUES (?,?,?,0,1)').run(project, collaborator, agent);
    assert.equal((await f.send(detail, undefined, 'user_collaborator')).status, 200, 'Response OFF does not remove workflow assignment');
    const edit = { requestId: randomUUID(), revision: 1, name: 'Collaborator edit', graph };
    const edited = await f.send(detail + '/edit', { ...edit, id: edit.requestId }, 'user_collaborator'); assert.equal(edited.status, 200);
    db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=? AND agent=?').run(project, collaborator, agent);
    assert.equal((await f.send(detail + '/edit', { ...edit, id: edit.requestId }, 'user_collaborator')).status, 404, 'Revoked assignment cannot replay a receipt');
    db.prepare('UPDATE collaborator_agents SET enabled=1,revision=revision+1 WHERE project=? AND account=? AND agent=?').run(project, collaborator, agent);
    const owner = (await f.send('/api/session')).body.data.accountId;
    db.prepare("UPDATE record_scopes SET visibility='owner' WHERE table_name='workflows' AND key_json=?").run(JSON.stringify([workflow]));
    assert.equal((await f.send(detail, undefined, 'user_collaborator')).status, 404);
    db.prepare("UPDATE record_scopes SET visibility='project' WHERE table_name='workflows' AND key_json=?").run(JSON.stringify([workflow]));
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(other, JSON.stringify([workflow, 2]));
    assert.equal((await f.send(detail)).status, 404, 'Unmapped version does not return graph');
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(project, JSON.stringify([workflow, 2]));
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(other, JSON.stringify([workflow, 1]));
    assert.equal((await f.send(list, command)).status, 404, 'Receipt cannot return a graph whose version scope was removed');
    db.prepare("UPDATE record_scopes SET project=? WHERE table_name='workflow_versions' AND key_json=?").run(project, JSON.stringify([workflow, 1]));
    for (const query of ['projectId=' + project, 'after=x', 'after=', 'deleted=x', 'deleted=0&deleted=0']) {
      const path = query === 'after=' ? detail : `/api/projects/${project}/workflows`;
      const denied = await f.send(path + '?' + query); assert.equal(denied.status, 404, JSON.stringify(denied.body));
    }
    const headerResponse = await fetch(f.origin() + detail, { headers: { Authorization: 'Bearer ' + f.jwt(), 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID(), 'X-Briefsip-Project-Id': project } });
    assert.equal(headerResponse.status, 404); await headerResponse.body?.cancel();
    assert.equal((await f.send(detail + '/edit', { ...edit, id: edit.requestId, projectId: project })).status, 404);
    assert.equal((await f.send(detail + '/edit', { ...edit, requestId: randomUUID(), id: randomUUID() })).status, 400);
    assert.equal((await f.send(list, { ...command, name: 'Different' })).status, 409);
    assert.equal((await f.send(list, { ...command, name: ' Shared ' })).status, 200, 'Digest uses normalized feature name');
    const bad = randomUUID(), foreignGraph = { entry: 'work', maxSteps: 2, nodes: [{ id: 'work', kind: 'agent', agent: bad, prompt: 'foreign', next: 'out' }, ...graph.nodes] };
    assert.equal((await f.send(list, { ...command, id: bad, requestId: bad, graph: foreignGraph })).status, 400);
    const teammate = randomUUID();
    assert.equal((await f.send('/api/agents', { requestId: teammate, id: teammate, name: 'Other agent', model: 'fixture', backupModel: '', instructions: 'Help', threadLimit: 2, projectId: project, homeDeviceId: f.home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: f.home.revision, providerBinding: null })).status, 201);
    assert.equal((await f.send(list, { ...command, id: bad, requestId: bad, graph: { ...foreignGraph, nodes: [{ ...foreignGraph.nodes[0], agent: teammate }, ...graph.nodes] } }, 'user_collaborator')).status, 404, 'Every graph agent needs current assignment');
    const channel = randomUUID();
    db.prepare("INSERT INTO channels VALUES (?,?,'',?,1,0)").run(channel, 'Other project', agent); db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel, agent);
    db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]), owner, other, channel);
    assert.equal((await f.send(list, { ...command, id: bad, requestId: bad, graph: { ...graph, nodes: [{ id: 'out', kind: 'output', channel }] } })).status, 404);
    const change = { requestId: randomUUID(), revision: 2, name: 'Atomic', graph };
    db.exec("CREATE TRIGGER fail_workflow_receipt BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'retained:%/workflows/%/edit' BEGIN SELECT RAISE(ABORT,'workflow receipt failure'); END;");
    assert.equal((await f.send(detail + '/edit', { ...change, id: change.requestId })).status, 500);
    assert.equal((await f.send(detail)).body.data.name, 'Collaborator edit');
    assert.deepEqual((await f.send(detail + '/versions')).body.data.items.map((row: {revision:number}) => row.revision), [2,1]);
    db.exec('DROP TRIGGER fail_workflow_receipt');
    assert.equal((await f.send(detail + '/edit', { ...change, id: change.requestId })).status, 200);
    assert.equal(db.prepare('SELECT count(*) n FROM receipts WHERE request_id=?').get(change.requestId)!.n, 1);
    db.exec("CREATE TRIGGER fail_workflow_mapping BEFORE INSERT ON record_scopes WHEN NEW.table_name='workflow_versions' BEGIN SELECT RAISE(ABORT,'workflow mapping failure'); END;");
    assert.equal((await f.send(list, { ...command, requestId: bad, id: bad })).status, 500);
    assert.equal((await f.send(`/api/projects/${project}/workflows/${bad}`)).status, 404);
    assert.equal((await f.send(`/api/projects/${project}/workflows`)).body.data.items.length, 1, 'Failed mapping leaves no partial workflow');
    db.exec('DROP TRIGGER fail_workflow_mapping');
    assert.equal((await f.send(list, { ...command, requestId: bad, id: bad })).status, 201);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name IN('workflow_webhooks','workflow_schedules')").get()!.n, 0, 'Canonical startup never installs legacy schedule tables');
    assert(!db.prepare('PRAGMA table_info(workflow_waits)').all().some(row=>row.name==='secret'),'Canonical waits contain protected references only');
    db.prepare('UPDATE project_members SET deleted=1,grant_revision=grant_revision+1 WHERE project=? AND account=?').run(project, collaborator);
    assert.equal((await f.send(detail, undefined, 'user_collaborator')).status, 404);
    assert.equal((await f.send(detail, undefined, 'user_stranger')).status, 404);
    assert.equal(db.prepare('SELECT account FROM projects WHERE id=?').get(project)!.account, owner);
  } finally { db.close(); await f.close(); }
});

test('canonical workflow pages bound graph bytes and preserve list and version cursors', async () => {
  const f = await workflowConfigurationFixture(), { project, agent, workflow, graph, list, detail } = f;
  try {
    for (const id of [workflow, ...Array.from({ length: 22 }, () => randomUUID())]) assert.equal((await f.send(list, { requestId: id, id, revision: 0, name: 'Paged', graph })).status, 201);
    const first = (await f.send(`/api/projects/${project}/workflows`)).body.data; assert.equal(first.items.length, 20); assert(first.nextCursor);
    const second = (await f.send(`/api/projects/${project}/workflows?after=${first.nextCursor}`)).body.data;
    assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 23);
    const large = { entry: 'work', maxSteps: 2, nodes: [{ id: 'work', kind: 'agent', agent, prompt: '🦉'.repeat(7000), next: 'out' }, ...graph.nodes] };
    for (let revision = 1; revision <= 10; revision++) { const id = randomUUID(); assert.equal((await f.send(detail + '/edit', { requestId: id, id, revision, name: 'Large versions', graph: large })).status, 200); }
    const versions: number[] = []; let before = '';
    do {
      const response = await f.send(detail + '/versions' + (before ? '?before=' + before : '')); assert.equal(response.status, 200);
      assert(Buffer.byteLength(JSON.stringify(response.body)) <= 256 * 1024);
      versions.push(...response.body.data.items.map((row: {revision:number}) => row.revision)); before = response.body.data.nextCursor ?? '';
    } while (before);
    assert.deepEqual(versions, [11,10,9,8,7,6,5,4,3,2,1]);
    for (const query of ['before=0','before=-1','before=abc','before=1&before=2','projectId=' + project]) assert.equal((await f.send(detail + '/versions?' + query)).status, 404);
  } finally { await f.close(); }
});

test('signed human sync preserves delta cursors through canonical restart and rejects foreign or revoked reads', async () => {
  const f = await fixture();
  try {
    const project = randomUUID(), create = { requestId: randomUUID(), id: project, name: 'Sync project' };
    assert.equal((await f.send('/api/projects', create)).status, 201);
    const path = '/api/sync?projectId=' + project, first = await f.send(path);
    assert.equal(first.status, 200); assert(first.body.data.nextCursor);
    const edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Persisted sync value' };
    const saved = await f.send('/api/projects/' + project, edit, 'user_owner', 'PATCH'); assert.equal(saved.status, 200);
    assert.deepEqual((await f.send('/api/projects/' + project, edit, 'user_owner', 'PATCH')).body.receipt, saved.body.receipt);
    await f.restart();
    const deltaPath = path + '&cursor=' + encodeURIComponent(first.body.data.nextCursor), delta = await f.send(deltaPath);
    assert.equal(delta.status, 200); assert.equal(delta.body.data.page.events.length, 1); assert.equal(delta.body.data.page.events[0].body.name, 'Persisted sync value');
    assert.equal((await f.send(deltaPath, undefined, 'user_stranger')).status, 403);
    for (const suffix of ['&cursor=', '&page=broken', '&repo=private', '&projectId=' + project]) assert.equal((await f.send(path + suffix)).status, 400);
    const denied = await f.send('/api/projects/' + project, { requestId: randomUUID(), expectedRevision: 2, deleted: true }, 'user_owner', 'PATCH');
    assert.equal(denied.status, 200);
    const revoked = await f.send(deltaPath); assert.equal(revoked.status, 403); assert.equal(revoked.body.ok, false); assert.equal(revoked.body.data, undefined);
  } finally { await f.close(); }
});

async function loopTask(f: Awaited<ReturnType<typeof fixture>>, runtime: ReturnType<typeof openDeviceRuntime>, setup = false, existingBinding?: string | null) {
  const home = (await f.send('/api/devices')).body.data.find((row: { id: string }) => row.id === runtime.deviceId()), project = randomUUID(), agent = randomUUID(), binding = existingBinding === undefined ? randomUUID() : existingBinding;
  assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Execution loop' })).status, 201);
  if (existingBinding === undefined) {
    const seed = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try { seed.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible',?,'Synthetic','ready',1)").run(binding, home.id, seed.prepare('SELECT account FROM devices WHERE id=?').get(home.id)!.account, binding); } finally { seed.close(); }
  }
  assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Loop agent', model: 'fixture', backupModel: '', instructions: 'Answer carefully', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: binding ? { bindingId: binding, expectedRevision: 1 } : null, setup })).status, 201);
  const taskId = setup ? agent : randomUUID();
  if (!setup) {
    const payload = { v: 1, kind: 'direct', message: { text: 'Answer once', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) })).status, 202);
  }
  return { taskId, agent, project, binding };
}

test('signed task and device mutations publish atomic scoped observations across retry and restart', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'sync-home.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    const project = randomUUID(); assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Device sync' })).status, 201);
    const path = '/api/sync?projectId=' + project, first = (await f.send(path)).body.data;
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0];
    const deviceDelta = (await f.send(path + '&cursor=' + encodeURIComponent(first.nextCursor))).body.data;
    assert.deepEqual(deviceDelta.page.events.map((event: any) => [event.recordKind, event.body.status]), [['device','offline'],['device','connecting'],['device','ready']]);
    assert(!JSON.stringify(deviceDelta).includes('signingPublicKey')); assert(!JSON.stringify(deviceDelta).includes('deviceSession'));
    const agent = randomUUID();
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Sync agent', model: 'fixture', backupModel: '', instructions: 'Private profile canary', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: null })).status, 201);
    const before = (await f.send(path)).body.data, taskId = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Private prompt canary', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    const command = { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) };
    const accepted = await f.send('/api/tasks', command); assert.equal(accepted.status, 202); assert.deepEqual((await f.send('/api/tasks', command)).body.receipt, accepted.body.receipt);
    assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: 1, operation: 'pause' })).status, 200);
    const cancellation = { requestId: randomUUID(), expectedRevision: 2, operation: 'cancel' }, inspect = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      inspect.exec("CREATE TRIGGER fail_task_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='task' BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
      assert.equal((await f.send(`/api/tasks/${taskId}/control`, cancellation)).status, 500);
      assert.equal((await f.send(`/api/tasks/${taskId}`)).body.data.state, 'paused');
      inspect.exec('DROP TRIGGER fail_task_sync');
    } finally { inspect.close(); }
    const cancelled = await f.send(`/api/tasks/${taskId}/control`, cancellation); assert.equal(cancelled.status, 200);
    assert.deepEqual((await f.send(`/api/tasks/${taskId}/control`, cancellation)).body.receipt, cancelled.body.receipt);
    const deltaPath = path + '&cursor=' + encodeURIComponent(before.nextCursor), delta = (await f.send(deltaPath)).body.data;
    assert.deepEqual(delta.page.events.map((event: any) => [event.recordId,event.revision,event.body.state]), [[taskId,1,'queued'],[taskId,2,'paused'],[taskId,3,'cancelled']]);
    assert(!JSON.stringify(delta).includes('canary')); assert(!JSON.stringify(delta).includes(command.payloadDigest));
    const completed = await loopTask(f, runtime), completedPath = '/api/sync?projectId=' + completed.project, queued = (await f.send(completedPath)).body.data;
    await runtime.runTask(completed.taskId, () => ({ text: 'Private result canary' }));
    const completionDelta = (await f.send(completedPath + '&cursor=' + encodeURIComponent(queued.nextCursor))).body.data;
    assert.equal(completionDelta.page.events.at(-1).body.state, 'completed'); assert(completionDelta.page.events.some((event: any) => event.body.state === 'running')); assert(!JSON.stringify(completionDelta).includes('Private result canary'));
    const failure = new DatabaseSync(join(f.dir,'canonical.sqlite'));
    try {
      failure.exec("CREATE TRIGGER fail_device_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='device' BEGIN SELECT RAISE(ABORT,'synthetic offline event failure'); END");
      await connection.stop(); assert.equal((await f.send('/api/session')).status,200);
      failure.exec('DROP TRIGGER fail_device_sync');
    } finally { failure.close(); }
    await until(async () => (await f.send('/api/devices')).body.data[0].status === 'offline');
    await f.restart();
    await until(async () => { try { return (await f.send(deltaPath)).status === 200; } catch { return false; } });
    assert.deepEqual((await f.send(deltaPath)).body.data.page.events.filter((event: any) => event.recordKind === 'task'), delta.page.events);
    assert.equal((await f.send(deltaPath, undefined, 'user_stranger')).status, 403);
  } finally { await runtime.close(); await f.close(); }
});

test('home execution loop publishes one provider answer through signed canonical HTTP', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'loop.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const { taskId } = await loopTask(f, runtime); let calls = 0;
    const provider = (context: ActionContext) => {
      calls++;
      assert.equal(context.snapshotRef?.digest, sha256(canonicalJson(context.snapshot)));
      for (const tool of context.snapshot.tools as { function: { name: string } }[]) assert(!['read_attachment','create_text_file','publish_site','delegate_task'].includes(tool.function.name));
      return { text: 'Canonical loop answer' };
    };
    assert.equal((await runtime.runTask(taskId, provider)).state, 'completed');
    assert.equal((await runtime.runTask(taskId, provider)).state, 'completed');
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(detail.state, 'completed'); assert.deepEqual(detail.results.map((row: { content: unknown }) => row.content), [{ text: 'Canonical loop answer' }]);
    assert.equal(calls, 1);
  } finally { await runtime.close(); await f.close(); }
});

test('home execution loop saves setup tools, pauses for answers and continues without repeating saved provider output', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'setup-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const { taskId } = await loopTask(f, runtime, true); let calls = 0;
    const provider = (context: { snapshot: Record<string, unknown> }) => {
      calls++;
      if (calls === 1) return { toolCall: { id: 'question', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Research or writing?', choices: ['Research', 'Writing'] }) } } };
      assert.match(JSON.stringify(context.snapshot.conversation), /Research/);
      if (calls === 2) return { toolCall: { id: 'profile', function: { name: 'edit_profile', arguments: JSON.stringify({ revision: 1, name: 'Researcher', instructions: 'Research carefully' }) } } };
      assert.equal((context.snapshot.profile as { name: string }).name, 'Loop agent');
      assert.match(JSON.stringify(context.snapshot.toolJournal), /Researcher/);
      return { text: 'Research profile saved' };
    };
    assert.equal((await runtime.runTask(taskId, provider)).state, 'paused'); assert.equal(calls, 1);
    const paused = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal((await f.send(`/api/tasks/${taskId}/questions/${paused.questions[0].id}/answer`, { requestId: randomUUID(), expectedRevision: paused.revision, text: 'Research' })).status, 200);
    assert.equal((await runtime.runTask(taskId, provider)).state, 'completed'); assert.equal(calls, 3);
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data; assert.equal(detail.results.length, 5);
    assert.deepEqual(detail.results[3].content, { name: 'Researcher', instructions: 'Research carefully', revision: 2 });
  } finally { await runtime.close(); await f.close(); }
});

test('home execution loop rejects malformed or unadvertised provider outputs and never retries uncertain effects', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'invalid-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const call = { id: 'bad', function: { name: 'not_advertised', arguments: '{}' } };
    for (const output of [{ text: '' }, { text: 'Mixed', toolCall: call }, { toolCall: call }, { toolCall: { ...call, function: { name: 'ask_user', arguments: 'not json' } } }, { unexpected: 'bad' }]) {
      const { taskId } = await loopTask(f, runtime); let calls = 0;
      const provider = () => { calls++; return output; };
      await assert.rejects(runtime.runTask(taskId, provider), (error: unknown) => error instanceof ProtocolError && error.code === 'provider_result_invalid');
      assert.equal((await runtime.runTask(taskId, provider)).state, 'uncertain'); assert.equal(calls, 1);
      const detail = (await f.send(`/api/tasks/${taskId}`)).body.data; assert.equal(detail.state, 'uncertain'); assert.deepEqual(detail.results, []);
    }
  } finally { await runtime.close(); await f.close(); }
});

test('home execution loop resumes saved provider output after completion reply loss without another provider call', async () => {
  const f = await fixture(), keys = memoryKeys(), database = join(f.dir, 'loop-restart.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry }), originalFetch = globalThis.fetch, calls = 0;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const { taskId } = await loopTask(f, runtime); const provider = () => { calls++; return { text: 'Restart-safe answer' }; };
    let lost = true;
    globalThis.fetch = async (url, init) => { const response = await originalFetch(url, init); if (lost && String(url).endsWith('/complete')) { lost = false; await response.body?.cancel(); throw new Error('Lost completion reply'); } return response; };
    await assert.rejects(runtime.runTask(taskId, provider), /Lost completion reply/); globalThis.fetch = originalFetch;
    await runtime.close(); runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
    const resumed = runtime.connect(); await until(() => resumed.state().phase === 'connected');
    assert.equal((await runtime.runTask(taskId, () => { calls++; return { text: 'WRONG' }; })).state, 'completed');
    assert.equal(calls, 1); assert.deepEqual((await f.send(`/api/tasks/${taskId}`)).body.data.results.map((row: { content: unknown }) => row.content), [{ text: 'Restart-safe answer' }]);
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('home execution loop survives SIGKILL across provider and tool results without replaying effects', { timeout: 30000 }, async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'killed-loop.sqlite'), keys = join(f.dir, 'loop-keys.json');
  const runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry }), calls = new Map<string, number>();
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { snapshot } = JSON.parse(body); calls.set(snapshot.taskId, (calls.get(snapshot.taskId) ?? 0) + 1);
    res.end(JSON.stringify(snapshot.toolJournal.some((row: { kind: string; result: { name?: string } }) => row.result?.name === 'Saved by loop') ? { text: 'Saved profile once' } : { toolCall: { id: 'profile', function: { name: 'edit_profile', arguments: JSON.stringify({ revision: 1, name: 'Saved by loop', instructions: 'Retain saved changes' }) } } }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing provider fixture address'); const providerOrigin = `http://127.0.0.1:${address.port}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await runtime.enroll(f.jwt()); await runtime.close(); writeFileSync(keys, JSON.stringify(Object.fromEntries(store.values)), { mode: 0o600 });
    async function launch(taskId: string, checkpoint?: string) {
      child = spawn(process.execPath, ['--experimental-strip-types', 'recovery-fixture.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, BRIEFSIP_RECOVERY_FIXTURE: JSON.stringify({ mode: 'loop', database, keys, server: f.origin(), effect: providerOrigin, taskId, checkpoint }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let errors = ''; child.stderr!.on('data', chunk => { errors += chunk; }); const exited = once(child, 'exit');
      const message = await Promise.race([once(child, 'message').then(([message]) => message), exited.then(() => { throw new Error(`Loop fixture exited: ${errors}`); })]);
      return { child, exited, message };
    }
    for (const checkpoint of ['provider-not-sent', 'canonical-not-sent', 'provider-saved', 'tool-reply', 'tool-report', 'provider-in-flight']) {
      const { taskId } = await loopTask(f, runtime), running = await launch(taskId, checkpoint); assert.equal(running.message.checkpoint, checkpoint);
      running.child.kill('SIGKILL'); assert.equal((await running.exited)[1], 'SIGKILL'); await f.restart();
      for (let restart = 0; restart < 2; restart++) {
        const recovered = await launch(taskId); assert.equal(recovered.message.state, checkpoint === 'provider-in-flight' ? 'uncertain' : 'completed'); assert.equal((await recovered.exited)[0], 0);
        assert.equal(calls.get(taskId), checkpoint === 'provider-in-flight' ? 1 : 2);
      }
      const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
      assert.equal(detail.results.length, checkpoint === 'provider-in-flight' ? 0 : 3);
      if (checkpoint !== 'provider-in-flight') assert.deepEqual(detail.results[1].content, { name: 'Saved by loop', instructions: 'Retain saved changes', revision: 2 });
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runtime.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await f.close();
  }
});

test('home execution loop uses explicit uncertainty retry reservation and never retries before that decision', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'risk-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const { taskId } = await loopTask(f, runtime); let calls = 0;
    await assert.rejects(runtime.runTask(taskId, () => { calls++; throw new Error('Provider reply lost'); }), /Provider reply lost/);
    const recovered = await runtime.recoverPending(); assert.equal(recovered[0].state, 'uncertain');
    assert.equal((await runtime.runTask(taskId, () => { calls++; return { text: 'MUST NOT CALL' }; })).state, 'uncertain'); assert.equal(calls, 1);
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data, requestId = randomUUID();
    const decision = await f.send(`/api/tasks/${taskId}/control`, { requestId, expectedRevision: detail.revision, operation: 'resolve_uncertain', decision: { kind: 'retry_with_risk', actionId: recovered[0].actionId, acknowledgement: 'effect_may_have_happened', reason: 'Synthetic provider output lost; retry explicitly approved' } });
    assert.equal(decision.status, 200); assert.equal(decision.body.data.replacementActionId, requestId);
    assert.equal((await runtime.runTask(taskId, () => { calls++; return { text: 'Approved replacement answer' }; })).state, 'completed'); assert.equal(calls, 2);
    const completed = (await f.send(`/api/tasks/${taskId}`)).body.data; assert.equal(completed.results[0].actionId, requestId); assert.deepEqual(completed.results[0].content, { text: 'Approved replacement answer' });
  } finally { await runtime.close(); await f.close(); }
});

test('home execution loop consumes resolved late-known output without repeating its provider call', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'known-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry }), originalFetch = globalThis.fetch;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const { taskId } = await loopTask(f, runtime); let calls = 0, prepared: Record<string, any> = {}, lastReport: Record<string, any> = {};
    globalThis.fetch = async (url, init) => { const path = new URL(String(url)).pathname; if (path.endsWith('/prepare')) prepared = { ...JSON.parse(String(init!.body)), actionId: path.split('/').at(-2) }; if (path.endsWith('/reconcile')) lastReport = JSON.parse(String(init!.body)); return originalFetch(url, init); };
    await assert.rejects(runtime.runTask(taskId, () => { calls++; throw new Error('Reply lost'); }), /Reply lost/); await runtime.recoverPending();
    const resultContent = { toolCall: { id: 'settings', function: { name: 'read_provider_settings', arguments: '{}' } } }, encoded = canonicalJson(resultContent), resultRef = { v: 1, taskId, actionId: prepared.actionId, digest: sha256(encoded), size: Buffer.byteLength(encoded), encoding: 'canonical-json-v1' }, evidenceRequestId = randomUUID();
    await runtime.reconcileTask(taskId, { requestId: evidenceRequestId, actionId: prepared.actionId, ownership: prepared.ownership, payloadDigest: prepared.payloadDigest, state: 'reported', effectStatus: 'known', journalSequence: lastReport.journalSequence + 1, resultDigest: resultRef.digest, resultRef, resultContent });
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: detail.revision, operation: 'resolve_uncertain', decision: { kind: 'known_result', actionId: prepared.actionId, evidenceRequestId, resultRef } })).status, 200);
    globalThis.fetch = originalFetch;
    assert.equal((await runtime.runTask(taskId, context => { calls++; assert.match(JSON.stringify(context.snapshot.toolJournal), /configured/); return { text: 'Known tool choice retained' }; })).state, 'completed'); assert.equal(calls, 2);
    assert.equal((await f.send(`/api/tasks/${taskId}`)).body.data.results.length, 3);
    const home = (await f.send('/api/devices')).body.data.find((row: { id: string }) => row.id === runtime.deviceId());
    assert.equal((await f.send(`/api/devices/${home.id}/revoke`, { requestId: randomUUID(), expectedRevision: home.revision })).status, 200);
    await connection.stop();
    const recovery = await f.send(`/api/tasks/${taskId}/recovery-session`, { requestId: randomUUID(), expectedAuthorityGeneration: prepared.ownership.authorityGeneration, sourceDeviceId: home.id, sourceDeviceGeneration: prepared.ownership.deviceGeneration });
    assert.equal(recovery.status, 201);
    const exported = runtime.exportRecovery(taskId, [String(prepared.actionId)], randomUUID(), recovery.body.data.recoveryGeneration, true);
    const response = await fetch(f.origin() + `/api/tasks/${taskId}/recovery-results`, { method: 'POST', headers: { Authorization: `Bearer ${f.jwt()}`, Origin: f.origin(), 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': exported.requestId, 'X-Briefsip-Recovery': recovery.body.data.session }, body: JSON.stringify(exported) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(exported.envelope.entries[0].effectStatus, 'known');
    assert.deepEqual(exported.envelope.entries[0].resultRef, resultRef); assert.deepEqual(exported.resultContent, resultContent);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('home execution loop persists provider wait across reply loss and preserves concurrent pause', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'wait-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry }), originalFetch = globalThis.fetch;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const missing = await loopTask(f, runtime, false, null);
    globalThis.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (String(url).endsWith('/wait-provider')) { await response.body?.cancel(); throw new Error('Lost provider wait reply'); }
      return response;
    };
    await assert.rejects(runtime.runTask(missing.taskId, () => assert.fail('No provider binding')), /Lost provider wait reply/);
    globalThis.fetch = originalFetch;
    const waiting = (await f.send(`/api/tasks/${missing.taskId}`)).body.data;
    assert.equal(waiting.state, 'waiting_resource');
    assert.equal((await runtime.runTask(missing.taskId, () => assert.fail('No provider binding'))).state, 'waiting_resource');
    assert.equal((await f.send(`/api/tasks/${missing.taskId}`)).body.data.revision, waiting.revision);
    const paused = await loopTask(f, runtime, false, null);
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/wait-provider')) {
        const detail = (await f.send(`/api/tasks/${paused.taskId}`)).body.data;
        assert.equal((await f.send(`/api/tasks/${paused.taskId}/control`, { requestId: randomUUID(), expectedRevision: detail.revision, operation: 'pause' })).status, 200);
      }
      return originalFetch(url, init);
    };
    await assert.rejects(runtime.runTask(paused.taskId, () => assert.fail('Paused task must not dispatch')), (error: unknown) => error instanceof ProtocolError && error.code === 'stale_revision');
    assert.equal((await f.send(`/api/tasks/${paused.taskId}`)).body.data.state, 'paused');
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

test('home execution loop holds missing bindings and enforces provider slots before dispatch', async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'capacity-loop.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  const releases: (() => void)[] = [], running: Promise<unknown>[] = [];
  const hold = () => new Promise<unknown>(resolve => { releases.push(() => resolve({ text: 'Released answer' })); });
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const missing = await loopTask(f, runtime, false, null);
    assert.equal((await runtime.runTask(missing.taskId, () => assert.fail('Missing binding must not dispatch'))).state, 'waiting_resource');
    assert.equal((await f.send(`/api/tasks/${missing.taskId}`)).body.data.state, 'waiting_resource');
    const first = await loopTask(f, runtime); running.push(runtime.runTask(first.taskId, hold)); await until(() => releases.length === 1);
    await assert.rejects(runtime.runTask(first.taskId, hold), (error: unknown) => error instanceof ProtocolError && error.code === 'executor_busy');
    const same = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Same agent/project', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    assert.equal((await f.send('/api/tasks', { requestId: same, projectId: first.project, agentId: first.agent, homeDeviceId: runtime.deviceId(), payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', same, first.project, first.agent, runtime.deviceId(), payload, expectedRevisions]) })).status, 202);
    assert.equal((await runtime.runTask(same, () => assert.fail('Same agent/project must wait'))).state, 'waiting_capacity');
    const second = await loopTask(f, runtime, false, first.binding); running.push(runtime.runTask(second.taskId, hold)); await until(() => releases.length === 2);
    const third = await loopTask(f, runtime, false, first.binding); assert.equal((await runtime.runTask(third.taskId, () => assert.fail('Third binding call must wait'))).state, 'waiting_capacity');
    for (let count = 2; count < 4; count++) { const task = await loopTask(f, runtime); running.push(runtime.runTask(task.taskId, hold)); await until(() => releases.length === count + 1); }
    const fifth = await loopTask(f, runtime); assert.equal((await runtime.runTask(fifth.taskId, () => assert.fail('Fifth host call must wait'))).state, 'waiting_capacity');
    // Refill the real 40-proof/2s device budget before releasing four held calls.
    await new Promise(resolve => setTimeout(resolve, 2000));
    releases.forEach(release => release()); await Promise.all(running);
    assert.equal((await runtime.runTask(same, () => ({ text: 'Later same-agent answer' }))).state, 'completed');
  } finally { releases.forEach(release => release()); await Promise.allSettled(running); await runtime.close(); await f.close(); }
});

for (const lostAt of ['request', 'reply', 'receipt', 'revoked', 'storage'] as const) test(`canonical completion recovery handles ${lostAt} without another provider call`, async () => {
  const f = await fixture(), keys = memoryKeys(), database = join(f.dir, 'completion-home.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await runtime.enroll(f.jwt());
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), agent = randomUUID(), binding = randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Completion' })).status, 201);
    const seed = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try { seed.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','synthetic-completion','Synthetic','ready',1)").run(binding, home.id, seed.prepare('SELECT account FROM devices WHERE id=?').get(home.id)!.account); } finally { seed.close(); }
    assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Writer', model: 'fixture', backupModel: '', instructions: 'Answer carefully', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: { bindingId: binding, expectedRevision: 1 } })).status, 201);
    const taskId = randomUUID(), payload = { v: 1, kind: 'direct', message: { text: 'Answer once', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
    assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) })).status, 202);
    const owned = await runtime.startTask(taskId), context = await runtime.taskContext(taskId, owned.ownership, owned.revision), actionId = randomUUID();
    await runtime.executeAction({ taskId, actionId, sequence: 0, actionKind: 'provider', ownership: owned.ownership, payload: { purpose: 'answer' }, context, grantRevision: 1, bindingId: binding, bindingRevision: 1 }, () => { calls++; return { text: 'Saved final answer' }; });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/complete') && ['request', 'revoked', 'storage'].includes(lostAt)) throw new Error('Lost completion request');
      const response = await originalFetch(url, init);
      if (String(url).endsWith('/complete')) {
        assert.equal(response.status, 200, await response.clone().text());
        if (lostAt === 'receipt') { const body = await response.json(); body.receipt.payloadDigest = '0'.repeat(64); return Response.json(body); }
        await response.body?.cancel(); throw new Error('Lost completion reply');
      }
      return response;
    };
    await assert.rejects(runtime.completeTask(taskId, actionId), lostAt === 'receipt' ? (error: unknown) => error instanceof ProtocolError && error.code === 'receipt_mismatch' : /Lost completion/);
    globalThis.fetch = originalFetch;
    if (lostAt === 'revoked' || lostAt === 'storage') {
      const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
      try { db.prepare('UPDATE agent_projects SET deleted=1 WHERE project=? AND agent=?').run(project, agent); } finally { db.close(); }
    }
    await runtime.close(); await f.restart();
    if (lostAt === 'storage') {
      const db = new DatabaseSync(database);
      try { db.exec("CREATE TRIGGER fail_recovery_marker BEFORE UPDATE OF intent_json ON device_journal WHEN json_extract(NEW.intent_json,'$.completionError') IS NOT NULL BEGIN SELECT RAISE(ABORT,'completion marker write failed'); END"); } finally { db.close(); }
    }
    runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
    const reconnected = runtime.connect(); await until(() => reconnected.state().phase === 'connected');
    await until(() => runtime.recoveryStatus().results.some(row => row.actionId === actionId && (lostAt === 'storage' ? row.error === 'recovery_storage_unavailable' : lostAt === 'revoked' ? row.error === 'execution_denied' : row.state === 'completed')));
    if (lostAt === 'storage') {
      const db = new DatabaseSync(database);
      try { db.exec('DROP TRIGGER fail_recovery_marker'); } finally { db.close(); }
      assert.deepEqual(await runtime.recoverPending(), [{ taskId, actionId, error: 'execution_denied' }]);
    }
    if (lostAt === 'revoked' || lostAt === 'storage') {
      assert.deepEqual(await runtime.recoverPending(), []);
      await runtime.close();
      runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
      const restarted = runtime.connect(); await until(() => restarted.state().phase === 'connected');
      assert.deepEqual(await runtime.recoverPending(), []);
      const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
      try {
        assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(taskId)!.reply, null);
        db.prepare('UPDATE agent_projects SET deleted=0 WHERE project=? AND agent=?').run(project, agent);
      } finally { db.close(); }
    }
    const completed = await runtime.completeTask(taskId, actionId);
    assert.equal(completed.data.state, 'completed');
    assert.deepEqual((await runtime.completeTask(taskId, actionId)).receipt, completed.receipt);
    const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
    assert.equal(detail.state, 'completed'); assert.equal(detail.results.length, 1); assert.equal(calls, 1);
    assert.deepEqual(await runtime.recoverPending(), []);
    await runtime.close();
    runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: keys.entry });
    const restarted = runtime.connect(); await until(() => restarted.state().phase === 'connected');
    assert.deepEqual(await runtime.recoverPending(), []);
    const inspect = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      const row = inspect.prepare('SELECT status,reply,paused FROM turns WHERE id=?').get(taskId)!;
      assert.deepEqual({ ...row }, { status: 'done', reply: 'Saved final answer', paused: 0 });
      assert.equal(inspect.prepare('SELECT count(*) n FROM receipts WHERE scope=?').get(`tasks:complete:${taskId}`)!.n, 1);
    } finally { inspect.close(); }
    assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: detail.revision, operation: 'resume' })).status, 409);
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});

for (const scenario of ['pause', 'cancel', 'latest', 'invalid', 'setup', 'revoked'] as const) test(`canonical completion enforces ${scenario} through signed HTTP`, async () => {
  const f = await fixture(), keys = memoryKeys(), runtime = openDeviceRuntime({ database: join(f.dir, 'completion-controls.sqlite'), server: f.origin(), development: true, entry: keys.entry });
  const protocolCode = (expected: string) => (error: unknown) => error instanceof ProtocolError && error.code === expected;
  try {
    await runtime.enroll(f.jwt()); const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
    const home = (await f.send('/api/devices')).body.data[0], project = randomUUID(), binding = randomUUID(), agent = randomUUID(), taskId = scenario === 'setup' ? agent : randomUUID();
    assert.equal((await f.send('/api/projects', { requestId: randomUUID(), id: project, name: 'Completion controls' })).status, 201);
    const db = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','completion-controls','Synthetic','ready',1)").run(binding, home.id, db.prepare('SELECT account FROM devices WHERE id=?').get(home.id)!.account);
      assert.equal((await f.send('/api/agents', { requestId: agent, id: agent, name: 'Writer', model: 'fixture', backupModel: '', instructions: 'Answer carefully', threadLimit: 2, projectId: project, homeDeviceId: home.id, expectedProjectRevision: 1, expectedHomeDeviceRevision: home.revision, providerBinding: { bindingId: binding, expectedRevision: 1 }, setup: scenario === 'setup' })).status, 201);
      if (scenario !== 'setup') {
        const payload = { v: 1, kind: 'direct', message: { text: 'Answer once', files: [] } }, expectedRevisions = { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 };
        assert.equal((await f.send('/api/tasks', { requestId: taskId, projectId: project, agentId: agent, homeDeviceId: home.id, payload, expectedRevisions, payloadDigest: digestCommand(['briefsip-task-payload-v1', taskId, project, agent, home.id, payload, expectedRevisions]) })).status, 202);
      }
      const owned = await runtime.startTask(taskId); let sequence = 0;
      const run = async (content: unknown, canonical = false) => {
        const detail = (await f.send(`/api/tasks/${taskId}`)).body.data, context = await runtime.taskContext(taskId, owned.ownership, detail.revision), actionId = randomUUID();
        await runtime.executeAction({ taskId, actionId, sequence: sequence++, actionKind: canonical ? 'canonical' : 'provider', ownership: owned.ownership, payload: canonical ? { toolCall: { id: actionId, function: { name: 'edit_profile', arguments: JSON.stringify(content) } }, expectedRevision: context.snapshot.taskRevision + 1 } : { purpose: 'answer' }, context, grantRevision: 1, ...(!canonical ? { bindingId: binding, bindingRevision: 1 } : {}) }, () => { assert(!canonical); return content; });
        return actionId;
      };
      const actionId = await run(scenario === 'invalid' ? { text: ' ', extra: true } : { text: 'Saved answer' });
      if (scenario === 'pause' || scenario === 'cancel') {
        const control = async (operation: string) => {
          const detail = (await f.send(`/api/tasks/${taskId}`)).body.data;
          assert.equal((await f.send(`/api/tasks/${taskId}/control`, { requestId: randomUUID(), expectedRevision: detail.revision, operation })).status, 200);
        };
        await control(scenario); await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode(scenario === 'pause' ? 'task_not_runnable' : 'ownership_conflict'));
        assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(taskId)!.reply, null);
        if (scenario === 'pause') { await control('resume'); await runtime.completeTask(taskId, actionId); }
      } else if (scenario === 'invalid') await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('result_invalid'));
      else if (scenario === 'revoked') {
        db.prepare('UPDATE agent_projects SET deleted=1 WHERE project=? AND agent=?').run(project, agent);
        await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('execution_denied'));
        db.prepare('UPDATE agent_projects SET deleted=0 WHERE project=? AND agent=?').run(project, agent);
        const completed = await runtime.completeTask(taskId, actionId);
        db.prepare('UPDATE agent_projects SET deleted=1 WHERE project=? AND agent=?').run(project, agent);
        await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('execution_denied'));
        assert.equal(db.prepare('SELECT state,revision FROM tasks WHERE id=?').get(taskId)!.revision, completed.data.revision);
        assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(taskId)!.reply, 'Saved answer');
      }
      else if (scenario === 'setup') {
        await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('setup_incomplete'));
        await run({ revision: 1, name: 'Research partner', instructions: 'Cite evidence' }, true);
        await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('outcome_unresolved'));
        await runtime.completeTask(taskId, await run({ text: 'Profile saved' }));
        assert.equal(db.prepare('SELECT status FROM turns WHERE id=?').get(taskId)!.status, 'done');
      } else {
        const latest = await run({ text: 'Latest answer' }); await assert.rejects(runtime.completeTask(taskId, actionId), protocolCode('outcome_unresolved'));
        db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE OF reply ON turns BEGIN SELECT RAISE(ABORT,'completion write failed'); END");
        await assert.rejects(runtime.completeTask(taskId, latest));
        assert.equal(db.prepare('SELECT count(*) n FROM receipts WHERE scope=?').get(`tasks:complete:${taskId}`)!.n, 0);
        assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId)!.state, 'running');
        db.exec('DROP TRIGGER fail_completion'); await runtime.completeTask(taskId, latest);
        assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(taskId)!.reply, 'Latest answer');
      }
    } finally { db.close(); }
  } finally { await runtime.close(); await f.close(); }
});

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
