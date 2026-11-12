import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanActor } from './auth.ts';
import { initializeCanonicalSchema, initializeDeviceSchema } from './schema.ts';
import { openExecutorJournal, type ActionContext } from './executor-journal.ts';
import { createProjectAccess } from './project-access.ts';
import { createDevices, parseLinkChallenge, deviceLinkBody, descriptorBody, type DeviceDescriptor } from './devices.ts';
import { canonicalJson, digestCommand, sha256, ProtocolError } from './protocol.ts';
import { createTaskRecovery, parseTaskCommand, parseOwnership, journalEntryBody, stopEvidenceBody, type StopEvidence, type JournalEntry } from './task-recovery.ts';

async function fixture() {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db);
  const actor = (subject: string): HumanActor => ({ accountId: randomUUID(), issuer: 'https://fixture.example', subject, sessionId: `sess_${subject}`, expiresAt: Date.now() + 60000 });
  const owner = actor('owner'), member = actor('member'), foreign = actor('foreign');
  for (const a of [owner, member, foreign]) db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(a.accountId, a.issuer, a.subject, Date.now());
  const auth = { requireCurrent(a: HumanActor) { if (db.prepare('SELECT blocked FROM accounts WHERE id=?').get(a.accountId)?.blocked !== 0) throw new ProtocolError(401, 'session_invalid', 'Denied'); return a; }, async verifiedMailboxes() { return []; } };
  const access = createProjectAccess(db, auth, () => { throw new Error('No mail'); });
  const devices = createDevices(db, auth), signing = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const encoded = (key: typeof signing.publicKey) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
  const candidate = parseLinkChallenge({ requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(), mode: 'new', installationPublicKey: encoded(installation.publicKey), deviceSigningKey: encoded(signing.publicKey), deviceEncryptionKey: encoded(encryption.publicKey), deviceLabel: 'Home', requestedCapabilities: ['execution'], zone: 'Asia/Jakarta', zoneRevision: 1 });
  const challenge = devices.createChallenge(owner, candidate, owner.accountId), bytes = Buffer.from(JSON.stringify(deviceLinkBody(candidate, challenge)));
  const descriptor: Omit<DeviceDescriptor, 'signature'> = { v: 1, accountId: owner.accountId, installationId: candidate.installationId, deviceId: candidate.deviceId, authorityGeneration: challenge.authorityGeneration, deviceGeneration: 1, keyRevision: 1, zone: candidate.zone, zoneRevision: 1, signingPublicKey: candidate.deviceSigningKey, encryptionPublicKey: candidate.deviceEncryptionKey };
  devices.link(owner, { requestId: randomUUID(), challengeId: challenge.challengeId, nonce: challenge.nonce, installationSignature: sign(null, bytes, installation.privateKey).toString('base64url'), deviceSignature: sign(null, bytes, signing.privateKey).toString('base64url'), descriptor: { ...descriptor, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(descriptor))), signing.privateKey).toString('base64url') } }, owner.accountId);
  const project = randomUUID(), agent = randomUUID(), home = candidate.deviceId;
  access.createProject(owner, { requestId: randomUUID(), id: project, name: 'A' });
  await access.createAgent(owner, { requestId: agent, id: agent, name: 'Agent', model: 'fixture', backupModel: '', instructions: 'Research', threadLimit: 2, projectId: project, homeDeviceId: home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null });
  db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project, member.accountId);
  const tasks = createTaskRecovery(db, auth, access, devices);
  function command(change: Record<string, unknown> = {}) {
    const c = { requestId: randomUUID(), projectId: project, agentId: agent, homeDeviceId: home, payload: { v: 1, kind: 'direct', message: { text: 'Research this', files: [] } }, expectedRevisions: { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 }, ...change };
    return { ...c, payloadDigest: digestCommand(['briefsip-task-payload-v1', c.requestId, c.projectId, c.agentId, c.homeDeviceId, c.payload, c.expectedRevisions]) };
  }
  const principal = { deviceId: home, accountId: owner.accountId, generation: 1, authorityGeneration: challenge.authorityGeneration };
  return { db, owner, member, foreign, project, agent, home, tasks, access, devices, command, signing, principal, close() { devices.close(); db.close(); } };
}
const code = (expected: string) => (error: unknown) => error instanceof ProtocolError && error.code === expected;

async function preparedTask() {
  const f = await fixture(), command = f.command();
  f.tasks.admit(f.owner, command);
  const taskId = command.requestId, token = randomBytes(32).toString('base64url');
  const lockProof = { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') };
  const acquired = f.tasks.acquire(f.principal, { requestId: randomUUID(), taskId, previousExecutorGeneration: 0, executorTokenHash: sha256(token), lockProof }, token);
  const ownership = parseOwnership(acquired.data.ownership), taskRevision = acquired.receipt.recordRevision;
  const context = f.tasks.context(f.principal, taskId, { requestId: randomUUID(), ownership, expectedTaskRevision: taskRevision }, token);
  const ref = context.data.snapshotRef as { snapshotId: string; digest: string }, actionId = randomUUID(), payloadDigest = sha256('read');
  const intentDigest = digestCommand([taskId,actionId,0,ownership,payloadDigest,'read',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
  f.tasks.prepare(f.principal, taskId, actionId, { requestId: randomUUID(), sequence: 0, ownership, payloadDigest, actionKind: 'read', contextSnapshotId: ref.snapshotId, contextDigest: ref.digest, grantRevision: 1, expectedTaskRevision: taskRevision, journalSequence: 1, intentDigest }, token);
  const commit = { requestId: randomUUID(), ownership, intentDigest, expectedTaskRevision: taskRevision, journalSequence: 1 };
  return { ...f, taskId, token, ownership, actionId, payloadDigest, lockProof, commit, context };
}

test('local journal locks sole runner and retains immutable intent/result until exact ACK', async () => {
  const f=await preparedTask(), db=new DatabaseSync(':memory:'), dir=mkdtempSync(join(tmpdir(),'briefsip-executor-journal-'));
  initializeDeviceSchema(db);db.prepare("INSERT INTO device_state VALUES (1,?,?,?,0,0,'[]')").run(f.home,f.ownership.authorityGeneration,1);
  const journal=openExecutorJournal(db,dir);
  try {
    assert.throws(()=>openExecutorJournal(db,dir),error=>error instanceof ProtocolError&&error.code==='executor_busy');
    const context=f.context.data as ActionContext;
    const input={taskId:f.taskId,actionId:f.actionId,sequence:0,actionKind:'read' as const,ownership:f.ownership,payload:{operation:'read'},context,grantRevision:1};
    const staged=journal.stage(input);assert.equal(staged.state,'prepared');assert.equal(staged.send_marker,0);
    assert.deepEqual(journal.stage(input),staged);
    assert.throws(()=>journal.stage({...input,payload:{operation:'other'}}),error=>error instanceof ProtocolError&&error.code==='action_conflict');
    assert.throws(()=>journal.markSend(f.actionId),error=>error instanceof ProtocolError&&error.code==='dispatch_forbidden');
    journal.committed(f.actionId);assert.equal(journal.markSend(f.actionId).send_marker,1);
    assert.throws(()=>journal.markSend(f.actionId),error=>error instanceof ProtocolError&&error.code==='dispatch_forbidden');
    const content={text:'Once only'},result=journal.outcome(f.actionId,content);assert.equal(result.state,'reported');
    assert.equal(journal.resultRef(result).digest,sha256(canonicalJson(content)));
    assert.throws(()=>journal.outcome(f.actionId,{text:'Changed'}),error=>error instanceof ProtocolError&&error.code==='result_conflict');
    assert.throws(()=>journal.acknowledge(f.actionId,{requestId:randomUUID(),recordId:f.actionId,committedAt:Date.now()}),error=>error instanceof ProtocolError&&error.code==='receipt_mismatch');
    const receipt={requestId:JSON.parse(String(result.intent_json)).reportRequestId,recordId:f.actionId,projectId:f.project,payloadDigest:journal.reportDigest(f.actionId),status:200,recordRevision:1,committedAt:Date.now()};
    assert.equal(journal.acknowledge(f.actionId,receipt).state,'acknowledged');
    assert.equal(journal.acknowledge(f.actionId,receipt).state,'acknowledged');
  } finally {journal.close();db.close();f.close();rmSync(dir,{recursive:true,force:true});}
});

test('committed result survives lost ACK, revocation and offline history without granting dispatch', async () => {
  const f = await preparedTask();
  try {
    f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const resultContent = { text: 'Saved answer' }, resultDigest = sha256(canonicalJson(resultContent));
    const resultRef = { v: 1, taskId: f.taskId, actionId: f.actionId, digest: resultDigest, size: Buffer.byteLength(canonicalJson(resultContent)), encoding: 'canonical-json-v1' };
    const report = { requestId: randomUUID(), actionId: f.actionId, ownership: f.ownership, payloadDigest: f.payloadDigest, state: 'acknowledged', effectStatus: 'known', journalSequence: 2, resultDigest, resultRef, resultContent };
    f.db.prepare('UPDATE project_members SET deleted=1 WHERE project=? AND account=?').run(f.project, f.owner.accountId);
    const saved = f.tasks.reconcile(f.principal, f.taskId, report, f.token);
    assert.equal(saved.data.actionState, 'acknowledged');
    assert.equal(saved.data.dispatchable, false);
    assert.deepEqual(f.tasks.reconcile(f.principal, f.taskId, report, f.token), saved);
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, resultContent: { text: 'Changed' } }, f.token), code('result_digest_mismatch'));
    assert.throws(() => f.tasks.lookup(f.owner, f.taskId), code('resource_not_found'));
    f.db.prepare('UPDATE project_members SET deleted=0 WHERE project=? AND account=?').run(f.project, f.owner.accountId);
    const detail = f.tasks.lookup(f.owner, f.taskId);
    assert.deepEqual((detail.data.results as { content: unknown }[])[0].content, resultContent);
    const context = f.tasks.context(f.principal, f.taskId, { requestId: randomUUID(), ownership: f.ownership, expectedTaskRevision: saved.receipt.recordRevision }, f.token);
    assert.equal((context.data.snapshot as { toolJournal: unknown[] }).toolJournal.length, 1);
  } finally { f.close(); }
});

test('not-sent and uncertain reports require verifiable evidence and cannot resurrect cancelled work', async () => {
  const f = await preparedTask();
  try {
    f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const report = { requestId: randomUUID(), actionId: f.actionId, ownership: f.ownership, payloadDigest: f.payloadDigest, state: 'not_sent', effectStatus: 'none', journalSequence: 2 };
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, report, f.token), code('stop_evidence_required'));
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, noMarkerEvidence: {}, stopEvidence: {} }, f.token), code('invalid_stop_evidence'));
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, state: 'uncertain', effectStatus: 'unknown' }, f.token), code('uncertain_reason_required'));
    f.db.prepare("UPDATE tasks SET state='cancelled',revision=revision+1 WHERE id=?").run(f.taskId);
    const saved = f.tasks.reconcile(f.principal, f.taskId, { ...report, state: 'uncertain', effectStatus: 'unknown', uncertainReason: 'Provider response lost' }, f.token);
    assert.equal(saved.data.taskState, 'cancelled');
    assert.equal(saved.data.actionState, 'uncertain');
  } finally { f.close(); }
});

test('signed no-marker evidence reconciles original owner before acquire and altered proofs fail closed', async () => {
  const f = await preparedTask();
  try {
    f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const entry: JournalEntry = { taskId: f.taskId, actionId: f.actionId, sequence: 0, executorGeneration: 1, actionKind: 'read', payloadDigest: f.payloadDigest, intentDigest: f.commit.intentDigest, grantRevision: 1, state: 'not_sent', effectStatus: 'none', journalSequence: 2 };
    const entryBytes = Buffer.from(JSON.stringify(journalEntryBody(f.ownership.authorityGeneration, f.home, 1, entry)));
    const noMarkerEvidence = { entry, signature: sign(null, entryBytes, f.signing.privateKey).toString('base64url') };
    const stop: Omit<StopEvidence,'signature'> = { v: 1, sourceAuthority: f.ownership.authorityGeneration, taskId: f.taskId, actionId: f.actionId, sourceDeviceId: f.home, sourceDeviceGeneration: 1, executorGeneration: 1, bootId: f.lockProof.bootId, processId: f.lockProof.processId, processStart: f.lockProof.processStart, lockId: f.lockProof.lockId, observationBootId: f.lockProof.bootId, observation: 'process_exited', children: [], observedAt: Date.now(), journalDigest: sha256(entryBytes) };
    const stopEvidence = { ...stop, signature: sign(null, Buffer.from(JSON.stringify(stopEvidenceBody(stop))), f.signing.privateKey).toString('base64url') };
    const report = { requestId: randomUUID(), actionId: f.actionId, ownership: f.ownership, payloadDigest: f.payloadDigest, state: 'not_sent', effectStatus: 'none', journalSequence: 2, noMarkerEvidence, stopEvidence };
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, stopEvidence: { ...stopEvidence, processStart: '1000' } }, f.token), code('stop_evidence_invalid'));
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, noMarkerEvidence: { ...noMarkerEvidence, entry: { ...entry, intentDigest: '0'.repeat(64) } } }, f.token), code('stop_evidence_invalid'));
    const accepted = f.tasks.reconcile(f.principal, f.taskId, report, f.token);
    assert.equal(accepted.data.actionState, 'not_sent');
    assert.deepEqual(f.tasks.reconcile(f.principal, f.taskId, report, f.token), accepted);
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { ...report, stopEvidence: { ...stopEvidence, observedAt: Date.now() + 1000000 } }, f.token), code('payload_conflict'));
    const acquire = { requestId: randomUUID(), taskId: f.taskId, previousExecutorGeneration: 1, executorTokenHash: sha256(f.token), lockProof: { ...f.lockProof, lockId: randomUUID(), reconciledThrough: 3 } };
    assert.throws(() => f.tasks.acquire(f.principal, acquire, f.token), code('ownership_conflict'));
    const next = f.tasks.acquire(f.principal, { ...acquire, lockProof: { ...acquire.lockProof, reconciledThrough: 2 } }, f.token);
    assert.equal(parseOwnership(next.data.ownership).executorGeneration, 2);
    assert.throws(() => f.tasks.context(f.principal, f.taskId, { requestId: randomUUID(), ownership: f.ownership, expectedTaskRevision: next.receipt.recordRevision }, f.token), code('ownership_conflict'));
  } finally { f.close(); }
});

test('progress reports advance monotonically, immutable result publishes once and prepare sees changed context', async () => {
  const f = await preparedTask();
  try {
    f.access.editAgentRules(f.owner, f.project, f.agent, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'New rules' });
    assert.throws(() => f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token), code('context_stale'));
  } finally { f.close(); }
  const g = await preparedTask();
  try {
    g.tasks.commit(g.principal, g.taskId, g.actionId, g.commit, g.token);
    const progress = { requestId: randomUUID(), actionId: g.actionId, ownership: g.ownership, payloadDigest: g.payloadDigest, state: 'in_flight', effectStatus: 'unknown', journalSequence: 2 };
    const saved = g.tasks.reconcile(g.principal, g.taskId, progress, g.token);
    assert.equal(saved.data.actionState, 'in_flight');
    const resultContent = { text: 'Done' }, resultDigest = sha256(canonicalJson(resultContent));
    const report = { ...progress, requestId: randomUUID(), state: 'reported', effectStatus: 'known', journalSequence: 3, resultContent, resultDigest, resultRef: { v: 1, taskId: g.taskId, actionId: g.actionId, digest: resultDigest, size: Buffer.byteLength(canonicalJson(resultContent)), encoding: 'canonical-json-v1' } };
    const published = g.tasks.reconcile(g.principal, g.taskId, report, g.token);
    assert.deepEqual(g.tasks.reconcile(g.principal, g.taskId, progress, g.token), saved);
    assert.deepEqual(g.tasks.reconcile(g.principal, g.taskId, report, g.token), published);
    assert.equal(g.tasks.reconcile(g.principal, g.taskId, { ...report, requestId: randomUUID(), state: 'acknowledged', journalSequence: 4 }, g.token).data.actionState, 'acknowledged');
    assert.throws(() => g.tasks.reconcile(g.principal, g.taskId, { ...report, requestId: randomUUID(), journalSequence: 5 }, g.token), code('action_conflict'));
    assert.throws(() => g.tasks.reconcile(g.principal, g.taskId, { ...progress, requestId: randomUUID(), journalSequence: 5 }, g.token), code('payload_conflict'));
  } finally { g.close(); }
});

test('task controls use current scope and revisions, keep cancellation terminal and resolve no effects implicitly', async () => {
  const f = await preparedTask();
  try {
    const pause = { requestId: randomUUID(), expectedRevision: f.commit.expectedTaskRevision, operation: 'pause' };
    const paused = f.tasks.control(f.owner, f.taskId, pause);
    assert.equal(paused.data.state, 'paused');
    assert.deepEqual(f.tasks.control(f.owner, f.taskId, pause).data, paused.data);
    assert.throws(() => f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token), code('task_not_runnable'));
    assert.throws(() => f.tasks.control(f.foreign, f.taskId, { ...pause, requestId: randomUUID() }), code('resource_not_found'));
    const cancelled = f.tasks.control(f.owner, f.taskId, { requestId: randomUUID(), expectedRevision: paused.receipt.recordRevision, operation: 'cancel' });
    assert.equal(cancelled.data.state, 'cancelled');
    assert.throws(() => f.tasks.control(f.owner, f.taskId, { requestId: randomUUID(), expectedRevision: cancelled.receipt.recordRevision, operation: 'resume' }), code('task_terminal'));
  } finally { f.close(); }
});

test('owner risk resolution reserves one replacement and cannot erase unknown original effect', async () => {
  const f = await preparedTask();
  try {
    f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const uncertain = f.tasks.reconcile(f.principal, f.taskId, { requestId: randomUUID(), actionId: f.actionId, ownership: f.ownership, payloadDigest: f.payloadDigest, state: 'uncertain', effectStatus: 'unknown', journalSequence: 2, uncertainReason: 'Response lost' }, f.token);
    const decision = { requestId: randomUUID(), expectedRevision: uncertain.receipt.recordRevision, operation: 'resolve_uncertain', decision: { kind: 'retry_with_risk', actionId: f.actionId, acknowledgement: 'effect_may_have_happened', reason: 'Owner checked service' } };
    const resolved = f.tasks.control(f.owner, f.taskId, decision);
    assert.equal(resolved.data.replacementActionId, decision.requestId);
    assert.deepEqual(f.tasks.control(f.owner, f.taskId, decision).data, resolved.data);
    assert.throws(() => f.tasks.control(f.owner, f.taskId, { ...decision, requestId: randomUUID() }), code('resolution_conflict'));
    assert.equal(f.db.prepare('SELECT state FROM task_actions WHERE id=?').get(f.actionId)!.state, 'uncertain');
    assert.throws(() => f.db.prepare('DELETE FROM task_action_resolutions WHERE action=?').run(f.actionId), /immutable task resolution/);
    const nextOwnership = parseOwnership(f.tasks.acquire(f.principal, { requestId: randomUUID(), taskId: f.taskId, previousExecutorGeneration: 1, executorTokenHash: sha256(f.token), lockProof: { ...f.lockProof, lockId: randomUUID(), reconciledThrough: 2 } }, f.token).data.ownership);
    const task = f.tasks.lookup(f.owner, f.taskId), context = f.tasks.context(f.principal, f.taskId, { requestId: randomUUID(), ownership: nextOwnership, expectedTaskRevision: task.data.revision }, f.token);
    const ref = context.data.snapshotRef as {snapshotId:string;digest:string}, actionId = decision.requestId, payloadDigest = sha256('new attempt');
    const prepare = { requestId: randomUUID(), sequence: 1, ownership: nextOwnership, payloadDigest, actionKind: 'read', contextSnapshotId: ref.snapshotId, contextDigest: ref.digest, grantRevision: 1, expectedTaskRevision: task.data.revision, journalSequence: 3, resolutionRequestId: decision.requestId };
    const intentDigest = digestCommand([f.taskId,actionId,1,nextOwnership,payloadDigest,'read',ref.snapshotId,ref.digest,null,null,1,null,null,decision.requestId]);
    assert.equal(f.tasks.prepare(f.principal, f.taskId, actionId, { ...prepare, intentDigest }, f.token).data.state, 'prepared');
  } finally { f.close(); }
});

test('late known result rejects risk retry and historical accepted receipt stays valid after a later ACK', async () => {
  const f=await preparedTask();
  try {
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    f.tasks.reconcile(f.principal,f.taskId,{requestId:randomUUID(),actionId:f.actionId,ownership:f.ownership,payloadDigest:f.payloadDigest,state:'uncertain',effectStatus:'unknown',journalSequence:2,uncertainReason:'Response lost'},f.token);
    const resultContent={text:'Late known output'},resultDigest=sha256(canonicalJson(resultContent)),resultRef={v:1,taskId:f.taskId,actionId:f.actionId,digest:resultDigest,size:Buffer.byteLength(canonicalJson(resultContent)),encoding:'canonical-json-v1'};
    const report={requestId:randomUUID(),actionId:f.actionId,ownership:f.ownership,payloadDigest:f.payloadDigest,state:'reported',effectStatus:'known',journalSequence:3,resultContent,resultDigest,resultRef};
    const accepted=f.tasks.reconcile(f.principal,f.taskId,report,f.token);
    const acknowledged=f.tasks.reconcile(f.principal,f.taskId,{...report,requestId:randomUUID(),state:'acknowledged',journalSequence:4},f.token);
    assert.throws(()=>f.tasks.control(f.owner,f.taskId,{requestId:randomUUID(),expectedRevision:acknowledged.receipt.recordRevision,operation:'resolve_uncertain',decision:{kind:'retry_with_risk',actionId:f.actionId,acknowledgement:'effect_may_have_happened',reason:'Should not replay known output'}}),code('resolution_conflict'));
    const resolved=f.tasks.control(f.owner,f.taskId,{requestId:randomUUID(),expectedRevision:acknowledged.receipt.recordRevision,operation:'resolve_uncertain',decision:{kind:'known_result',actionId:f.actionId,evidenceRequestId:accepted.receipt.requestId,resultRef}});
    assert.equal(resolved.data.state,'running');assert.equal(resolved.data.replacementActionId,undefined);
  }finally{f.close();}
});

test('offline task admission is durable, scoped, immutable and exact without provider binding', async () => {
  const f = await fixture();
  try {
    const command = f.command(), accepted = f.tasks.admit(f.owner, command);
    assert.equal(accepted.status, 202); assert.equal(accepted.data.state, 'waiting_device'); assert.equal(accepted.data.taskId, command.requestId);
    assert.equal(f.tasks.admit(f.owner, command).status, 200);
    assert.throws(() => f.tasks.admit(f.owner, { ...command, payloadDigest: '0'.repeat(64) }), code('payload_digest_mismatch'));
    assert.throws(() => f.tasks.admit(f.foreign, command), code('resource_not_found'));
    assert.throws(() => f.tasks.admit(f.member, command), code('execution_denied'));
    assert.throws(() => f.tasks.admit(f.owner, f.command({ expectedRevisions: { ...command.expectedRevisions, capability: 2 } })), code('stale_revision'));
    assert.throws(() => parseTaskCommand({ ...command, secret: 'forbidden' }), code('unknown_field'));
    assert.throws(() => parseTaskCommand({ ...command, payload: { ...command.payload, role: 'admin' } }), code('unknown_field'));
    f.db.prepare('UPDATE agent_projects SET revision=2 WHERE project=? AND agent=?').run(f.project, f.agent);
    assert.equal(f.tasks.admit(f.owner, command).status, 200);
    assert.equal(f.tasks.lookup(f.owner, command.requestId).data.currentTaskId, command.requestId);
    assert.throws(() => f.db.prepare('UPDATE tasks SET home_device=? WHERE id=?').run(randomUUID(), command.requestId), /immutable task admission/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM turns').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_actions').get()!.n, 0);
  } finally { f.close(); }
});

test('assigned collaborator executes owner home/binding and revoked scope blocks receipt replay', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project, f.member.accountId, f.agent);
    f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,1,1)').run(f.project, f.member.accountId, f.agent);
    const command = f.command();
    assert.equal(f.tasks.admit(f.member, command).status, 202);
    f.db.prepare('UPDATE project_members SET deleted=1,grant_revision=2 WHERE project=? AND account=?').run(f.project, f.member.accountId);
    assert.throws(() => f.tasks.admit(f.member, command), code('resource_not_found'));
    assert.throws(() => f.tasks.lookup(f.member, command.requestId), code('resource_not_found'));
  } finally { f.close(); }
});

test('task messages require files, preserve line breaks, and closed union rejects mixed routing', async () => {
  const f = await fixture();
  try {
    const command = f.command({ payload: { v: 1, kind: 'direct', message: { text: 'First\nSecond\tIndented', files: [] } } });
    assert.equal(f.tasks.admit(f.owner, command).status, 202);
    assert.throws(() => parseTaskCommand(f.command({ payload: { v: 1, kind: 'direct', message: { text: 'No files' } } })), code('invalid_attachments'));
    assert.throws(() => parseTaskCommand(f.command({ payload: { v: 1, kind: 'channel', channelId: randomUUID(), threadId: randomUUID(), routing: 'assigned', message: { text: 'Mixed', files: [] } }, expectedRevisions: { ...command.expectedRevisions, channel: 1 } })), code('invalid_task_payload'));
    assert.throws(() => f.tasks.admit(f.owner, f.command({ payload: { v: 1, kind: 'direct', message: { text: 'Foreign attachment', files: [randomUUID()] } } })), code('resource_not_found'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 1);
  } finally { f.close(); }
});

test('task admission requires scoped conversation, matching revisions and exact attachment conversation', async () => {
  const f = await fixture();
  try {
    const thread = randomUUID(), channel = randomUUID();
    f.db.prepare('INSERT INTO threads(id,agent,name) VALUES (?,?,?)').run(thread, f.agent, 'Side');
    f.db.prepare('INSERT INTO channels(id,name,instructions,lead) VALUES (?,?,?,?)').run(channel, 'Room', 'Room rules', f.agent);
    f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel, f.agent);
    const direct = f.command();
    const side = f.command({ payload: { v: 1, kind: 'side', threadId: thread, message: { text: 'Private', files: [] } }, expectedRevisions: { ...direct.expectedRevisions, thread: 1 } });
    assert.throws(() => f.tasks.admit(f.owner, side), code('resource_not_found'));
    f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]), f.owner.accountId, f.project, thread);
    assert.equal(f.tasks.admit(f.owner, side).status, 202);
    assert.equal(f.db.prepare('SELECT thread FROM turns WHERE id=?').get(side.requestId)!.thread, thread);
    assert.throws(() => f.tasks.admit(f.owner, f.command({ ...side, requestId: randomUUID(), expectedRevisions: { ...side.expectedRevisions, thread: 2 } })), code('stale_revision'));
    const room = f.command({ payload: { v: 1, kind: 'channel', channelId: channel, routing: 'automatic', message: { text: 'Room', files: [] } }, expectedRevisions: { ...direct.expectedRevisions, channel: 1 } });
    f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]), f.owner.accountId, f.project, channel);
    assert.equal(f.tasks.admit(f.owner, room).status, 202);
    f.db.prepare('UPDATE channels SET archived=1,revision=2 WHERE id=?').run(channel);
    assert.equal(f.tasks.admit(f.owner, room).status, 200);
    assert.throws(() => f.tasks.admit(f.owner, f.command({ ...room, requestId: randomUUID() })), code('conversation_archived'));
  } finally { f.close(); }
});

test('provider provenance is captured from owner same-home binding and never caller fields', async () => {
  const f = await fixture();
  try {
    const binding = randomUUID();
    f.db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','fixture','Fixture','ready',1)").run(binding, f.home, f.owner.accountId);
    f.db.prepare('UPDATE agent_authority SET provider_binding=? WHERE agent=?').run(binding, f.agent);
    const command = f.command(); f.tasks.admit(f.owner, command);
    const task = f.db.prepare('SELECT provider_binding_id,provider_binding_revision,provider_binding_owner FROM tasks WHERE id=?').get(command.requestId)!;
    assert.equal(task.provider_binding_id, binding); assert.equal(task.provider_binding_revision, 1); assert.equal(task.provider_binding_owner, f.owner.accountId);
    f.db.prepare('UPDATE provider_bindings SET owner_account=? WHERE id=?').run(f.foreign.accountId, binding);
    assert.throws(() => f.tasks.admit(f.owner, f.command()), code('resource_not_found'));
    assert.equal(f.tasks.admit(f.owner, command).status, 200);
  } finally { f.close(); }
});

test('acquire requires stopped/reconciled owner, exact token and fenced generation', async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.tasks.admit(f.owner, command);
    const token = randomBytes(32).toString('base64url'), lockProof = { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') };
    const acquire = { requestId: randomUUID(), taskId: command.requestId, previousExecutorGeneration: 0, executorTokenHash: sha256(token), lockProof };
    const owned = f.tasks.acquire(f.principal, acquire, token);
    assert.equal((owned.data.ownership as any).executorGeneration, 1);
    assert.deepEqual(f.tasks.acquire(f.principal, acquire, token).data, owned.data);
    assert.throws(() => f.tasks.acquire(f.principal, { ...acquire, requestId: randomUUID() }, token), code('ownership_conflict'));
    assert.throws(() => f.tasks.acquire(f.principal, { ...acquire, requestId: randomUUID(), previousExecutorGeneration: 1, lockProof: { ...lockProof, previousOwnerStopped: false } }, token), code('ownership_conflict'));
    assert.throws(() => f.tasks.acquire(f.principal, acquire, randomBytes(32).toString('base64url')), code('executor_invalid'));
    const successorToken = randomBytes(32).toString('base64url');
    const next = f.tasks.acquire(f.principal, { ...acquire, requestId: randomUUID(), previousExecutorGeneration: 1, executorTokenHash: sha256(successorToken), lockProof: { ...lockProof, lockId: randomUUID() } }, successorToken);
    assert.equal((next.data.ownership as any).executorGeneration, 2);
    assert(!JSON.stringify(owned).includes(token));
  } finally { f.close(); }
});

test('context snapshot is immutable, exact, project scoped and requires current executor token', async () => {
  const f = await fixture();
  try {
    const c = f.command(); f.tasks.admit(f.owner,c);
    const token = randomBytes(32).toString('base64url');
    const acquired = f.tasks.acquire(f.principal, { requestId: randomUUID(), taskId: c.requestId, previousExecutorGeneration: 0, executorTokenHash: sha256(token), lockProof: { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') } }, token);
    const ownership = parseOwnership(acquired.data.ownership), command = { requestId: randomUUID(), ownership, expectedTaskRevision: acquired.receipt.recordRevision };
    const context = f.tasks.context(f.principal,c.requestId,command,token);
    assert.deepEqual(f.tasks.context(f.principal,c.requestId,command,token).data, context.data);
    const data = context.data as { snapshotRef: { digest: string }; snapshot: { projectId: string; profile: { instructions: string }; projectRules: string } };
    assert.equal(data.snapshot.projectId,f.project); assert.equal(data.snapshot.profile.instructions,'Research');
    assert.equal(data.snapshotRef.digest,sha256(canonicalJson(data.snapshot)));
    assert.throws(() => f.tasks.context(f.principal,c.requestId,{ ...command,requestId: randomUUID() }, randomBytes(32).toString('base64url')),code('executor_invalid'));
    assert.throws(() => f.db.prepare('UPDATE task_context_snapshots SET snapshot_json=\'{}\'').run(),/immutable task context/);
  } finally { f.close(); }
});

test('action prepare grants no dispatch; commit has one live grant and stale context blocks new work', async () => {
  const f=await fixture();
  try {
    const c=f.command();f.tasks.admit(f.owner,c);const token=randomBytes(32).toString('base64url');
    const owned=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:c.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
    const ownership=parseOwnership(owned.data.ownership),context=f.tasks.context(f.principal,c.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision:owned.receipt.recordRevision},token);
    const ref=context.data.snapshotRef as {snapshotId:string;digest:string};const action=randomUUID();
    const prepare={requestId:randomUUID(),sequence:0,ownership,payloadDigest:sha256('compute'),actionKind:'compute',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision:owned.receipt.recordRevision,journalSequence:1};
    const intentDigest=digestCommand([c.requestId,action,0,ownership,prepare.payloadDigest,'compute',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
    const prepared=f.tasks.prepare(f.principal,c.requestId,action,{...prepare,intentDigest},token);
    assert.equal(prepared.data.state,'prepared');assert.equal(prepared.data.dispatchable,undefined);
    assert.deepEqual(f.tasks.prepare(f.principal,c.requestId,action,{...prepare,intentDigest},token).data,prepared.data);
    assert.throws(()=>f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:c.requestId,previousExecutorGeneration:1,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),code('ownership_conflict'));
    const commit={requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision:owned.receipt.recordRevision,journalSequence:1};
    const committed=f.tasks.commit(f.principal,c.requestId,action,commit,token);assert.equal(committed.data.dispatchable,true);
    assert.equal(f.tasks.commit(f.principal,c.requestId,action,commit,token).data.dispatchable,false);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT result_json FROM receipts WHERE request_id=?').get(commit.requestId)!.result_json)).data.dispatchable,false);
    assert.throws(()=>f.tasks.commit(f.principal,c.requestId,action,{...commit,requestId:randomUUID()},token),code('action_conflict'));
    assert.throws(()=>f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:c.requestId,previousExecutorGeneration:1,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),code('ownership_conflict'));
  }finally{f.close();}
});
