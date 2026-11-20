import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { testDatabase } from './test-support/database.ts';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HumanActor } from './test-support/auth.ts';
import { transaction } from './test-support/legacy-schema.ts';
import { installFrozenNodeSchema } from './test-support/canonical-schema.ts';
import { initializeMemory, rememberMemory } from './test-support/memory.ts';
import { requireSkillSchema as initializeSkills, seedSkillVersion as saveSkill } from './test-support/skill-fixture.ts';
import { initializeQuestions } from './test-support/questions.ts';
import { initializeCompaction } from './test-support/compaction.ts';
import { parseLinkChallenge, deviceLinkBody, descriptorBody, type DeviceDescriptor } from './test-support/device-protocol.ts';
import { canonicalJson, digestCommand, sha256, ProtocolError } from './shared/protocol.ts';
import { canonicalToolDigest, parseOwnership, journalEntryBody, stopEvidenceBody, recoveryEnvelopeBody, type StopEvidence, type JournalEntry, type ActionContext } from './test-support/task-protocol.ts';
import { prepareRestoreBootstrap, issueRestoreSession, workspaceSnapshot } from './test-support/backup.ts';
import { rustBinary } from './rust-binary.ts';
import { rustTaskTestBridge } from './rust-task-test-bridge.ts';
import { startRustServer } from './rust-test-server.ts';

async function fixture(tools = ['transfer_task'], testPathPrefix?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-recovery-rust-')), database = join(directory, 'canonical.sqlite');
  const db = testDatabase(database); installFrozenNodeSchema(db);
  // Keep human JWTs valid through host stalls while wait-expiry tests use the real clock.
  const expiresAt = Date.now() + 60 * 60_000;
  const actor = (subject: string): HumanActor => ({ accountId: randomUUID(), issuer: 'https://fixture.example', subject, sessionId: `sess_${subject}`, expiresAt });
  const owner = actor('owner'), member = actor('member'), foreign = actor('foreign');
  for (const a of [owner, member, foreign]) db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(a.accountId, a.issuer, a.subject, Date.now());
  const signing = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const { tasks, access, devices, close } = await rustTaskTestBridge(database, signing, testPathPrefix).catch(error => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  });
  try {
    const encoded = (key: typeof signing.publicKey) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
    const candidate = parseLinkChallenge({ requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(), mode: 'new', installationPublicKey: encoded(installation.publicKey), deviceSigningKey: encoded(signing.publicKey), deviceEncryptionKey: encoded(encryption.publicKey), deviceLabel: 'Home', requestedCapabilities: ['execution'], zone: 'Asia/Jakarta', zoneRevision: 1 });
    const challenge = devices.createChallenge(owner, candidate), bytes = Buffer.from(JSON.stringify(deviceLinkBody(candidate, challenge)));
    const descriptor: Omit<DeviceDescriptor, 'signature'> = { v: 1, accountId: owner.accountId, installationId: candidate.installationId, deviceId: candidate.deviceId, authorityGeneration: challenge.authorityGeneration, deviceGeneration: 1, keyRevision: 1, zone: candidate.zone, zoneRevision: 1, signingPublicKey: candidate.deviceSigningKey, encryptionPublicKey: candidate.deviceEncryptionKey };
    devices.link(owner, { requestId: randomUUID(), challengeId: challenge.challengeId, nonce: challenge.nonce, installationSignature: sign(null, bytes, installation.privateKey).toString('base64url'), deviceSignature: sign(null, bytes, signing.privateKey).toString('base64url'), descriptor: { ...descriptor, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(descriptor))), signing.privateKey).toString('base64url') } });
    const project = randomUUID(), agent = randomUUID(), home = candidate.deviceId;
    access.createProject(owner, { requestId: randomUUID(), id: project, name: 'A' });
    access.createAgent(owner, { requestId: agent, id: agent, name: 'Agent', model: 'fixture', backupModel: '', instructions: 'Research', threadLimit: 2, projectId: project, homeDeviceId: home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null });
    db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project, member.accountId);
    db.prepare('UPDATE agent_projects SET capabilities_json=? WHERE project=? AND agent=?').run(canonicalJson({ v: 1, tools, resources: [] }), project, agent);
    function command(change: Record<string, unknown> = {}) {
      const c = { requestId: randomUUID(), projectId: project, agentId: agent, homeDeviceId: home, payload: { v: 1, kind: 'direct', message: { text: 'Research this', files: [] } }, expectedRevisions: { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1 }, ...change };
      return { ...c, payloadDigest: digestCommand(['briefsip-task-payload-v1', c.requestId, c.projectId, c.agentId, c.homeDeviceId, c.payload, c.expectedRevisions]) };
    }
    const principal = { deviceId: home, accountId: owner.accountId, generation: 1, authorityGeneration: challenge.authorityGeneration };
    return { db, owner, member, foreign, project, agent, home, tasks, access, devices, command, signing, principal, async close() { await close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
function storedTurnProvision(raw: unknown) {
  const { provision } = JSON.parse(String(raw)) as {
    provision: { provisionId: string; payloadDigest: string; waitKey: string; deadline: number; target: { kind: string } };
  };
  const { payloadDigest, ...payload } = provision;
  assert.equal(payloadDigest, digestCommand(['briefsip-wait-provision-v1', payload]));
  return provision;
}

const code = (expected: string) => (error: unknown) => error instanceof ProtocolError && error.code === expected;

test('reassign creates one immutable successor, keeps original receipt and fences source controls', async () => {
  const f = await fixture(), recipient = randomUUID();
  try {
    await f.access.createAgent(f.owner, { requestId: recipient, id: recipient, name: 'Recipient', model: 'fixture', backupModel: '', instructions: 'Continue', threadLimit: 2, projectId: f.project, homeDeviceId: f.home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null });
    const command = f.command(), accepted = f.tasks.admit(f.owner, command), taskId = command.requestId;
    const reassign = { requestId: randomUUID(), expectedRevision: 1, operation: 'reassign', recipientAgentId: recipient };
    assert.throws(() => f.tasks.control(f.owner, taskId, reassign), code('task_not_paused'));
    const paused = f.tasks.control(f.owner, taskId, { requestId: randomUUID(), expectedRevision: 1, operation: 'pause' });
    reassign.expectedRevision = paused.receipt.recordRevision;
    const transferred = f.tasks.control(f.owner, taskId, reassign), successor = String(transferred.data.taskId);
    assert.notEqual(successor, taskId);
    assert.equal(transferred.data.logicalTurnId, taskId);
    assert.equal(transferred.data.previousTaskId, taskId);
    assert.equal(transferred.data.homeDeviceId, f.home);
    assert.deepEqual(f.tasks.control(f.owner, taskId, reassign).data, transferred.data);
    const original = f.tasks.lookup(f.owner, taskId), next = f.tasks.lookup(f.owner, successor);
    assert.equal(original.data.currentTaskId, successor);
    assert.equal(original.data.state, 'transferred');
    assert.equal(original.data.agentId, f.agent);
    assert.deepEqual(original.receipt, accepted.receipt);
    assert.equal(next.data.agentId, recipient);
    assert.equal(next.data.state, 'waiting_device');
    assert.equal(next.data.logicalTurnId, taskId);
    assert.throws(() => f.tasks.control(f.owner, taskId, { ...reassign, requestId: randomUUID() }), code('task_transferred'));
    assert.throws(() => f.tasks.control(f.owner, successor, { requestId: randomUUID(), expectedRevision: 1, operation: 'pause', recipientAgentId: recipient }), code('recipient_forbidden'));
    assert.throws(() => f.tasks.control(f.foreign, successor, { requestId: randomUUID(), expectedRevision: 1, operation: 'pause' }), code('resource_not_found'));
    assert.throws(() => f.db.prepare('UPDATE tasks SET agent=? WHERE id=?').run(recipient, taskId), /immutable task admission/);
    assert.equal(f.tasks.admit(f.owner, command).data.taskId, taskId);
  } finally { await f.close(); }
});

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

async function canonicalTaskTools(tools=['ask_user'], testPathPrefix?: string) {
  const f=await fixture(tools, testPathPrefix);
  const start=(actor=f.owner,payload:Record<string,unknown>={v:1,kind:'direct',message:{text:'Ask first',files:[]}})=>{
    const expectedRevisions={project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(payload.kind==='channel'?{channel:1}:{}),...(payload.kind==='side'?{thread:1}:{})};
    const command=f.command({payload,expectedRevisions});f.tasks.admit(actor,command);
    const taskId=command.requestId,token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
    return {taskId,token,ownership:parseOwnership(acquired.data.ownership),actor,sequence:0};
  };
  const stage=(task:ReturnType<typeof start>,args:unknown,name='ask_user')=>{
    const expectedTaskRevision=Number(f.tasks.lookup(task.actor,task.taskId).data.revision),context=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision},task.token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),sequence=task.sequence++;
    const toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),intentDigest=digestCommand([task.taskId,actionId,sequence,task.ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
    f.tasks.prepare(f.principal,task.taskId,actionId,{requestId:randomUUID(),sequence,ownership:task.ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},task.token);
    f.tasks.commit(f.principal,task.taskId,actionId,{requestId:randomUUID(),ownership:task.ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},task.token);
    const request={requestId:randomUUID(),actionId,ownership:task.ownership,toolCall,payloadDigest,expectedRevision};
    return Object.assign(()=>f.tasks.contextMutations(f.principal,task.taskId,request,task.token),{request,async:async()=>{
      const result=await f.tasks.runContextMutation(f.principal,task.taskId,request,task.token);
      return {...result,data:{...result.data,resultContent:result.data.resultContent as Record<string,unknown>}};
    }});
  };
  return {...f,start,stage};
}

test('canonical channel context names current visible members and lead across edits', async () => {
  const f = await fixture(), peer = randomUUID(), channel = randomUUID();
  try {
    await f.access.createAgent(f.owner, { requestId: peer, id: peer, name: 'Right Hand', role: 'Personal agent', model: 'fixture', backupModel: '', instructions: 'Help.', threadLimit: 2, projectId: f.project, homeDeviceId: f.home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null });
    f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Owner team','Discuss channel work.',?)").run(channel, peer);
    for (const agent of [f.agent, peer]) f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel, agent);
    f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]), f.owner.accountId, f.project, channel);
    function snapshot(routing: 'assigned' | 'automatic' = 'assigned') {
      const agent = routing === 'automatic' ? peer : f.agent;
      const command = f.command({ agentId: agent, payload: { v: 1, kind: 'channel', channelId: channel, routing, message: { text: 'Describe this channel.', files: [] } }, expectedRevisions: { project: 1, agent: 1, homeBinding: 1, membership: 1, assignment: 1, capability: 1, channel: Number(f.db.prepare('SELECT revision FROM channels WHERE id=?').get(channel)!.revision) } });
      f.tasks.admit(f.owner, command);
      const taskId = command.requestId, token = randomBytes(32).toString('base64url');
      const acquired = f.tasks.acquire(f.principal, { requestId: randomUUID(), taskId, previousExecutorGeneration: 0, executorTokenHash: sha256(token), lockProof: { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') } }, token);
      const context = f.tasks.context(f.principal, taskId, { requestId: randomUUID(), ownership: parseOwnership(acquired.data.ownership), expectedTaskRevision: acquired.receipt.recordRevision }, token);
      return (context.data.snapshot as { conversation: { channel?: unknown } }).conversation.channel;
    }
    const expected = { name: 'Owner team', instructions: 'Discuss channel work.', members: ['Agent', 'Right Hand - Personal agent'], lead: 'Right Hand - Personal agent' };
    assert.deepEqual(snapshot('automatic'), expected);
    assert.deepEqual(snapshot(), expected);
    f.db.prepare('UPDATE channels SET lead=?,revision=revision+1 WHERE id=?').run(f.agent, channel);
    assert.deepEqual(snapshot(), { ...expected, lead: 'Agent' });
    f.db.prepare('UPDATE channels SET lead=?,revision=revision+1 WHERE id=?').run(peer, channel);
    f.db.exec('CREATE TABLE IF NOT EXISTS agent_visibility(agent TEXT PRIMARY KEY,hidden INTEGER,revision INTEGER)');
    f.db.prepare('INSERT INTO agent_visibility VALUES (?,1,1)').run(peer);
    assert.deepEqual(snapshot(), { ...expected, members: ['Agent'], lead: 'No lead' });
    f.db.prepare('DELETE FROM channel_members WHERE channel=? AND agent=?').run(channel, peer);
    f.db.prepare('UPDATE channels SET lead=NULL,revision=revision+1 WHERE id=?').run(channel);
    assert.deepEqual(snapshot(), { ...expected, members: ['Agent'], lead: 'No lead' });
  } finally { await f.close(); }
});

async function routineTaskTools() {
  const f=await canonicalTaskTools(['no_update','report_failure']);
  f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
  const task=f.start(f.member),routine=randomUUID(),occurrence=randomUUID();
  transaction(f.db, () => {
    f.db.prepare("INSERT INTO routines(id,agent,name,prompt,next_at,enabled) VALUES (?,?,'Outcome','Check work',1000,0)").run(routine,f.agent);
    f.db.prepare("INSERT INTO record_scopes VALUES ('routines',?,?,?,'project','agent',?)").run(JSON.stringify([routine]),f.owner.accountId,f.project,f.agent);
    f.db.prepare(`INSERT INTO routine_occurrences(id,routine,project,due_at,schedule_revision,initiator_account,assignment_revision,authority_generation,home_device,zone,zone_revision,missed_count,state,graph_json,task)
      VALUES (?,?,?,1000,1,?,1,?,?,'Asia/Jakarta',1,0,'admitted',?,?)`).run(occurrence,routine,f.project,f.member.accountId,f.principal.authorityGeneration,f.home,JSON.stringify({root:f.agent,nodes:[f.agent],links:[]}),task.taskId);
    f.db.prepare("INSERT INTO record_scopes VALUES ('routine_occurrences',?,?,?,'project','agent',?)").run(JSON.stringify([occurrence]),f.owner.accountId,f.project,f.agent);
    f.db.prepare("INSERT INTO routine_steps VALUES (?,?,?,'queued','')").run(occurrence,f.agent,task.taskId);
  });
  return {...f,task,occurrence};
}

test('canonical routine outcomes validate reasons and atomically retain result receipt and task state',async()=>{
  for(const name of ['no_update','report_failure']){
    const f=await routineTaskTools();
    try{
      for(const reason of [undefined,null,0,'','  ','x'.repeat(2001),'null\u0000byte']){
        const result=f.stage(f.task,{reason},name)();
        assert.equal((result.data.resultContent as {status:number}).status,400);
        assert.equal(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(f.task.taskId)!.state,'running');
        assert.equal(f.db.prepare('SELECT no_update FROM turns WHERE id=?').get(f.task.taskId)!.no_update,0);
        assert.equal(f.db.prepare('SELECT stopped FROM execution_owners WHERE task=?').get(f.task.taskId)!.stopped,0);
      }
      f.db.exec(`CREATE TABLE IF NOT EXISTS files(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,scope TEXT,name TEXT,digest TEXT,bytes BLOB,created TEXT);
        CREATE TABLE IF NOT EXISTS generated_files(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT,file TEXT,call_id TEXT,call TEXT,after_action INTEGER);`);
      const file=randomUUID(),bytes=Buffer.from('Evidence collected before terminal outcome');
      f.db.prepare("INSERT INTO files(id,scope,name,digest,bytes,created) VALUES (?,'fixture','partial.txt',?,?,'fixture')").run(file,sha256(bytes),bytes);
      f.db.prepare("INSERT INTO generated_files(turn,file,call_id,call,after_action) VALUES (?,?,'partial',?,0)").run(f.task.taskId,file,JSON.stringify({function:{name:'create_text_file'}}));
      f.db.prepare("INSERT INTO record_scopes VALUES ('files',?,?,?,'owner','agent',?)").run(JSON.stringify([file]),f.member.accountId,f.project,f.agent);
      const reason='r'.repeat(2000),command=f.stage(f.task,{reason},name),before=f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(f.task.taskId)!.revision;
      f.db.exec("CREATE TRIGGER fail_outcome_receipt BEFORE INSERT ON receipts WHEN NEW.scope LIKE 'tasks:context-mutations:%' BEGIN SELECT RAISE(ABORT,'outcome receipt failed'); END");
      assert.throws(()=>command(),code('storage_failed'));
      assert.equal(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(f.task.taskId)!.state,'running');
      assert.equal(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(f.task.taskId)!.revision,before);
      assert.equal(f.db.prepare('SELECT no_update FROM turns WHERE id=?').get(f.task.taskId)!.no_update,0);
      assert.equal(f.db.prepare('SELECT stopped FROM execution_owners WHERE task=?').get(f.task.taskId)!.stopped,0);
      assert.equal(f.db.prepare('SELECT 1 FROM task_results WHERE action=?').get(command.request.actionId),undefined);
      assert.equal(f.db.prepare('SELECT 1 FROM task_reports WHERE action=?').get(command.request.actionId),undefined);
      f.db.exec('DROP TRIGGER fail_outcome_receipt');
      const saved=command();assert.equal((saved.data.resultContent as {reason:string}).reason,reason);
      assert.deepEqual(Buffer.from(f.db.prepare('SELECT bytes FROM files WHERE id=?').get(file)!.bytes as Uint8Array),bytes);
      assert.equal(f.db.prepare('SELECT file FROM generated_files WHERE turn=?').get(f.task.taskId)!.file,file);
      assert.deepEqual(command(),saved,'Exact retry returns original terminal result');
      f.db.prepare('UPDATE routine_steps SET state=? WHERE occurrence=?').run(name==='no_update'?'skipped':'failed',f.occurrence);
      f.db.prepare('UPDATE routine_occurrences SET state=? WHERE id=?').run(name==='no_update'?'done':'failed',f.occurrence);
      assert.deepEqual(command(),saved,'Settlement cannot prevent exact result recovery');
      assert.equal(f.tasks.execution(f.principal,f.task.taskId,{requestId:randomUUID(),ownership:f.task.ownership},f.task.token).state,name==='no_update'?'completed':'failed');
      f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=? AND agent=?').run(f.project,f.member.accountId,f.agent);
      assert.throws(()=>command(),code('execution_denied'),'Saved evidence still requires current assignment');
    }finally{await f.close();}
  }
});

test('canonical routine outcomes deny forced ordinary chat and descendant calls',async()=>{
  for(const name of ['no_update','report_failure']){
    const f=await routineTaskTools();
    try{
      const direct=f.start(),descendant=f.start(f.member);
      f.db.prepare('UPDATE turns SET parent=? WHERE id=?').run(f.task.taskId,descendant.taskId);
      const side=randomUUID(),channel=randomUUID();
      f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(side,f.agent);
      f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([side]),f.owner.accountId,f.project,side);
      f.db.prepare("INSERT INTO channels(id,name,instructions) VALUES (?,'Room','Help')").run(channel);
      f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);
      f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
      const tasks=[direct,descendant,f.start(f.owner,{v:1,kind:'side',threadId:side,message:{text:'Ordinary side chat',files:[]}}),f.start(f.owner,{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Ordinary channel',files:[]}})];
      for(const task of tasks){
        const context=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision:Number(f.tasks.lookup(task.actor,task.taskId).data.revision)},task.token);
        assert(!(context.data.snapshot as {tools:{function:{name:string}}[]}).tools.some(tool=>['no_update','report_failure'].includes(tool.function.name)));
        const command=f.stage(task,{reason:'Forced terminal call'},name);
        assert.throws(()=>command(),code('execution_denied'));
        assert.equal(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.taskId)!.state,'running');
      }
    }finally{await f.close();}
  }
});

test('canonical routine outcomes reject late results after pause cancel revoke or context change',async()=>{
  for(const change of ['pause','cancel','revoke','capability','scope','rules','setup','unknown-field']){
    const f=await routineTaskTools();
    try{
      const command=f.stage(f.task,change==='unknown-field'?{reason:'No changes',taskId:f.task.taskId}:{reason:'No changes'},'no_update');
      if(change==='pause'||change==='cancel')f.tasks.control(f.task.actor,f.task.taskId,{requestId:randomUUID(),expectedRevision:command.request.expectedRevision,operation:change});
      if(change==='revoke')f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=? AND agent=?').run(f.project,f.member.accountId,f.agent);
      if(change==='scope')f.db.prepare("DELETE FROM record_scopes WHERE table_name='routine_occurrences'").run();
      if(change==='capability')f.db.prepare('UPDATE agent_projects SET capabilities_json=?,revision=revision+1 WHERE project=? AND agent=?').run(JSON.stringify({v:1,tools:[],resources:[]}),f.project,f.agent);
      if(change==='rules')f.db.prepare("UPDATE agent_projects SET rules='Changed',revision=revision+1 WHERE project=? AND agent=?").run(f.project,f.agent);
      if(change==='setup')f.db.prepare('UPDATE turns SET profile_setup=1 WHERE id=?').run(f.task.taskId);
      assert.throws(()=>command(),error=>error instanceof ProtocolError&&['execution_denied','task_not_runnable','stale_revision','context_stale','unknown_field','ownership_conflict'].includes(error.code));
      assert.equal(f.db.prepare('SELECT no_update FROM turns WHERE id=?').get(f.task.taskId)!.no_update,0);
      assert.equal(f.db.prepare('SELECT 1 FROM task_results WHERE action=?').get(command.request.actionId),undefined);
      assert.notEqual(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(f.task.taskId)!.state,'completed');
    }finally{await f.close();}
  }
});

test('canonical turn wait reserves one deadline and activates only after matching home secret result', async () => {
  const f = await canonicalTaskTools(['wait_for_event']);
  try {
    const task = f.start(), rpc = f.stage(task, { event: 'ready', timeoutSeconds: 60 }, 'wait_for_event');
    await assert.rejects(rpc.async(), code('device_offline'));
    const row = f.db.prepare('SELECT * FROM wait_provisions').get()!;
    assert.equal(row.state, 'pending');
    const provision = storedTurnProvision(row.request_json);
    assert.equal(provision.provisionId, rpc.request.requestId);
    assert.equal(provision.target.kind, 'turn');
    assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 0);
    await assert.rejects(rpc.async(), code('device_offline'));
    assert.equal(f.db.prepare('SELECT deadline FROM wait_provisions').get()!.deadline, row.deadline);
    const result = { requestId: randomUUID(), provisionId: provision.provisionId, payloadDigest: provision.payloadDigest, waitKey: provision.waitKey, secretGeneration: 1, sourceDeviceGeneration: 1, state: 'ready', secretRef: JSON.stringify([provision.waitKey, 1]) };
    assert.throws(() => f.tasks.waitSecretResult(f.principal, { ...result, secretRef: 'mismatched reference' }), code('wait_invalid'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 0);
    const ack = f.tasks.waitSecretResult(f.principal, result);
    assert.equal(ack.data.state, 'activated');
    assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 1);
    const original = await rpc.async();
    assert.equal(original.data.resultContent.status, 'waiting');
    assert.equal(original.data.resultContent.id, provision.waitKey);
    assert.deepEqual(f.tasks.waitSecretResult(f.principal, result), ack);
    assert.throws(() => f.tasks.waitSecretResult(f.principal, { ...result, state: 'failed', secretRef: undefined, errorCode: 'wait_expired' }), code('payload_conflict'));
    assert.throws(() => f.tasks.context(f.principal, task.taskId, { requestId: randomUUID(), ownership: task.ownership, expectedTaskRevision: original.receipt.recordRevision }, task.token), code('event_pending'));
    assert(!f.db.prepare('PRAGMA table_info(turn_waits)').all().some(row => row.name === 'secret'));
  } finally { await f.close(); }
});

test('pending turn wait closes after cancellation, stale target or failed keyring result and rolls back failed activation', async () => {
  for (const outcome of ['cancel', 'pause', 'capability', 'keyring', 'rollback'] as const) {
    const f = await canonicalTaskTools(['wait_for_event']);
    try {
      const task = f.start(), rpc = f.stage(task, { event: 'ready', timeoutSeconds: 60 }, 'wait_for_event');
      await assert.rejects(rpc.async(), code('device_offline'));
      const row = f.db.prepare('SELECT * FROM wait_provisions').get()!, provision = storedTurnProvision(row.request_json);
      if (outcome === 'cancel' || outcome === 'pause') f.tasks.control(f.owner, task.taskId, { requestId: randomUUID(), expectedRevision: rpc.request.expectedRevision, operation: outcome });
      if (outcome === 'capability') f.db.prepare('UPDATE agent_projects SET revision=revision+1').run();
      const result = { requestId: randomUUID(), provisionId: provision.provisionId, payloadDigest: provision.payloadDigest, waitKey: provision.waitKey, secretGeneration: 1, sourceDeviceGeneration: 1, ...(outcome === 'keyring' ? { state: 'failed', errorCode: 'keystore_unavailable' } : { state: 'ready', secretRef: JSON.stringify([provision.waitKey, 1]) }) };
      if (outcome === 'rollback') {
        f.db.exec("CREATE TRIGGER fail_wait_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'fixture wait result failure'); END");
        assert.throws(() => f.tasks.waitSecretResult(f.principal, result), code('storage_failed'));
        assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 0);
        assert.equal(f.db.prepare('SELECT state FROM wait_provisions').get()!.state, 'pending');
        f.db.exec('DROP TRIGGER fail_wait_result');
      }
      const ack = f.tasks.waitSecretResult(f.principal, result);
      assert.equal(ack.data.state, outcome === 'rollback' ? 'activated' : 'closed');
      assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, outcome === 'rollback' ? 1 : 0);
      assert.deepEqual(f.tasks.waitSecretResult(f.principal, result), ack);
      if (outcome === 'cancel' || outcome === 'pause') assert.equal(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.taskId)!.state, outcome === 'cancel' ? 'cancelled' : 'paused');
    } finally { await f.close(); }
  }
});

test('canonical maintenance expires pending and activated waits once without reviving closed keys', async () => {
  for (const activated of [false, true]) {
    const f = await canonicalTaskTools(['wait_for_event']);
    try {
      const task = f.start(), rpc = f.stage(task, { event: 'ready', timeoutSeconds: 2 }, 'wait_for_event');
      await assert.rejects(rpc.async(), code('device_offline'));
      const row = f.db.prepare('SELECT * FROM wait_provisions').get()!, provision = storedTurnProvision(row.request_json);
      const result = { requestId: randomUUID(), provisionId: provision.provisionId, payloadDigest: provision.payloadDigest, waitKey: provision.waitKey, secretGeneration: 1, sourceDeviceGeneration: 1, state: 'ready', secretRef: JSON.stringify([provision.waitKey, 1]) };
      if (activated) f.tasks.waitSecretResult(f.principal, result);
      const until = provision.deadline + 5000;
      while (f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.taskId)!.state !== 'failed') {
        assert(Date.now() < until, 'Rust maintenance expires the wait');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(Date.now() >= provision.deadline);
      assert.equal(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.taskId)!.state, 'failed');
      const revision = f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.taskId)!.revision;
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.taskId)!.revision, revision);
      if (!activated) {
        assert.equal(f.tasks.waitSecretResult(f.principal, result).data.state, 'closed');
        assert.equal(f.db.prepare('SELECT count(*) n FROM turn_waits').get()!.n, 0);
      } else {
        assert.equal(f.db.prepare('SELECT status FROM turn_waits').get()!.status, 'expired');
        assert.equal(f.tasks.waitSecretResult(f.principal, result).data.state, 'activated', 'Exact ACK remains immutable after expiry');
      }
      assert.equal(f.db.prepare('SELECT count(*) n FROM task_results').get()!.n, 1);
    } finally { await f.close(); }
  }
});

test('canonical wait maintenance survives SQLite failure and retries after storage recovers', async () => {
  const f = await canonicalTaskTools(['wait_for_event']);
  let snapshot: Awaited<ReturnType<typeof workspaceSnapshot>> | undefined;
  let restarted: Awaited<ReturnType<typeof startRustServer>> | undefined;
  try {
    const task = f.start(), rpc = f.stage(task, { event: 'ready', timeoutSeconds: 60 }, 'wait_for_event');
    await assert.rejects(rpc.async(), code('device_offline'));
    const provision = storedTurnProvision(f.db.prepare('SELECT request_json FROM wait_provisions').get()!.request_json);
    f.tasks.waitSecretResult(f.principal, { requestId: randomUUID(), provisionId: provision.provisionId, payloadDigest: provision.payloadDigest, waitKey: provision.waitKey, secretGeneration: 1, sourceDeviceGeneration: 1, state: 'ready', secretRef: JSON.stringify([provision.waitKey, 1]) });
    snapshot = await workspaceSnapshot(f.db, f.owner.accountId);
    const saved = testDatabase(snapshot.file);
    saved.exec("UPDATE turn_waits SET deadline=0; CREATE TRIGGER fail_wait_maintenance BEFORE UPDATE ON turn_waits BEGIN SELECT RAISE(ABORT,'fixture wait maintenance failure'); END"); saved.close();
    restarted = await startRustServer({
      database: snapshot.file,
      auth: {
        secretKey: 'sk_test_fixture',
        publishableKey: 'pk_test_' + Buffer.from('fixture.clerk.accounts.dev$').toString('base64'),
        issuer: 'https://fixture.clerk.accounts.dev',
        origin: 'http://127.0.0.1',
        development: true,
      },
    });
    await new Promise(resolve => setTimeout(resolve, 1400));
    const response = await fetch(restarted.origin + '/api/session', {
      headers: { 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() },
      signal: AbortSignal.timeout(5000),
    });
    assert(response.status >= 400 && response.status < 500);
    const probe = testDatabase(snapshot.file);
    try {
      assert.equal(probe.prepare('SELECT status FROM turn_waits').get()!.status, 'waiting');
      probe.exec('DROP TRIGGER fail_wait_maintenance');
      const deadline = Date.now() + 5000;
      while (probe.prepare('SELECT status FROM turn_waits').get()!.status !== 'expired') {
        assert(Date.now() < deadline, 'Maintenance must retry after failure');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally { probe.close(); }
  } finally {
    await restarted?.close();
    snapshot?.cleanup(); await f.close();
  }
});

test('disaster restore closes pending provisions and activated wait references while keeping receipts', async () => {
  const f = await canonicalTaskTools(['wait_for_event']), directory = mkdtempSync(join(tmpdir(), 'minarbot-protected-wait-restore-'));
  let snapshot: Awaited<ReturnType<typeof workspaceSnapshot>> | undefined;
  try {
    for (const activated of [false, true]) {
      const task = f.start(), rpc = f.stage(task, { event: 'ready', timeoutSeconds: 60 }, 'wait_for_event');
      await assert.rejects(rpc.async(), code('device_offline'));
      const row = f.db.prepare('SELECT request_json FROM wait_provisions WHERE id=?').get(rpc.request.requestId)!;
      const provision = storedTurnProvision(row.request_json);
      if (activated) f.tasks.waitSecretResult(f.principal, { requestId: randomUUID(), provisionId: provision.provisionId, payloadDigest: provision.payloadDigest, waitKey: provision.waitKey, secretGeneration: 1, sourceDeviceGeneration: 1, state: 'ready', secretRef: JSON.stringify([provision.waitKey, 1]) });
    }
    const receipts = f.db.prepare('SELECT * FROM receipts ORDER BY request_id').all();
    snapshot = await workspaceSnapshot(f.db, f.owner.accountId);
    const path = join(directory, 'restored.sqlite');
    const binary = rustBinary('minarbot-server', process.env.MINARBOT_RUST_BINARY);
    execFileSync(binary, ['--restore-read-only', snapshot.file, path]);
    const restored = testDatabase(path);
    try {
      assert.deepEqual(restored.prepare('SELECT * FROM receipts ORDER BY request_id').all(), receipts);
      assert.equal(restored.prepare('SELECT count(*) n FROM wait_provisions').get()!.n, 2);
      assert.equal(restored.prepare("SELECT count(*) n FROM wait_provisions WHERE state='closed'").get()!.n, 2);
      assert.equal(restored.prepare('SELECT status FROM turn_waits').get()!.status, 'closed');
      assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'read_only_recovery');
    } finally { restored.close(); }
  } finally { snapshot?.cleanup(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('canonical shared data keeps schema ownership, collaborator scope, validation and atomic receipts',async()=>{
  const f=await canonicalTaskTools(['query_data','list_data_tables']);
  try{
    const first=f.start(),run=async(task:typeof first,sql:string,parameters?:unknown[])=>f.stage(task,{sql,...(parameters?{parameters}:{})},'query_data').async();
    assert.equal((await run(first,'CREATE TABLE notes(text TEXT)')).data.resultContent.revision,1);
    const secondAgent=randomUUID();await f.access.createAgent(f.owner,{requestId:secondAgent,id:secondAgent,name:'Other data agent',model:'fixture',backupModel:'',instructions:'Use project data',threadLimit:2,projectId:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});
    f.db.prepare('UPDATE agent_projects SET capabilities_json=? WHERE agent=?').run(JSON.stringify({v:1,tools:['query_data','list_data_tables'],resources:[]}),secondAgent);
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    const collaborator=f.start(f.member);assert.equal((await run(collaborator,'INSERT INTO notes VALUES (?)',['Shared project row'])).data.resultContent.revision,2);
    const command=f.command({agentId:secondAgent}),accepted=f.tasks.admit(f.owner,command),token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:command.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
    const other={taskId:command.requestId,token,ownership:parseOwnership(acquired.data.ownership),actor:f.owner,sequence:0};
    assert.equal(accepted.status,202);assert.match(String((await run(other,'DROP TABLE notes')).data.resultContent.error),/authorized/);
    assert.deepEqual((await run(other,'SELECT * FROM notes')).data.resultContent.rows,[['Shared project row']]);
    for(const args of [{sql:''},{sql:'SELECT 1; SELECT 2'},{sql:'ATTACH DATABASE \'/tmp/private\' AS hidden'},{sql:'SELECT ?',parameters:[true]}])assert.equal(typeof (await f.stage(first,args,'query_data').async()).data.resultContent.error,'string');
    const insert=f.stage(first,{sql:'INSERT INTO notes VALUES (?)',parameters:['Atomic row']},'query_data');
    f.db.exec("CREATE TRIGGER reject_data_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'result journal failed'); END");
    await assert.rejects(insert.async(),code('storage_failed'));assert.equal(f.db.prepare('SELECT revision FROM shared_data WHERE project=?').get(f.project)!.revision,2);
    f.db.exec('DROP TRIGGER reject_data_result');const saved=await insert.async();assert.equal(saved.data.resultContent.revision,3);
    assert.deepEqual(await insert.async(),saved);assert.deepEqual((await run(first,'SELECT text FROM notes ORDER BY rowid')).data.resultContent.rows,[['Shared project row'],['Atomic row']]);
    const denied=f.stage(collaborator,{sql:'INSERT INTO notes VALUES (\'Revoked\')'},'query_data'),deniedWork=denied.async();f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=2 WHERE project=? AND account=? AND agent=?').run(f.project,f.member.accountId,f.agent);
    await assert.rejects(deniedWork,code('execution_denied'));assert.equal(f.db.prepare('SELECT revision FROM shared_data WHERE project=?').get(f.project)!.revision,3);
    await assert.rejects(f.stage(first,{sql:'SELECT 1',project:f.project},'query_data').async(),code('unknown_field'));
  }finally{await f.close();}
});

function sharedWorkerGate() {
  const python = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-query-gate-'));
  const hold = join(directory, 'hold');
  writeFileSync(join(directory, 'python3'), `#!${python}
import os, pathlib, sys, time

root = pathlib.Path(__file__).parent
hold = root / 'hold'
if len(sys.argv) > 2 and sys.argv[2].endswith('/shared-data-worker.py') and hold.exists():
    (root / ('started-' + str(os.getpid()))).touch()
    while hold.exists():
        time.sleep(0.005)

os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
`, { mode: 0o700 });
  return {
    directory,
    arm() {
      for (const name of readdirSync(directory)) if (name.startsWith('started-')) rmSync(join(directory, name));
      writeFileSync(hold, '');
    },
    async started(count: number) {
      const deadline = performance.now() + 2000;
      while (readdirSync(directory).filter(name => name.startsWith('started-')).length < count) {
        assert(performance.now() < deadline, 'Rust started the expected shared query workers');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    release() { rmSync(hold, { force: true }); },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test('canonical shared data rechecks cancellation and authority across worker I/O and preserves concurrent conflicts',async()=>{
  const gate = sharedWorkerGate();
  const f = await canonicalTaskTools(['query_data', 'list_data_tables'], gate.directory).catch(error => {
    gate.close(); throw error;
  });
  try {
    const first = f.start(), second = f.start();
    const stage = (task: typeof first, sql: string) => f.stage(task, { sql }, 'query_data');
    await stage(first, 'CREATE TABLE notes(text TEXT)').async();

    const pending = stage(first, "INSERT INTO notes VALUES ('Once')");
    gate.arm();
    const repeated = Promise.all([pending.async(), pending.async()]);
    await gate.started(2);
    await assert.rejects(pending.async(), code('server_capacity'));
    gate.release();
    const [saved, duplicate] = await repeated;
    assert.deepEqual(duplicate, saved);
    assert.equal(saved.data.resultContent.revision, 2);

    const a = stage(first, "INSERT INTO notes VALUES ('First')"), b = stage(second, "INSERT INTO notes VALUES ('Second')");
    gate.arm();
    const concurrent = Promise.all([a.async(), b.async()]);
    await gate.started(2);
    gate.release();
    const results = await concurrent;
    assert.equal(results.filter(result => typeof result.data.resultContent.error === 'string').length, 1);
    assert.match(String(results.find(result => result.data.resultContent.error)!.data.resultContent.error), /Data changed/);

    gate.arm();
    const stale = stage(first, "INSERT INTO notes VALUES ('Stale')").async();
    const staleRejected = assert.rejects(stale, code('context_stale'));
    await gate.started(1);
    f.db.prepare('UPDATE agents SET revision=revision+1 WHERE id=?').run(f.agent);
    gate.release();
    await staleRejected;
    assert.equal(f.db.prepare('SELECT revision FROM shared_data WHERE project=?').get(f.project)!.revision, 3);

    gate.arm();
    const cancelled = stage(second, "INSERT INTO notes VALUES ('Cancelled')").async();
    const cancelledRejected = assert.rejects(cancelled, code('ownership_conflict'));
    await gate.started(1);
    const revision = Number(f.tasks.lookup(f.owner, second.taskId).data.revision);
    f.tasks.control(f.owner, second.taskId, { requestId: randomUUID(), expectedRevision: revision, operation: 'cancel' });
    await cancelledRejected;
    assert.equal(f.db.prepare('SELECT revision FROM shared_data WHERE project=?').get(f.project)!.revision, 3);
  } finally {
    gate.release();
    await f.close();
    gate.close();
  }
});

test('canonical cancellation kills SQL workers and releases query capacity',async()=>{
  const f=await canonicalTaskTools(['query_data']);
  try{
    const tasks=[f.start(),f.start()],sql='WITH RECURSIVE forever(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM forever) SELECT sum(n) FROM forever';
    const work=tasks.map(task=>f.stage(task,{sql},'query_data').async()),finished=Promise.allSettled(work),started=performance.now();
    for(const task of tasks)f.tasks.control(f.owner,task.taskId,{requestId:randomUUID(),expectedRevision:Number(f.tasks.lookup(f.owner,task.taskId).data.revision),operation:'cancel'});
    assert((await finished).every(result=>result.status==='rejected'));assert(performance.now()-started<1000,'Cancelled query workers must stop before their SQL deadline.');
    const next=f.start(),result=await f.stage(next,{sql:'SELECT 42'},'query_data').async();assert.deepEqual(result.data.resultContent.rows,[[42]]);
  }finally{await f.close();}
});

test('canonical questions validate limits and atomically pause, answer and retain cancellation',async()=>{
  const f=await canonicalTaskTools();
  let disconnect: (() => void) | undefined;
  try{
    disconnect = await f.devices.connect(f.principal, 'Asia/Jakarta', 1);
    const task=f.start();
    for(const args of [{question:'?',choices:['Yes',' Yes ']},{question:'',choices:[]},{question:'?',choices:Array(9).fill('x')},{question:'?',choices:[2]},{question:'x'.repeat(2001),choices:[]}])assert.equal((f.stage(task,args)().data.resultContent as {status:number}).status,400);
    assert.deepEqual(f.tasks.lookup(f.owner,task.taskId).data.questions,[]);
    const ask=f.stage(task,{question:' Continue? ',choices:[' Yes ','No']});
    f.db.exec("CREATE TRIGGER fail_question_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'question result failed'); END");
    assert.throws(ask,code('storage_failed'));assert.deepEqual(f.tasks.lookup(f.owner,task.taskId).data.questions,[]);assert.equal(f.tasks.lookup(f.owner,task.taskId).data.state,'running');
    f.db.exec('DROP TRIGGER fail_question_result');
    const saved=ask(),question=(saved.data.resultContent as {id:string}).id;
    assert.deepEqual(ask(),saved);assert.equal(f.tasks.lookup(f.owner,task.taskId).data.state,'paused');
    assert.throws(()=>f.tasks.control(f.owner,task.taskId,{requestId:randomUUID(),expectedRevision:saved.receipt.recordRevision,operation:'reassign',recipientAgentId:f.agent}),code('question_pending'));
    const answer={requestId:randomUUID(),expectedRevision:saved.receipt.recordRevision,text:'Yes'};
    f.db.exec("CREATE TRIGGER fail_question_answer BEFORE INSERT ON question_answers BEGIN SELECT RAISE(ABORT,'answer failed'); END");
    assert.throws(()=>f.tasks.answer(f.owner,task.taskId,question,answer),code('storage_failed'));
    const unchanged=f.tasks.lookup(f.owner,task.taskId);assert.equal(unchanged.data.state,'paused');assert.equal(unchanged.data.revision,answer.expectedRevision);assert.equal((unchanged.data.questions as {answer:null}[])[0].answer,null);
    f.db.exec('DROP TRIGGER fail_question_answer');
    const answered=f.tasks.answer(f.owner,task.taskId,question,answer);assert.equal(answered.data.state,'running');assert.deepEqual(f.tasks.answer(f.owner,task.taskId,question,answer),answered);
    assert.throws(()=>f.tasks.answer(f.owner,task.taskId,question,{...answer,requestId:randomUUID(),expectedRevision:answered.receipt.recordRevision}),code('question_closed'));
    for(let n=1;n<8;n++){const asked=f.stage(task,{question:`Question ${n}`,choices:[]})(),qid=(asked.data.resultContent as {id:string}).id;f.tasks.answer(f.owner,task.taskId,qid,{requestId:randomUUID(),expectedRevision:asked.receipt.recordRevision,text:'Free text'});}
    assert.equal((f.stage(task,{question:'Ninth question',choices:[]})().data.resultContent as {status:number}).status,409);assert.equal((f.tasks.lookup(f.owner,task.taskId).data.questions as unknown[]).length,8);
    const cancelled=f.start(),pending=f.stage(cancelled,{question:'Stop?',choices:[]}),pendingResult=pending(),pendingId=(pendingResult.data.resultContent as {id:string}).id;
    const stopped=f.tasks.control(f.owner,cancelled.taskId,{requestId:randomUUID(),expectedRevision:pendingResult.receipt.recordRevision,operation:'cancel'});
    assert.deepEqual(pending(),pendingResult);assert.throws(()=>f.tasks.answer(f.owner,cancelled.taskId,pendingId,{requestId:randomUUID(),expectedRevision:stopped.receipt.recordRevision,text:'Late'}),code('question_closed'));
    assert.equal(f.tasks.lookup(f.owner,cancelled.taskId).data.state,'cancelled');
  }finally{disconnect?.();await f.close();}
});

test('canonical question answers enforce private human, conversation, project and current collaborator access',async()=>{
  const f=await canonicalTaskTools();
  try{
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    const task=f.start(f.member),asked=f.stage(task,{question:'Member private?',choices:['Yes']})(),question=(asked.data.resultContent as {id:string}).id,answer={requestId:randomUUID(),expectedRevision:asked.receipt.recordRevision,text:'Yes'};
    assert.throws(()=>f.tasks.answer(f.owner,task.taskId,question,answer),code('resource_not_found'));
    assert.throws(()=>f.tasks.answer(f.foreign,task.taskId,question,answer),code('resource_not_found'));
    assert.throws(()=>f.tasks.answer(f.member,task.taskId,randomUUID(),answer),code('resource_not_found'));
    const other=f.start(f.member);assert.throws(()=>f.tasks.answer(f.member,other.taskId,question,answer),code('resource_not_found'));
    const answered=f.tasks.answer(f.member,task.taskId,question,answer);assert.equal(answered.receipt.actorId,f.member.accountId);
    f.db.prepare('UPDATE collaborator_agents SET enabled=0 WHERE account=?').run(f.member.accountId);
    assert.throws(()=>f.tasks.answer(f.member,task.taskId,question,answer),code('execution_denied'));
    f.db.prepare('UPDATE collaborator_agents SET enabled=1 WHERE account=?').run(f.member.accountId);
    const thread=randomUUID();f.db.prepare("INSERT INTO threads VALUES (?,?,'Side',1,0,0)").run(thread,f.agent);
    f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),f.member.accountId,f.project,thread);
    const side=f.start(f.member,{v:1,kind:'side',threadId:thread,message:{text:'Side question',files:[]}}),sideResult=f.stage(side,{question:'Side?',choices:[]})(),sideQuestion=(sideResult.data.resultContent as {id:string}).id;
    f.db.prepare('UPDATE threads SET archived=1,revision=revision+1 WHERE id=?').run(thread);
    assert.throws(()=>f.tasks.answer(f.member,side.taskId,sideQuestion,{requestId:randomUUID(),expectedRevision:sideResult.receipt.recordRevision,text:'Late'}),code('execution_denied'));
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead,revision,archived) VALUES (?,'Room','',NULL,1,0)").run(channel);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);
    f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const room=f.start(f.owner,{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Shared question',files:[]}}),roomResult=f.stage(room,{question:'Room?',choices:[]})(),roomQuestion=(roomResult.data.resultContent as {id:string}).id;
    assert.throws(()=>f.tasks.answer(f.member,side.taskId,roomQuestion,{requestId:randomUUID(),expectedRevision:sideResult.receipt.recordRevision,text:'Wrong conversation'}),code('resource_not_found'));
    assert.equal(f.tasks.answer(f.member,room.taskId,roomQuestion,{requestId:randomUUID(),expectedRevision:roomResult.receipt.recordRevision,text:'Shared answer'}).data.answer,'Shared answer');
    f.db.prepare('UPDATE project_members SET deleted=1 WHERE account=?').run(f.member.accountId);
    assert.throws(()=>f.tasks.answer(f.member,task.taskId,question,answer),code('resource_not_found'));
  }finally{await f.close();}
});

for(const kind of ['direct','side'] as const)test(`canonical avatar removal in ${kind} preserves CAS, rollback, scope and exact results`,async()=>{
  const f=await canonicalTaskTools(['set_avatar']);
  try{
    const thread=randomUUID();if(kind==='side'){f.db.prepare("INSERT INTO threads VALUES (?,?,'Side',1,0,0)").run(thread,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),f.owner.accountId,f.project,thread);}
    const task=f.start(f.owner,kind==='direct'?undefined:{v:1,kind:'side',threadId:thread,message:{text:'Remove avatar',files:[]}}),run=(args:unknown)=>f.stage(task,args,'set_avatar')();
    const snapshot=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision:2},task.token).data.snapshot as {profile:{avatarRevision:number}};
    assert.equal(snapshot.profile.avatarRevision,0);
    assert.deepEqual(run({image:null,revision:0}).data.resultContent,{revision:1,present:false});
    for(const revision of [-1,1.5,'1',Number.MAX_SAFE_INTEGER])assert.equal((run({image:null,revision}).data.resultContent as {status:number}).status,400);
    for(const image of [undefined,12,{},'bad'])assert.equal((run({image,revision:1}).data.resultContent as {status:number}).status,400);
    assert.equal((run({image:randomUUID(),revision:1}).data.resultContent as {status:number}).status,422);
    assert.equal((run({image:null,revision:0}).data.resultContent as {status:number}).status,409);
    f.db.prepare('UPDATE agent_avatars SET image=?,revision=2 WHERE agent=?').run(Buffer.from('saved image'),f.agent);
    const deletion=f.stage(task,{image:null,revision:2},'set_avatar');
    f.db.exec("CREATE TRIGGER fail_avatar_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'avatar result failed'); END");assert.throws(deletion,code('storage_failed'));assert.equal(f.db.prepare('SELECT revision FROM agent_avatars WHERE agent=?').get(f.agent)!.revision,2);assert.equal(Buffer.from(f.db.prepare('SELECT image FROM agent_avatars WHERE agent=?').get(f.agent)!.image as Uint8Array).toString(),'saved image');
    f.db.exec('DROP TRIGGER fail_avatar_result');const saved=deletion();assert.deepEqual(saved.data.resultContent,{revision:3,present:false});assert.equal(f.db.prepare('SELECT image FROM agent_avatars WHERE agent=?').get(f.agent)!.image,null);
    f.db.prepare('UPDATE agent_avatars SET image=?,revision=4 WHERE agent=?').run(Buffer.from('later image'),f.agent);assert.deepEqual(deletion(),saved);assert.equal(f.db.prepare('SELECT revision FROM agent_avatars WHERE agent=?').get(f.agent)!.revision,4);
    const stale=f.stage(task,{image:null,revision:4},'set_avatar');f.db.prepare('UPDATE agent_avatars SET revision=5 WHERE agent=?').run(f.agent);assert.throws(stale,code('context_stale'));
    f.tasks.control(f.owner,task.taskId,{requestId:randomUUID(),expectedRevision:f.tasks.lookup(f.owner,task.taskId).data.revision,operation:'cancel'});assert.deepEqual(deletion(),saved);
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    const member=f.start(f.member),memberDelete=f.stage(member,{image:null,revision:5},'set_avatar');assert.deepEqual(memberDelete().data.resultContent,{revision:6,present:false});
    f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=2 WHERE project=? AND account=? AND agent=?').run(f.project,f.member.accountId,f.agent);assert.throws(memberDelete,code('execution_denied'));
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead,revision,archived) VALUES (?,'Room','',NULL,1,0)").run(channel);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const room=f.start(f.owner,{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Room avatar',files:[]}}),roomContext=f.tasks.context(f.principal,room.taskId,{requestId:randomUUID(),ownership:room.ownership,expectedTaskRevision:2},room.token).data.snapshot as {tools:unknown[]};assert.deepEqual(roomContext.tools,[]);assert.throws(()=>f.stage(room,{image:null,revision:6},'set_avatar')(),code('execution_denied'));
  }finally{await f.close();}
});

for(const kind of ['direct','side'] as const)test(`canonical sites in ${kind} page scoped metadata and retain atomic deletion`,async()=>{
  const f=await canonicalTaskTools(['list_sites','delete_site']);
  try{
    const other=randomUUID(),peer=randomUUID();f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    await f.access.createAgent(f.owner,{requestId:peer,id:peer,name:'Peer',model:'fixture',backupModel:'',instructions:'Peer',threadLimit:2,projectId:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});
    const seed=(id=randomUUID(),project=f.project,account=f.owner.accountId,agent=f.agent,visibility='owner',mapped=true,root=agent)=>{
      const source = '<p>PRIVATE_SITE_SOURCE</p>';
      f.db.prepare("INSERT INTO local_sites(id,agent,name,source,html,revision,updated) VALUES (?,?,'Scoped site',?,?,1,?)")
        .run(id, agent, source, source, new Date().toISOString());
      if(mapped)f.db.prepare("INSERT INTO record_scopes VALUES ('local_sites',?,?,?,?, 'agent',?)").run(JSON.stringify([id]),account,project,visibility,root);
      return id;
    };
    const sites=Array.from({length:12},(_,n)=>seed(`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`));
    const privateSite=seed(undefined,f.project,f.member.accountId),foreign=seed(undefined,other),foreignAgent=seed(undefined,f.project,f.owner.accountId,peer),unmapped=seed(undefined,f.project,f.owner.accountId,f.agent,'owner',false),wrongRoot=seed(undefined,f.project,f.owner.accountId,f.agent,'owner',true,peer),deleted=seed();f.db.prepare('UPDATE local_sites SET deleted=1 WHERE id=?').run(deleted);
    const thread=randomUUID();if(kind==='side'){f.db.prepare("INSERT INTO threads VALUES (?,?,'Side',1,0,0)").run(thread,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),f.owner.accountId,f.project,thread);}
    const task=f.start(f.owner,kind==='direct'?undefined:{v:1,kind:'side',threadId:thread,message:{text:'Sites',files:[]}}),run=(name:string,args:unknown)=>f.stage(task,args,name)();
    const first=run('list_sites',{}).data.resultContent as {sites:{id:string}[];next_after:string};assert.deepEqual(first.sites.map(row=>row.id),sites.slice(0,10));assert.equal(first.next_after,sites[9]);assert(!JSON.stringify(first).includes('PRIVATE_SITE_SOURCE'));
    const last=run('list_sites',{after:first.next_after.toUpperCase()}).data.resultContent as {sites:{id:string}[];next_after:null};assert.deepEqual(last.sites.map(row=>row.id),sites.slice(10));assert.equal(last.next_after,null);
    for(const after of [0,[],{},'bad'])assert.equal((run('list_sites',{after}).data.resultContent as {status:number}).status,400);
    for(const site of [privateSite,foreign,foreignAgent,unmapped,wrongRoot])assert.equal((run('delete_site',{site,revision:1}).data.resultContent as {status:number}).status,404);
    for(const revision of [0,1.5,Number.MAX_SAFE_INTEGER])assert.equal((run('delete_site',{site:sites[0],revision}).data.resultContent as {status:number}).status,400);
    assert.equal((run('delete_site',{site:sites[0],revision:2}).data.resultContent as {status:number}).status,409);
    const deletion=f.stage(task,{site:sites[0],revision:1},'delete_site');
    f.db.exec("CREATE TRIGGER fail_site_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'site result failed'); END");assert.throws(deletion,code('storage_failed'));assert.equal(f.db.prepare('SELECT revision FROM local_sites WHERE id=?').get(sites[0])!.revision,1);assert.equal(f.db.prepare('SELECT deleted FROM local_sites WHERE id=?').get(sites[0])!.deleted,0);
    f.db.exec('DROP TRIGGER fail_site_result');const saved=deletion();assert.deepEqual(saved.data.resultContent,{id:sites[0],name:'Scoped site',revision:2,deleted:1,path:null});assert.deepEqual(deletion(),saved);assert.equal(f.db.prepare('SELECT source FROM local_sites WHERE id=?').get(sites[0])!.source,'');
    assert.equal((run('delete_site',{site:sites[0],revision:2}).data.resultContent as {status:number}).status,410);
    f.tasks.control(f.owner,task.taskId,{requestId:randomUUID(),expectedRevision:f.tasks.lookup(f.owner,task.taskId).data.revision,operation:'cancel'});assert.deepEqual(deletion(),saved);
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    const member=f.start(f.member),shared=seed(undefined,f.project,f.owner.accountId,f.agent,'project');assert.equal((f.stage(member,{site:privateSite,revision:1},'delete_site')().data.resultContent as {deleted:number}).deleted,1);assert.equal((f.stage(member,{site:sites[1],revision:1},'delete_site')().data.resultContent as {status:number}).status,404);assert.equal((f.stage(member,{site:shared,revision:1},'delete_site')().data.resultContent as {deleted:number}).deleted,1);
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead,revision,archived) VALUES (?,'Room','',NULL,1,0)").run(channel);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    for(const name of ['list_sites','delete_site']){const room=f.start(f.owner,{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Room sites',files:[]}});assert.throws(()=>f.stage(room,name==='list_sites'?{}:{site:sites[1],revision:1},name)(),code('execution_denied'));}
  }finally{await f.close();}
});

test('reassign denies unresolved effects, revoked initiators and invalid successor provenance atomically', async () => {
  const f = await preparedTask(), recipient = randomUUID();
  try {
    await f.access.createAgent(f.owner, { requestId:recipient,id:recipient,name:'Recipient',model:'fixture',backupModel:'',instructions:'Continue',threadLimit:2,projectId:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null });
    const committed=f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    const paused=f.tasks.control(f.owner,f.taskId,{requestId:randomUUID(),expectedRevision:committed.receipt.recordRevision,operation:'pause'});
    const reassign={requestId:randomUUID(),expectedRevision:paused.receipt.recordRevision,operation:'reassign',recipientAgentId:recipient};
    assert.throws(()=>f.tasks.control(f.owner,f.taskId,reassign),code('outcome_unresolved'));
    assert.equal(f.tasks.lookup(f.owner,f.taskId).data.currentTaskId,f.taskId);
    const resultContent={text:'Reconciled'},resultDigest=sha256(canonicalJson(resultContent));
    const published=f.tasks.reconcile(f.principal,f.taskId,{requestId:randomUUID(),actionId:f.actionId,ownership:f.ownership,payloadDigest:f.payloadDigest,state:'acknowledged',effectStatus:'known',journalSequence:2,resultContent,resultDigest,resultRef:{v:1,taskId:f.taskId,actionId:f.actionId,digest:resultDigest,size:Buffer.byteLength(canonicalJson(resultContent)),encoding:'canonical-json-v1'}},f.token);
    reassign.expectedRevision=published.receipt.recordRevision;
    const transferred=f.tasks.control(f.owner,f.taskId,reassign), next=String(transferred.data.taskId);
    assert.throws(()=>f.tasks.context(f.principal,f.taskId,{requestId:randomUUID(),ownership:f.ownership,expectedTaskRevision:reassign.expectedRevision},f.token),code('ownership_conflict'));
    const original=f.db.prepare('SELECT * FROM tasks WHERE id=?').get(next)!;
    const unused=f.command(); f.tasks.admit(f.owner,unused);
    f.db.prepare("UPDATE tasks SET state='transferred' WHERE id=?").run(unused.requestId);
    const columns=Object.keys(original), insert=f.db.prepare(`INSERT INTO tasks(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    const base: typeof original={...original,id:randomUUID(),logical_turn:unused.requestId,predecessor_task:unused.requestId};
    const invalid: typeof original={...base,initiator_account:f.member.accountId};
    assert.throws(()=>insert.run(...columns.map(key=>invalid[key])),/invalid task successor provenance/);
    for (const key of ['capability_snapshot_json','capability_digest']) {
      const forged: typeof original={...base,[key]:key==='capability_snapshot_json'?'{}':'0'.repeat(64)};
      assert.throws(()=>insert.run(...columns.map(key=>forged[key])),/invalid task successor provenance/);
    }
    insert.run(...columns.map(key=>base[key]));
    f.db.prepare('UPDATE project_members SET deleted=1 WHERE project=? AND account=?').run(f.project,f.owner.accountId);
    assert.throws(()=>f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:next,previousExecutorGeneration:0,executorTokenHash:sha256(f.token),lockProof:{...f.lockProof,lockId:randomUUID()}},f.token),code('execution_denied'));
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
});

test('progress reports advance monotonically, immutable result publishes once and prepare sees changed context', async () => {
  const f = await preparedTask();
  try {
    f.access.editAgentRules(f.owner, f.project, f.agent, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'New rules' });
    assert.throws(() => f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token), code('context_stale'));
  } finally { await f.close(); }
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
  } finally { await g.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  }finally{await f.close();}
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
    assert.throws(() => f.tasks.admit(f.owner, { ...command, secret: 'forbidden' }), code('unknown_field'));
    assert.throws(() => f.tasks.admit(f.owner, { ...command, payload: { ...command.payload, role: 'admin' } }), code('unknown_field'));
    f.db.prepare('UPDATE agent_projects SET revision=2 WHERE project=? AND agent=?').run(f.project, f.agent);
    assert.equal(f.tasks.admit(f.owner, command).status, 200);
    assert.equal(f.tasks.lookup(f.owner, command.requestId).data.currentTaskId, command.requestId);
    assert.throws(() => f.db.prepare('UPDATE tasks SET home_device=? WHERE id=?').run(randomUUID(), command.requestId), /immutable task admission/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM turns').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_actions').get()!.n, 0);
  } finally { await f.close(); }
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
  } finally { await f.close(); }
});

test('task messages require files, preserve line breaks, and closed union rejects mixed routing', async () => {
  const f = await fixture();
  try {
    const command = f.command({ payload: { v: 1, kind: 'direct', message: { text: 'First\nSecond\tIndented', files: [] } } });
    assert.equal(f.tasks.admit(f.owner, command).status, 202);
    assert.throws(() => f.tasks.admit(f.owner, f.command({ payload: { v: 1, kind: 'direct', message: { text: 'No files' } } })), code('invalid_attachments'));
    assert.throws(() => f.tasks.admit(f.owner, f.command({ payload: { v: 1, kind: 'channel', channelId: randomUUID(), threadId: randomUUID(), routing: 'assigned', message: { text: 'Mixed', files: [] } }, expectedRevisions: { ...command.expectedRevisions, channel: 1 } })), code('invalid_task_payload'));
    assert.throws(() => f.tasks.admit(f.owner, f.command({ payload: { v: 1, kind: 'direct', message: { text: 'Foreign attachment', files: [randomUUID()] } } })), code('resource_not_found'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 1);
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  } finally { await f.close(); }
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
  }finally{await f.close();}
});

async function canonicalTransfer() {
  const f = await fixture(), recipient = randomUUID(), channel=randomUUID();
  await f.access.createAgent(f.owner, { requestId: recipient, id: recipient, name: 'Recipient', model: 'fixture', backupModel: '', instructions: 'Continue', threadLimit: 2, projectId: f.project, homeDeviceId: f.home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null });
  f.db.prepare('INSERT INTO channels(id,name,instructions,lead) VALUES (?,?,?,?)').run(channel,'Transfer','Project work',f.agent);
  for(const agent of [f.agent,recipient]) f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);
  f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
  const command=f.command({payload:{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Research this',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,channel:1}}),taskId=command.requestId;
  f.tasks.admit(f.owner, command);
  const token = randomBytes(32).toString('base64url');
  const acquired = f.tasks.acquire(f.principal, { requestId: randomUUID(), taskId, previousExecutorGeneration: 0, executorTokenHash: sha256(token), lockProof: { bootId: randomUUID(), processId: 1234, processStart: '999', lockId: randomUUID(), previousOwnerStopped: true, reconciledThrough: 0, journalDigest: sha256('journal') } }, token);
  const ownership = parseOwnership(acquired.data.ownership), revision = acquired.receipt.recordRevision;
  const context = f.tasks.context(f.principal, taskId, { requestId: randomUUID(), ownership, expectedTaskRevision: revision }, token).data as ActionContext;
  const actionId = randomUUID(), toolCall = { id: 'transfer', function: { name: 'transfer_task', arguments: JSON.stringify({ recipient, task: 'Continue from saved evidence' }) } };
  const payload = { toolCall, expectedRevision: revision + 1 }, payloadDigest = canonicalToolDigest(payload);
  const intentDigest = digestCommand([taskId,actionId,0,ownership,payloadDigest,'canonical',context.snapshotRef.snapshotId,context.snapshotRef.digest,null,null,1,null,null,null]);
  f.tasks.prepare(f.principal, taskId, actionId, { requestId: randomUUID(), sequence: 0, ownership, payloadDigest, actionKind: 'canonical', contextSnapshotId: context.snapshotRef.snapshotId, contextDigest: context.snapshotRef.digest, grantRevision: 1, expectedTaskRevision: revision, journalSequence: 1, intentDigest }, token);
  const commit = { requestId: randomUUID(), ownership, intentDigest, expectedTaskRevision: revision, journalSequence: 1 };
  const mutation = { ...payload, requestId: randomUUID(), actionId, ownership, payloadDigest };
  return { ...f, taskId, recipient, token, ownership, actionId, context, commit, mutation };
}

test('canonical transfer commits one successor and immutable result, fences old executor and retries without mutation', async () => {
  const f = await canonicalTransfer();
  try {
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, { ...f.mutation, expectedRevision: 2, payloadDigest: canonicalToolDigest({ toolCall: f.mutation.toolCall, expectedRevision: 2 }) }, f.token), code('action_conflict'));
    f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const result = f.tasks.contextMutations(f.principal, f.taskId, f.mutation, f.token);
    const content = result.data.resultContent as Record<string, unknown>, successor = String(content.taskId);
    assert.notEqual(successor, f.taskId);
    assert.equal(content.homeDeviceId, f.home);
    assert.equal(f.tasks.lookup(f.owner, f.taskId).data.state, 'transferred');
    assert.equal(f.tasks.lookup(f.owner, f.taskId).data.currentTaskId, successor);
    assert.equal(f.tasks.lookup(f.owner, successor).data.agentId, f.recipient);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT payload_json FROM tasks WHERE id=?').get(successor)!.payload_json)).message.text, 'Continue from saved evidence');
    assert.deepEqual(f.tasks.contextMutations(f.principal, f.taskId, f.mutation, f.token), result);
    assert.equal(f.db.prepare('SELECT count(*) n FROM tasks WHERE logical_turn=?').get(f.taskId)!.n, 2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_results WHERE action=?').get(f.actionId)!.n, 1);
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, { ...f.mutation, actionId: randomUUID() }, f.token), code('payload_conflict'));
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, f.mutation, 'x'.repeat(43)), code('executor_invalid'));
    assert.throws(() => f.tasks.contextMutations({ ...f.principal, deviceId: randomUUID() }, f.taskId, f.mutation, f.token));
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, { ...f.mutation, requestId: randomUUID() }, f.token), code('ownership_conflict'));
    f.db.prepare('UPDATE project_members SET deleted=1 WHERE project=? AND account=?').run(f.project, f.owner.accountId);
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, f.mutation, f.token), code('execution_denied'));
  } finally { await f.close(); }
});

test('canonical RPC rejects changed input, stale grants and fabricated results without partial transfer', async () => {
  const f = await canonicalTransfer();
  try {
    const committed = f.tasks.commit(f.principal, f.taskId, f.actionId, f.commit, f.token);
    const changedCall = { ...f.mutation.toolCall, function: { ...f.mutation.toolCall.function, arguments: JSON.stringify({ recipient: f.recipient, task: 'Changed' }) } };
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, { ...f.mutation, toolCall: changedCall }, f.token), code('payload_digest_mismatch'));
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, { ...f.mutation, toolCall: changedCall, payloadDigest: canonicalToolDigest({ toolCall: changedCall, expectedRevision: f.mutation.expectedRevision }) }, f.token), code('action_conflict'));
    const content = { text: 'Forged' }, digest = sha256(canonicalJson(content));
    assert.throws(() => f.tasks.reconcile(f.principal, f.taskId, { requestId: randomUUID(), actionId: f.actionId, ownership: f.ownership, payloadDigest: f.mutation.payloadDigest, state: 'reported', effectStatus: 'known', journalSequence: 2, resultContent: content, resultDigest: digest, resultRef: { v: 1, taskId: f.taskId, actionId: f.actionId, digest, size: Buffer.byteLength(canonicalJson(content)), encoding: 'canonical-json-v1' } }, f.token), code('canonical_result_required'));
    f.access.editAgentRules(f.owner, f.project, f.agent, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'Changed after commit' });
    assert.throws(() => f.tasks.contextMutations(f.principal, f.taskId, f.mutation, f.token), code('context_stale'));
    assert.equal(f.tasks.lookup(f.owner, f.taskId).data.revision, committed.receipt.recordRevision);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_results').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT stopped FROM execution_owners WHERE task=?').get(f.taskId)!.stopped, 0);
  } finally { await f.close(); }
});

test('canonical transfer keeps channel-only tool boundary for private tasks', async () => {
  const f=await preparedTask();
  try {
    const payload={toolCall:{id:'transfer',function:{name:'transfer_task',arguments:JSON.stringify({recipient:randomUUID(),task:'Handoff'})}},expectedRevision:2};
    assert.throws(()=>f.tasks.contextMutations(f.principal,f.taskId,{...payload,requestId:randomUUID(),actionId:randomUUID(),ownership:f.ownership,payloadDigest:canonicalToolDigest(payload)},f.token),code('execution_denied'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n,1);
  } finally {await f.close();}
});


test('context projects authorized memory, pinned skills and byte-free asset refs, invalidating changed sources', async () => {
  const f=await preparedTask();
  try {
    initializeMemory(f.db);initializeSkills(f.db);initializeQuestions(f.db);initializeCompaction(f.db);
    const scope=`project:${f.project}/agents:${f.agent}/human:${f.owner.accountId}`;
    const memory=rememberMemory(f.db,scope,{text:'Project A decision'});
    f.db.prepare('UPDATE memories SET essential=1 WHERE scope=? AND id=?').run(scope,memory.id);
    f.db.prepare("INSERT INTO record_scopes VALUES ('memories',?,?,?,?,?,?)").run(JSON.stringify([scope,memory.id]),f.owner.accountId,f.project,'owner','agent',f.agent);
    const privateScope=`private:${f.member.accountId}`,privateMemory=rememberMemory(f.db,privateScope,{text:'PRIVATE_OTHER_HUMAN'});
    f.db.prepare('UPDATE memories SET essential=1 WHERE scope=? AND id=?').run(privateScope,privateMemory.id);
    f.db.prepare("INSERT INTO record_scopes VALUES ('memories',?,?,?,?,?,?)").run(JSON.stringify([privateScope,privateMemory.id]),f.member.accountId,f.project,'owner','agent',f.agent);
    rememberMemory(f.db,'agents:'+f.agent,{text:'UNMAPPED_LEGACY_PRIVATE'});
    const skill=randomUUID();saveSkill(f.db,skill,{revision:0,name:'Pinned skill',description:'Reference configuration',content:'Use project rules'});
    saveSkill(f.db,skill,{revision:1,name:'Latest skill',description:'Must not substitute',content:'UNINSTALLED_LATEST_VERSION'});
    f.db.prepare('INSERT INTO agent_skills(agent,skill,version,enabled,revision,removed) VALUES (?,?,1,1,7,0)').run(f.agent,skill);
    const raw=Buffer.from('PRIVATE_ASSET_BYTES');f.db.prepare('INSERT INTO skill_files VALUES (?,1,?)').run(skill,JSON.stringify([{path:'asset.bin',content:raw.toString('base64'),encoding:'base64'}]));
    for(const [table,key] of [['skills',[skill]],['skill_versions',[skill,1]],['agent_skills',[f.agent,skill]],['skill_files',[skill,1]] ] as const)f.db.prepare("INSERT INTO record_scopes VALUES (?,?,?,?,?,?,?)").run(table,JSON.stringify(key),f.owner.accountId,f.project,'owner','agent',f.agent);
    f.db.prepare("UPDATE task_actions SET state='not_sent',effect_status='none' WHERE id=?").run(f.actionId);
    const context=f.tasks.context(f.principal,f.taskId,{requestId:randomUUID(),ownership:f.ownership,expectedTaskRevision:2},f.token).data as ActionContext;
    const snapshot=context.snapshot as typeof context.snapshot&{memories:{text:string}[];skills:{id:string;revision:number;installationRevision:number}[];skillAssets:{source:string;digest:string;size:number}[];sourceRevisions:{kind:string;id:string;revision:number}[];tools:{function:{name:string}}[]};
    assert.equal(snapshot.memories[0].text,'Project A decision');assert.equal(snapshot.memories.length,1);
    assert.equal(snapshot.skills[0].id,skill);assert.equal(snapshot.skills[0].revision,1);assert.equal(snapshot.skills[0].installationRevision,7);
    assert.deepEqual(snapshot.skillAssets,[{skillId:skill,skillRevision:1,installationRevision:7,source:'asset.bin',digest:sha256(raw),size:raw.byteLength}]);
    assert.equal(snapshot.tools.length,0);
    const encoded=canonicalJson(snapshot);for(const secret of ['PRIVATE_OTHER_HUMAN','UNMAPPED_LEGACY_PRIVATE','UNINSTALLED_LATEST_VERSION','PRIVATE_ASSET_BYTES',raw.toString('base64')])assert(!encoded.includes(secret));
    assert.equal(context.snapshotRef.digest,sha256(encoded));
    f.db.prepare('UPDATE memories SET text=?,revision=revision+1 WHERE scope=? AND id=?').run('Changed decision',scope,memory.id);
    const actionId=randomUUID(),payloadDigest=sha256('next'),intentDigest=digestCommand([f.taskId,actionId,1,f.ownership,payloadDigest,'read',context.snapshotRef.snapshotId,context.snapshotRef.digest,null,null,1,null,null,null]);
    const prepare={requestId:randomUUID(),sequence:1,ownership:f.ownership,payloadDigest,actionKind:'read',contextSnapshotId:context.snapshotRef.snapshotId,contextDigest:context.snapshotRef.digest,grantRevision:1,expectedTaskRevision:2,journalSequence:2,intentDigest};
    assert.throws(()=>f.tasks.prepare(f.principal,f.taskId,actionId,prepare,f.token),code('context_stale'));
    const next=f.tasks.context(f.principal,f.taskId,{requestId:randomUUID(),ownership:f.ownership,expectedTaskRevision:2},f.token).data as ActionContext;
    f.db.prepare('UPDATE agent_skills SET enabled=0,revision=revision+1 WHERE agent=? AND skill=?').run(f.agent,skill);
    assert.throws(()=>f.tasks.prepare(f.principal,f.taskId,actionId,{...prepare,contextSnapshotId:next.snapshotRef.snapshotId,contextDigest:next.snapshotRef.digest,intentDigest:digestCommand([f.taskId,actionId,1,f.ownership,payloadDigest,'read',next.snapshotRef.snapshotId,next.snapshotRef.digest,null,null,1,null,null,null])},f.token),code('context_stale'));
  } finally {await f.close();}
});

test('context preserves scoped history, questions, compaction and child evidence without foreign records or file bytes', async () => {
  const f = await fixture();
  try {
    initializeQuestions(f.db); initializeCompaction(f.db);
    f.db.exec(`CREATE TABLE IF NOT EXISTS routines(id TEXT PRIMARY KEY,agent TEXT);
      CREATE TABLE IF NOT EXISTS coordination(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT,owner TEXT,target TEXT,kind TEXT,prompt TEXT,call TEXT,child TEXT);
      CREATE TABLE IF NOT EXISTS files(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,scope TEXT,name TEXT,digest TEXT,bytes BLOB,created TEXT);
      CREATE TABLE IF NOT EXISTS generated_files(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT,file TEXT,call_id TEXT,call TEXT,after_action INTEGER);`);
    const otherProject = randomUUID(); f.access.createProject(f.owner,{requestId:randomUUID(),id:otherProject,name:'Other'});
    const turn = (text: string, project=f.project, account=f.owner.accountId, root=f.agent) => {
      const id=randomUUID();
      f.db.prepare("INSERT INTO turns(id,agent,text,reply,status,created) VALUES (?,?,?,?,'done','fixture')").run(id,f.agent,text,`${text} reply`);
      f.db.prepare("INSERT INTO record_scopes VALUES ('turns',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),account,project,root);
      return id;
    };
    const old = Array.from({length:42},(_,i)=>turn(`History ${i}`));
    const privateTurn=turn('PRIVATE_HUMAN',f.project,f.member.accountId), foreignTurn=turn('FOREIGN_PROJECT',otherProject);
    turn('OTHER_CONVERSATION',f.project,f.owner.accountId,randomUUID());
    const scope=`project:${f.project}/agent:${f.agent}/human:${f.owner.accountId}`;
    const through=Number(f.db.prepare('SELECT seq FROM turns WHERE id=?').get(old[0])!.seq);
    f.db.prepare('INSERT INTO compactions VALUES (?,?,?,?)').run(scope,randomUUID(),through,'Earlier summary');
    f.db.prepare("INSERT INTO compaction_sources VALUES (?,?,1,'done')").run(scope,through);
    f.db.prepare("INSERT INTO record_scopes VALUES ('compactions',?,?,?,'owner','agent',?)").run(JSON.stringify([scope]),f.owner.accountId,f.project,f.agent);
    const command=f.command(),taskId=command.requestId; f.tasks.admit(f.owner,command);
    const child=turn('Visible child',f.project,f.owner.accountId,randomUUID());
    const call=(id:string)=>({id,function:{name:'search_memory',arguments:'{}'}});
    for(const target of [child,privateTurn,foreignTurn]) f.db.prepare('INSERT INTO coordination(turn,owner,target,kind,prompt,call,child) VALUES (?,?,?,?,?,?,?)').run(taskId,f.agent,f.agent,'delegate_task','Subtask',JSON.stringify(call(target)),target);
    for(const [id,result] of [[taskId,'Parent result'],[child,'Child result'],[privateTurn,'PRIVATE_TOOL'],[foreignTurn,'FOREIGN_TOOL']]) f.db.prepare('INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES (?,?,?,?,0,0)').run(id,id,JSON.stringify(call(id)),JSON.stringify({text:result}));
    const file=randomUUID(),raw=Buffer.from('ATTACHMENT_BYTES');
    f.db.prepare("INSERT INTO files(id,scope,name,digest,bytes,created) VALUES (?,'legacy-private','result.txt',?,?,'fixture')").run(file,sha256(raw),raw);
    f.db.prepare("INSERT INTO record_scopes VALUES ('files',?,?,?,'owner','agent',?)").run(JSON.stringify([file]),f.owner.accountId,f.project,f.agent);
    f.db.prepare('INSERT INTO generated_files(turn,file,call_id,call,after_action) VALUES (?,?,?,?,0)').run(child,file,'output',JSON.stringify(call('output')));
    const question=randomUUID(); f.db.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?,?,0,0)').run(question,old[5],'question',JSON.stringify(call('question')),'Keep scope?',JSON.stringify(['Yes']),'Yes');
    const token=randomBytes(32).toString('base64url'),acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
    const ownership=parseOwnership(acquired.data.ownership),request={requestId:randomUUID(),ownership,expectedTaskRevision:2};
    const context=f.tasks.context(f.principal,taskId,request,token).data as ActionContext;
    const snapshot=context.snapshot as typeof context.snapshot & {conversation:{history:{text:string}[];questions:{id:string}[];compaction:{summary:string}|null};coordination:{child?:{reply:string}}[];toolJournal:{result:{text:string}}[];artifacts:unknown[]};
    assert.equal(snapshot.conversation.history.length,40); assert.equal(snapshot.conversation.history[0].text,'History 2');
    assert.equal(snapshot.conversation.compaction?.summary,'Earlier summary'); assert.equal(snapshot.conversation.questions[0].id,question);
    assert.equal(snapshot.coordination.filter(row=>row.child).length,1); assert.equal(snapshot.coordination[0].child?.reply,'Visible child reply');
    assert.equal(snapshot.coordination.length,1);
    assert.deepEqual(snapshot.toolJournal.map(row=>row.result.text).filter(Boolean),['Parent result','Child result']);
    assert.equal((snapshot.toolJournal.at(-1) as unknown as {kind:string}).kind,'generated_output');
    assert.deepEqual(snapshot.artifacts,[{id:file,name:'result.txt',digest:sha256(raw),size:raw.length}]);
    const encoded=canonicalJson(snapshot); for(const secret of ['PRIVATE_HUMAN','FOREIGN_PROJECT','OTHER_CONVERSATION','PRIVATE_TOOL','FOREIGN_TOOL','ATTACHMENT_BYTES','legacy-private']) assert(!encoded.includes(secret));
    f.db.prepare('UPDATE flow_tool_calls SET result=? WHERE turn=?').run(JSON.stringify({text:'Changed child'}),child);
    const actionId=randomUUID(),payloadDigest=sha256('read'),ref=context.snapshotRef;
    const prepare={requestId:randomUUID(),sequence:0,ownership,payloadDigest,actionKind:'read',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision:2,journalSequence:1,intentDigest:digestCommand([taskId,actionId,0,ownership,payloadDigest,'read',ref.snapshotId,ref.digest,null,null,1,null,null,null])};
    assert.throws(()=>f.tasks.prepare(f.principal,taskId,actionId,prepare,token),code('context_stale'));
    assert.equal(canonicalJson(f.tasks.context(f.principal,taskId,request,token).data),canonicalJson(context));
    const privateSeq=f.db.prepare('SELECT seq FROM turns WHERE id=?').get(privateTurn)!.seq;
    f.db.prepare("INSERT INTO compaction_sources VALUES (?,?,1,'done')").run(scope,privateSeq);
    const fresh=f.tasks.context(f.principal,taskId,{...request,requestId:randomUUID()},token).data as typeof context;
    assert.equal((fresh.snapshot as typeof snapshot).conversation.compaction,null);
    const count=f.db.prepare('SELECT count(*) n FROM task_context_snapshots').get()!.n;
    f.db.prepare('UPDATE flow_tool_calls SET result=? WHERE turn=?').run(JSON.stringify({text:'x'.repeat(9*1024*1024)}),child);
    assert.throws(()=>f.tasks.context(f.principal,taskId,{...request,requestId:randomUUID()},token),code('context_too_large'));
    assert.equal(canonicalJson(f.tasks.context(f.principal,taskId,request,token).data),canonicalJson(context));
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_context_snapshots').get()!.n,count);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_actions').get()!.n,0);
  } finally { await f.close(); }
});


test('canonical history retains sequence cursors and excludes unmapped, foreign, private and future originals', async () => {
  const f = await fixture(['read_history','read_message']);
  try {
    initializeQuestions(f.db);
    f.db.exec(`CREATE TABLE IF NOT EXISTS queue_positions(turn TEXT PRIMARY KEY,position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,scope TEXT,name TEXT,digest TEXT,bytes BLOB,created TEXT);
      CREATE TABLE IF NOT EXISTS generated_files(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT,file TEXT,call_id TEXT,call TEXT,after_action INTEGER);`);
    const other = randomUUID(); f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    const seed = (text: string, project=f.project, account=f.owner.accountId, root=f.agent, mapped=true) => {
      const id=randomUUID(), row=f.db.prepare("INSERT INTO turns(id,agent,text,reply,status,created) VALUES (?,?,?,?,'done','fixture')").run(id,f.agent,text,'Saved original reply');
      if(mapped)f.db.prepare("INSERT INTO record_scopes VALUES ('turns',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),account,project,root);
      return {id,seq:Number(row.lastInsertRowid)};
    };
    const originals=Array.from({length:8},(_,i)=>seed(`Original ${i}`)),privateTurn=seed('PRIVATE',f.project,f.member.accountId),foreign=seed('FOREIGN',other),otherRoot=seed('OTHER_ROOT',f.project,f.owner.accountId,randomUUID()),unmapped=seed('UNMAPPED',f.project,f.owner.accountId,f.agent,false);
    f.db.prepare('INSERT INTO queue_positions VALUES (?,?)').run(originals[5].id,originals[4].seq);
    f.db.prepare('INSERT INTO queue_positions VALUES (?,?)').run(originals[4].id,originals[5].seq);
    f.db.prepare("UPDATE turns SET status='failed' WHERE id=?").run(originals[0].id);
    const file=randomUUID(),blockedFile=randomUUID(),raw=Buffer.from('SOURCE_DEVICE_BYTES');
    for(const [id,account] of [[file,f.owner.accountId],[blockedFile,f.member.accountId]]){
      f.db.prepare("INSERT INTO files(id,scope,name,digest,bytes,created) VALUES (?,'legacy-private','original.txt',?,?,'fixture')").run(id,sha256(raw),raw);
      f.db.prepare("INSERT INTO record_scopes VALUES ('files',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),account,f.project,f.agent);
    }
    f.db.prepare('UPDATE turns SET attachments=? WHERE id=?').run(JSON.stringify([file,blockedFile]),originals[0].id);
    f.db.prepare('INSERT INTO generated_files(turn,file,call_id,call,after_action) VALUES (?,?,?,?,0)').run(originals[0].id,file,'file',JSON.stringify({function:{name:'create_text_file'}}));
    f.db.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?,?,0,0)').run(randomUUID(),originals[0].id,'question','{}','Keep original?',JSON.stringify(['Yes']),'Yes');
    const task=f.command();f.tasks.admit(f.owner,task);
    const token=randomBytes(32).toString('base64url'),acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:task.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);
    const future=seed('FUTURE');let sequence=0;
    const run=(name:string,args:unknown)=>{
      const taskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision),context=f.tasks.context(f.principal,task.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision:taskRevision},token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID();
      const toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=taskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision});
      const intentDigest=digestCommand([task.requestId,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.requestId,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision:taskRevision,journalSequence:sequence+1,intentDigest},token);
      f.tasks.commit(f.principal,task.requestId,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision:taskRevision,journalSequence:sequence+1},token);sequence++;
      const request={requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision};
      return {request,result:f.tasks.contextMutations(f.principal,task.requestId,request,token)};
    };
    const page=run('read_history',{}).result.data.resultContent as {messages:{id:string}[];next_before:number};
    assert.deepEqual(page.messages.map(row=>row.id),originals.slice(3).reverse().map(row=>row.id));assert.equal(page.next_before,originals[3].seq);
    const next=run('read_history',{before:page.next_before}).result.data.resultContent as {messages:{id:string}[];next_before:null};
    assert.deepEqual(next.messages.map(row=>row.id),originals.slice(0,3).reverse().map(row=>row.id));assert.equal(next.next_before,null);
    const read=run('read_message',{id:originals[0].id}),content=read.result.data.resultContent as {attachments:{id:string}[];generatedFiles:{id:string}[];questions:{answer:string}[];status:string};
    assert.deepEqual(content.attachments.map(row=>row.id),[file]);assert.deepEqual(content.generatedFiles.map(row=>row.id),[file]);assert.equal(content.questions[0].answer,'Yes');assert.equal(content.status,'failed');assert(!JSON.stringify(content).includes('SOURCE_DEVICE_BYTES'));
    for(const row of [privateTurn,foreign,otherRoot,unmapped,future,{id:task.requestId}])assert.match(String((run('read_message',{id:row.id}).result.data.resultContent as {error:string}).error),/not found/);
    assert.equal((run('read_history',{before:0}).result.data.resultContent as {status:number}).status,400);
    assert.equal((run('read_message',{id:originals[0].id,offset:-1}).result.data.resultContent as {status:number}).status,400);
    f.db.prepare('UPDATE turns SET text=?,revision=revision+1 WHERE id=?').run('Changed original',originals[0].id);
    assert.equal(canonicalJson(f.tasks.contextMutations(f.principal,task.requestId,read.request,token)),canonicalJson({...read.result,status:200}));
  }finally{await f.close();}
});

test('canonical skills retain installed pins, owner mappings, private boundaries and immutable read results', async () => {
  const f=await fixture(['list_skills','read_skill','read_skill_file']);
  try{
    initializeSkills(f.db);
    const configProject=randomUUID();f.access.createProject(f.owner,{requestId:randomUUID(),id:configProject,name:'Configuration'});
    const map=(table:string,key:(string|number)[],account=f.owner.accountId)=>f.db.prepare("INSERT INTO record_scopes VALUES (?,?,?,?,'owner','agent',?)").run(table,JSON.stringify(key),account,configProject,f.agent);
    const seed=(mapped=true,account=f.owner.accountId)=>{
      const skill=randomUUID();saveSkill(f.db,skill,{revision:0,name:'Pinned',description:'Global configuration',content:'PINNED_INSTRUCTIONS'});
      f.db.prepare('INSERT INTO agent_skills(agent,skill,version,enabled,revision,removed) VALUES (?,?,1,1,1,0)').run(f.agent,skill);
      if(mapped)for(const [table,key] of [['skills',[skill]],['skill_versions',[skill,1]],['agent_skills',[f.agent,skill]]] as const)map(table,[...key],account);
      return skill;
    };
    const installed=Array.from({length:11},()=>seed()).sort(),skill=installed[0],unmapped=seed(false),foreign=seed(true,f.foreign.accountId),disabled=seed(),removed=seed(),uninstalled=seed();
    f.db.prepare('UPDATE agent_skills SET enabled=0 WHERE skill=?').run(disabled);f.db.prepare('UPDATE agent_skills SET removed=1 WHERE skill=?').run(removed);f.db.prepare('DELETE FROM agent_skills WHERE skill=?').run(uninstalled);
    const otherAgent=randomUUID();f.db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES (?,'Other','fixture','Private')").run(otherAgent);f.db.prepare('INSERT INTO agent_skills(agent,skill,version,enabled,revision,removed) VALUES (?,?,1,1,1,0)').run(otherAgent,uninstalled);map('agent_skills',[otherAgent,uninstalled]);
    saveSkill(f.db,skill,{revision:1,name:'Latest',description:'Uninstalled version',content:'LATEST_MUST_NOT_LEAK'});
    const binary=Buffer.from('BINARY_MUST_NOT_LEAK'),text='x'.repeat(8000)+'TEXT_TAIL';
    f.db.prepare('INSERT INTO skill_files VALUES (?,1,?)').run(skill,JSON.stringify([{path:'notes.txt',content:text},{path:'asset.bin',content:binary.toString('base64'),encoding:'base64'}]));map('skill_files',[skill,1]);
    const start=(kind:'direct'|'side'|'channel'='direct',account=f.owner)=>{
      const root=randomUUID();
      if(kind==='side'){f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(root,f.agent);map('threads',[root],account.accountId);f.db.prepare("UPDATE record_scopes SET project=?,root_kind='thread',root_id=? WHERE table_name='threads' AND key_json=?").run(f.project,root,JSON.stringify([root]));}
      if(kind==='channel'){f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(root,f.agent);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(root,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([root]),f.owner.accountId,f.project,root);}
      const command=f.command({payload:{v:1,kind,...(kind==='side'?{threadId:root}:kind==='channel'?{channelId:root,routing:'assigned'}:{}),message:{text:'Read installed configuration',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='side'?{thread:1}:kind==='channel'?{channel:1}:{})}});
      f.tasks.admit(account,command);const token=randomBytes(32).toString('base64url');
      const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:command.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
      return {taskId:command.requestId,ownership:parseOwnership(acquired.data.ownership),token,sequence:0};
    };
    const prepare=(task:ReturnType<typeof start>,name:string,args:unknown)=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.taskId)!.revision),context=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision},task.token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),sequence=task.sequence++;
      const intentDigest=digestCommand([task.taskId,actionId,sequence,task.ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.taskId,actionId,{requestId:randomUUID(),sequence,ownership:task.ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},task.token);
      f.tasks.commit(f.principal,task.taskId,actionId,{requestId:randomUUID(),ownership:task.ownership,intentDigest,expectedTaskRevision:expectedTaskRevision,journalSequence:sequence+1},task.token);
      return {requestId:randomUUID(),actionId,ownership:task.ownership,toolCall,payloadDigest,expectedRevision};
    };
    const main=start(),run=(name:string,args:unknown,task=main)=>f.tasks.contextMutations(f.principal,task.taskId,prepare(task,name,args),task.token).data.resultContent as Record<string,unknown>;
    const page=run('list_skills',{});assert.deepEqual((page.items as {id:string}[]).map(row=>row.id),installed.slice(0,10));assert.equal(page.next_after,installed[9]);assert.deepEqual((run('list_skills',{after:page.next_after}).items as {id:string}[]).map(row=>row.id),installed.slice(10));
    const read=run('read_skill',{id:skill});assert.equal(read.version,1);assert.equal(read.content,'PINNED_INSTRUCTIONS');assert.deepEqual(read.files,[{path:'notes.txt',characters:8009},{path:'asset.bin',binary:true}]);assert(!JSON.stringify(read).includes(binary.toString('base64')));
    const first=run('read_skill_file',{id:skill,path:'notes.txt'});assert.equal(first.content,'x'.repeat(8000));assert.equal(first.next_offset,8000);assert.equal(run('read_skill_file',{id:skill,path:'notes.txt',offset:8000}).content,'TEXT_TAIL');assert.equal(run('read_skill_file',{id:skill,path:'asset.bin'}).binary,true);
    for(const id of [unmapped,foreign,disabled,removed,uninstalled])assert.match(String(run('read_skill',{id}).error),/not found/);
    for(const [table,key] of [['skills',[installed[3]]],['skill_versions',[installed[3],1]],['agent_skills',[f.agent,installed[3]]]] as const){
      f.db.prepare('UPDATE record_scopes SET account=? WHERE table_name=? AND key_json=?').run(f.foreign.accountId,table,JSON.stringify(key));assert.match(String(run('read_skill',{id:installed[3]}).error),/not found/);f.db.prepare('DELETE FROM record_scopes WHERE table_name=? AND key_json=?').run(table,JSON.stringify(key));assert.match(String(run('read_skill',{id:installed[3]}).error),/not found/);map(table,[...key]);
    }
    for(const [name,args] of [['list_skills',{after:'invalid'}],['read_skill',{id:'invalid'}],['read_skill_file',{id:skill,path:'notes.txt',offset:-1}]] as const)assert.equal(run(name,args).status,400);
    assert.match(String(run('read_skill_file',{id:skill,path:'../notes.txt'}).error),/not found/);
    f.db.prepare("DELETE FROM record_scopes WHERE table_name='skill_files' AND key_json=?").run(JSON.stringify([skill,1]));assert.deepEqual(run('read_skill',{id:skill}).files,[]);assert.match(String(run('read_skill_file',{id:skill,path:'notes.txt'}).error),/not found/);map('skill_files',[skill,1]);
    const saved=prepare(main,'read_skill',{id:skill}),result=f.tasks.contextMutations(f.principal,main.taskId,saved,main.token);
    f.db.prepare('UPDATE agent_skills SET enabled=0,revision=revision+1 WHERE skill=?').run(skill);assert.deepEqual(f.tasks.contextMutations(f.principal,main.taskId,saved,main.token),result);assert.match(String(run('read_skill',{id:skill}).error),/not found/);
    const stale=prepare(main,'read_skill',{id:installed[1]});f.db.prepare('UPDATE agent_skills SET enabled=0,revision=revision+1 WHERE skill=?').run(installed[1]);assert.throws(()=>f.tasks.contextMutations(f.principal,main.taskId,stale,main.token),code('context_stale'));
    const side=start('side');assert.equal(run('read_skill',{id:installed[2]},side).content,'PINNED_INSTRUCTIONS');
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    const member=start('direct',f.member);assert.equal(run('read_skill',{id:installed[2]},member).content,'PINNED_INSTRUCTIONS');
    const room=start('channel'),context=f.tasks.context(f.principal,room.taskId,{requestId:randomUUID(),ownership:room.ownership,expectedTaskRevision:2},room.token);
    assert.deepEqual((context.data.snapshot as {tools:unknown[]}).tools,[]);assert.throws(()=>run('list_skills',{},room),code('execution_denied'));
  }finally{await f.close();}
});

test('canonical routine tools keep private project mappings, pagination and flow scope', async () => {
  const f=await fixture(['list_routines','read_routine','set_routine_flow']);
  try{
    const task=f.command();f.tasks.admit(f.owner,task);const token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:task.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);let sequence=0;
    const run=(name:string,args:unknown)=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision),context=f.tasks.context(f.principal,task.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision},token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision});
      const intentDigest=digestCommand([task.requestId,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.requestId,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},token);
      f.tasks.commit(f.principal,task.requestId,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},token);sequence++;
      return f.tasks.contextMutations(f.principal,task.requestId,{requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision},token).data.resultContent as Record<string,unknown>;
    };
    assert.deepEqual(run('list_routines',{}),{routines:[],next_after:null});
    f.db.exec('CREATE TABLE IF NOT EXISTS routines(id TEXT PRIMARY KEY,agent TEXT,name TEXT,prompt TEXT,next_at INTEGER,interval_ms INTEGER,enabled INTEGER,revision INTEGER,trigger TEXT,secret TEXT); CREATE TABLE IF NOT EXISTS routine_flows(routine TEXT PRIMARY KEY,graph TEXT,revision INTEGER);');
    f.db.exec('ALTER TABLE routines ADD COLUMN secret TEXT');
    const other=randomUUID();f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    const seed=(project=f.project,account=f.owner.accountId,mapped=true,agent=f.agent)=>{
      const id=randomUUID();f.db.prepare("INSERT INTO routines(id,agent,name,prompt,next_at,interval_ms,enabled,revision,trigger,secret) VALUES (?,?,'Routine','Routine prompt',123456,NULL,1,1,'schedule','SECRET_MUST_NOT_LEAK')").run(id,agent);
      if(mapped)f.db.prepare("INSERT INTO record_scopes VALUES ('routines',?,?,?,'owner','agent',?)").run(JSON.stringify([id]),account,project,agent);return id;
    };
    const visible=Array.from({length:11},()=>seed()).sort(),foreign=seed(other),privateRoutine=seed(f.project,f.member.accountId),unmapped=seed(f.project,f.owner.accountId,false);
    const unassigned=randomUUID();f.db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES (?,'Unassigned','fixture','Help')").run(unassigned);
    const foreignAgent=seed(f.project,f.owner.accountId,true,unassigned);
    const page=run('list_routines',{});assert.deepEqual((page.routines as {id:string}[]).map(row=>row.id),visible.slice(0,10));assert.equal(page.next_after,visible[9]);assert(!JSON.stringify(page).includes('Routine prompt'));assert(!JSON.stringify(page).includes('SECRET_MUST_NOT_LEAK'));
    const next=run('list_routines',{after:page.next_after});assert.deepEqual((next.routines as {id:string}[]).map(row=>row.id),visible.slice(10));assert.equal(next.next_after,null);
    const plain=run('read_routine',{id:visible[0]});assert.equal(plain.prompt,'Routine prompt');assert.deepEqual(plain.flow,{graph:{root:f.agent,nodes:[f.agent],links:[]},revision:0});assert(!JSON.stringify(plain).includes('SECRET_MUST_NOT_LEAK'));
    const graph={root:f.agent,nodes:[f.agent],links:[]};f.db.prepare('INSERT INTO routine_flows VALUES (?,?,2)').run(visible[0],JSON.stringify(graph));assert.match(String(run('read_routine',{id:visible[0]}).error),/not found/);
    f.db.prepare("INSERT INTO record_scopes VALUES ('routine_flows',?,?,?,'owner','agent',?)").run(JSON.stringify([visible[0]]),f.owner.accountId,other,f.agent);assert.match(String(run('read_routine',{id:visible[0]}).error),/not found/);
    f.db.prepare("UPDATE record_scopes SET project=? WHERE table_name='routine_flows'").run(f.project);assert.deepEqual(run('read_routine',{id:visible[0]}).flow,{graph,revision:2});
    f.db.prepare("UPDATE record_scopes SET account=? WHERE table_name='routine_flows'").run(f.member.accountId);assert.match(String(run('read_routine',{id:visible[0]}).error),/not found/);
    for(const id of [foreign,privateRoutine,unmapped,foreignAgent])assert.match(String(run('read_routine',{id}).error),/not found/);
    for(const [name,args] of [['list_routines',{after:'bad'}],['read_routine',{id:'bad'}]] as const)assert.equal(run(name,args).status,400);
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const room=f.command({payload:{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Forced read',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,channel:1}});f.tasks.admit(f.owner,room);
    const owned=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:room.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),roomOwnership=parseOwnership(owned.data.ownership),context=f.tasks.context(f.principal,room.requestId,{requestId:randomUUID(),ownership:roomOwnership,expectedTaskRevision:2},token);
    assert.deepEqual((context.data.snapshot as {tools:unknown[]}).tools,[]);
    for(const name of ['list_routines','set_routine_flow']){
      const toolCall={id:randomUUID(),function:{name,arguments:'{}'}},expectedRevision=2;assert.throws(()=>f.tasks.contextMutations(f.principal,room.requestId,{requestId:randomUUID(),actionId:randomUUID(),ownership:roomOwnership,toolCall,expectedRevision,payloadDigest:canonicalToolDigest({toolCall,expectedRevision})},token),code('execution_denied'));
    }
  }finally{await f.close();}
});

test('canonical routine edits require project agents and assignment, preserve CAS and roll back with result failure', async () => {
  const f=await fixture(['set_routine_flow']),recipient=randomUUID(),outsider=randomUUID(),other=randomUUID(),routine=randomUUID(),privateRoutine=randomUUID(),foreignRoutine=randomUUID();
  try{
    f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    for(const [id,projectId] of [[recipient,f.project],[outsider,other]])await f.access.createAgent(f.owner,{requestId:id,id,name:'Recipient',model:'fixture',backupModel:'',instructions:'Continue',threadLimit:2,projectId,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,f.agent);
    f.db.exec('CREATE TABLE IF NOT EXISTS routines(id TEXT PRIMARY KEY,agent TEXT,name TEXT,prompt TEXT,next_at INTEGER,interval_ms INTEGER,enabled INTEGER,revision INTEGER,trigger TEXT); CREATE TABLE IF NOT EXISTS routine_flows(routine TEXT PRIMARY KEY,graph TEXT,revision INTEGER); CREATE TABLE IF NOT EXISTS flow_runs(root_turn TEXT PRIMARY KEY,graph TEXT);');
    for(const [id,project,visibility] of [[routine,f.project,'project'],[privateRoutine,f.project,'owner'],[foreignRoutine,other,'project']]){
      f.db.prepare("INSERT INTO routines(id,agent,name,prompt,next_at,interval_ms,enabled,revision,trigger) VALUES (?,?,'Routine','Prompt',123456,NULL,1,1,'schedule')").run(id,f.agent);
      f.db.prepare("INSERT INTO record_scopes VALUES ('routines',?,?,?,?, 'agent',?)").run(JSON.stringify([id]),f.owner.accountId,project,visibility,f.agent);
    }
    const task=f.command();f.tasks.admit(f.member,task);const token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:task.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);let sequence=0,pending:unknown;
    const run=(args:unknown)=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision),context=f.tasks.context(f.principal,task.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision},token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name:'set_routine_flow',arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision});
      const intentDigest=digestCommand([task.requestId,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.requestId,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},token);
      f.tasks.commit(f.principal,task.requestId,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},token);sequence++;
      pending={requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision};return f.tasks.contextMutations(f.principal,task.requestId,pending,token).data.resultContent as Record<string,unknown>;
    };
    for(const id of [privateRoutine,foreignRoutine,randomUUID()])assert.match(String(run({id,revision:0,links:[]}).error),/not found/);
    for(const revision of [-1,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,null])assert.equal(run({id:routine,revision,links:[]}).status,400);
    for(const links of [[{from:f.agent,to:f.agent}],[{from:f.agent,to:recipient},{from:recipient,to:f.agent}],[{from:f.agent,to:recipient},{from:f.agent,to:recipient}],null])assert.equal(run({id:routine,revision:0,links}).status,400);
    for(const to of [outsider,recipient,randomUUID()])assert.equal(run({id:routine,revision:0,links:[{from:f.agent,to}]}).status,404);
    assert.equal(f.db.prepare('SELECT count(*) n FROM routine_flows').get()!.n,0);
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,recipient);
    f.db.exec("CREATE TRIGGER fail_flow_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'fixture_result_fail'); END;");
    assert.throws(()=>run({id:routine,revision:0,links:[{from:f.agent,to:recipient}]}),code('storage_failed'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM routine_flows').get()!.n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM record_scopes WHERE table_name='routine_flows'").get()!.n,0);
    f.db.exec('DROP TRIGGER fail_flow_result');
    const saved=f.tasks.contextMutations(f.principal,task.requestId,pending,token),graph=(saved.data.resultContent as {graph:unknown}).graph;
    assert.deepEqual(saved.data.resultContent,{graph:{root:f.agent,nodes:[f.agent,recipient],links:[{from:f.agent,to:recipient}]},revision:1});
    const mapping=f.db.prepare("SELECT account,project,visibility FROM record_scopes WHERE table_name='routine_flows'").get()!;assert.deepEqual({...mapping},{account:f.owner.accountId,project:f.project,visibility:'project'});
    f.db.prepare('INSERT INTO flow_runs(root_turn,graph) VALUES (?,?)').run(task.requestId,JSON.stringify(graph));
    assert.equal(run({id:routine,revision:0,links:[]}).status,409);assert.deepEqual(run({id:routine,revision:1,links:[]}),{graph:{root:f.agent,nodes:[f.agent],links:[]},revision:2});assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT graph FROM flow_runs').get()!.graph)),graph);
    assert.deepEqual(f.tasks.contextMutations(f.principal,task.requestId,pending,token).data.resultContent,{graph:{root:f.agent,nodes:[f.agent],links:[]},revision:2});
    f.db.prepare('UPDATE tasks SET state=\'cancelled\',revision=revision+1 WHERE id=?').run(task.requestId);assert.deepEqual(f.tasks.contextMutations(f.principal,task.requestId,pending,token).data.resultContent,{graph:{root:f.agent,nodes:[f.agent],links:[]},revision:2});
    assert.equal(f.db.prepare('SELECT revision FROM routine_flows WHERE routine=?').get(routine)!.revision,2);
  }finally{await f.close();}
});

for(const kind of ['direct','side'] as const) test(`canonical provider settings read binding metadata only in ${kind} and stays private`, async () => {
  const f=await fixture(['read_provider_settings']);
  try{
    const actor=kind==='side'?f.member:f.owner,thread=randomUUID();
    if(kind==='side'){
      f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,actor.accountId,f.agent);
      f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(thread,f.agent);
      f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),actor.accountId,f.project,thread);
    }
    const task=f.command({payload:{v:1,kind,...(kind==='side'?{threadId:thread}:{}),message:{text:'Read settings',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='side'?{thread:1}:{})}});f.tasks.admit(actor,task);const token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:task.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);let sequence=0;
    const run=(name:string,args:unknown)=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision),context=f.tasks.context(f.principal,task.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision},token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision});
      const intentDigest=digestCommand([task.requestId,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.requestId,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},token);
      f.tasks.commit(f.principal,task.requestId,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},token);
      sequence++;
      return f.tasks.contextMutations(f.principal,task.requestId,{requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision},token).data.resultContent as Record<string,unknown>;
    };
    assert.deepEqual(run('read_provider_settings',{}),{revision:1,providerAccount:'',model:'fixture',backupModel:'',configured:false});
    f.db.prepare("UPDATE agents SET provider_account='LEGACY_MUST_NOT_LEAK',backup_model='backup' WHERE id=?").run(f.agent);
    const binding=randomUUID();f.db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','Owner account','PRIVATE_LABEL','ready',1)").run(binding,f.home,f.owner.accountId);f.db.prepare('UPDATE agent_authority SET provider_binding=? WHERE agent=?').run(binding,f.agent);
    const otherHome=randomUUID();f.db.prepare('INSERT INTO devices SELECT ?,installation,account,signing_public_key,encryption_public_key,signing_thumbprint,encryption_thumbprint,descriptor_json,generation,connection_generation,status,zone,zone_revision,last_seen,capabilities_json,revision FROM devices WHERE id=?').run(otherHome,f.home);
    f.db.prepare('UPDATE provider_bindings SET device=? WHERE id=?').run(otherHome,binding);assert.deepEqual(run('read_provider_settings',{}),{error:'Provider binding is unavailable.',status:409});f.db.prepare('UPDATE provider_bindings SET device=? WHERE id=?').run(f.home,binding);
    const expected={revision:1,providerAccount:'Owner account',model:'fixture',backupModel:'backup',configured:true};assert.deepEqual(run('read_provider_settings',{}),expected);
    for(const readiness of ['missing','unreadable','unavailable','revoked']){f.db.prepare('UPDATE provider_bindings SET readiness=?,revision=revision+1 WHERE id=?').run(readiness,binding);assert.deepEqual(run('read_provider_settings',{}),{...expected,configured:false});}
    f.db.prepare('UPDATE provider_bindings SET owner_account=? WHERE id=?').run(f.foreign.accountId,binding);assert.deepEqual(run('read_provider_settings',{}),{error:'Provider binding is unavailable.',status:409});
    f.db.prepare('UPDATE provider_bindings SET owner_account=? WHERE id=?').run(f.owner.accountId,binding);
    const badCall={id:randomUUID(),function:{name:'read_provider_settings',arguments:JSON.stringify({agentId:randomUUID()})}},badExpected=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision);
    assert.throws(()=>f.tasks.contextMutations(f.principal,task.requestId,{requestId:randomUUID(),actionId:randomUUID(),ownership,toolCall:badCall,expectedRevision:badExpected,payloadDigest:canonicalToolDigest({toolCall:badCall,expectedRevision:badExpected})},token),code('unknown_field'));
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const room=f.command({payload:{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Forced read',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,channel:1}});f.tasks.admit(f.owner,room);
    const roomOwned=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:room.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),roomOwnership=parseOwnership(roomOwned.data.ownership),roomContext=f.tasks.context(f.principal,room.requestId,{requestId:randomUUID(),ownership:roomOwnership,expectedTaskRevision:2},token),roomCall={id:randomUUID(),function:{name:'read_provider_settings',arguments:'{}'}},roomExpected=2;
    assert.deepEqual((roomContext.data.snapshot as {tools:unknown[]}).tools,[]);assert.throws(()=>f.tasks.contextMutations(f.principal,room.requestId,{requestId:randomUUID(),actionId:randomUUID(),ownership:roomOwnership,toolCall:roomCall,expectedRevision:roomExpected,payloadDigest:canonicalToolDigest({toolCall:roomCall,expectedRevision:roomExpected})},token),code('execution_denied'));
  }finally{await f.close();}
});

test('canonical setup restricts host actions and forced tools, and requires a complete profile edit',async()=>{
  const f=await fixture(['edit_profile','ask_user','read_history']),binding=randomUUID(),agent=randomUUID(),token=randomBytes(32).toString('base64url');
  try{
    f.db.prepare("INSERT INTO provider_bindings VALUES (?,?,?,'openai-compatible','setup','Setup','ready',1)").run(binding,f.home,f.owner.accountId);
    await f.access.createAgent(f.owner,{requestId:agent,id:agent,name:'Setup',model:'fixture',backupModel:'',instructions:'Research',threadLimit:2,projectId:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:{bindingId:binding,expectedRevision:1},setup:true});
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:agent,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);
    const context=f.tasks.context(f.principal,agent,{requestId:randomUUID(),ownership,expectedTaskRevision:2},token).data as ActionContext,ref=context.snapshotRef;
    for(const actionKind of ['read','compute','local','browser']){
      const actionId=randomUUID(),payloadDigest=sha256('forbidden'),intentDigest=digestCommand([agent,actionId,0,ownership,payloadDigest,actionKind,ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      assert.throws(()=>f.tasks.prepare(f.principal,agent,actionId,{requestId:randomUUID(),sequence:0,ownership,payloadDigest,actionKind,contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision:2,journalSequence:1,intentDigest},token),code('execution_denied'));
    }
    const forbidden={id:randomUUID(),function:{name:'read_history',arguments:'{}'}};
    assert.throws(()=>f.tasks.contextMutations(f.principal,agent,{requestId:randomUUID(),actionId:randomUUID(),ownership,toolCall:forbidden,expectedRevision:2,payloadDigest:canonicalToolDigest({toolCall:forbidden,expectedRevision:2})},token),code('execution_denied'));
    let sequence=0;
    const edit=(args:unknown)=>{
      const revision=Number(f.tasks.lookup(f.owner,agent).data.revision),context=f.tasks.context(f.principal,agent,{requestId:randomUUID(),ownership,expectedTaskRevision:revision},token).data as ActionContext,ref=context.snapshotRef,actionId=randomUUID(),toolCall={id:actionId,function:{name:'edit_profile',arguments:JSON.stringify(args)}},expectedRevision=revision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),intentDigest=digestCommand([agent,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,agent,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision:revision,journalSequence:sequence+1,intentDigest},token);
      f.tasks.commit(f.principal,agent,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision:revision,journalSequence:sequence+1},token);sequence++;
      return f.tasks.contextMutations(f.principal,agent,{requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision},token).data.resultContent as Record<string,unknown>;
    };
    assert.equal(edit({revision:1,name:'Incomplete'}).status,400);assert.equal(edit({revision:1,instructions:'Incomplete'}).status,400);
    assert.deepEqual(edit({revision:1,name:'Research partner',instructions:'Cite evidence'}),{name:'Research partner',role:'',instructions:'Cite evidence',revision:2});
  }finally{await f.close();}
});

for(const kind of ['direct','side'] as const) test(`canonical profile edit in ${kind} keeps atomic CAS errors and channel privacy`, async () => {
  const f=await fixture(['edit_profile']);
  try{
    const actor=kind==='side'?f.member:f.owner,thread=randomUUID();
    if(kind==='side'){
      f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,actor.accountId,f.agent);
      f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(thread,f.agent);
      f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),actor.accountId,f.project,thread);
    }
    const task=f.command({payload:{v:1,kind,...(kind==='side'?{threadId:thread}:{}),message:{text:'Edit profile',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='side'?{thread:1}:{})}});f.tasks.admit(actor,task);const token=randomBytes(32).toString('base64url');
    const acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:task.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),ownership=parseOwnership(acquired.data.ownership);let sequence=0,pending:unknown;
    const run=(args:unknown)=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision),context=f.tasks.context(f.principal,task.requestId,{requestId:randomUUID(),ownership,expectedTaskRevision},token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name:'edit_profile',arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),intentDigest=digestCommand([task.requestId,actionId,sequence,ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.requestId,actionId,{requestId:randomUUID(),sequence,ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},token);f.tasks.commit(f.principal,task.requestId,actionId,{requestId:randomUUID(),ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},token);sequence++;
      pending={requestId:randomUUID(),actionId,ownership,toolCall,payloadDigest,expectedRevision};return f.tasks.contextMutations(f.principal,task.requestId,pending,token).data.resultContent as Record<string,unknown>;
    };
    assert.deepEqual(run({revision:1,name:'Renamed',role:' Orchestration agent '}),{name:'Renamed',role:'Orchestration agent',instructions:'Research',revision:2});
    assert.deepEqual(run({revision:1,instructions:'Stale'}),{error:'Profile changed. Ask the user for guidance before changing it again.',status:409});
    for(const args of [{revision:2},{revision:2,name:''},{revision:2,name:null},...[null,42,'x'.repeat(61),'bad\nrole','bad\u0085role','bad\u2028role'].map(role=>({revision:2,role})),{revision:2,name:'x'.repeat(81)},{revision:2,instructions:'\u0000'},{revision:2,instructions:' '},{revision:2,instructions:'x'.repeat(8001)},...[0,-1,1.5,Number.MAX_SAFE_INTEGER].map(revision=>({revision,name:'No'}))])assert.equal(run(args).status,400);
    assert.deepEqual(run({revision:2,role:'',instructions:'  Updated instructions  '}),{name:'Renamed',role:'',instructions:'Updated instructions',revision:3});
    f.db.exec("CREATE TRIGGER fail_profile_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'fixture_result_fail'); END;");assert.throws(()=>run({revision:3,name:'Rolled back'}),code('storage_failed'));assert.equal(f.db.prepare('SELECT revision FROM agents WHERE id=?').get(f.agent)!.revision,3);f.db.exec('DROP TRIGGER fail_profile_result');
    const recovered=f.tasks.contextMutations(f.principal,task.requestId,pending,token);assert.deepEqual(recovered.data.resultContent,{name:'Rolled back',role:'',instructions:'Updated instructions',revision:4});assert.deepEqual(f.tasks.contextMutations(f.principal,task.requestId,pending,token),recovered);
    for(const field of ['agentId','model','providerAccount','permissions','homeDeviceId']){
      const toolCall={id:randomUUID(),function:{name:'edit_profile',arguments:JSON.stringify({revision:4,name:'No',[field]:randomUUID()})}},expectedRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.requestId)!.revision);assert.throws(()=>f.tasks.contextMutations(f.principal,task.requestId,{requestId:randomUUID(),actionId:randomUUID(),ownership,toolCall,expectedRevision,payloadDigest:canonicalToolDigest({toolCall,expectedRevision})},token),code('unknown_field'));
    }
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,f.agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const room=f.command({payload:{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Forced profile edit',files:[]}},expectedRevisions:{project:1,agent:4,homeBinding:1,membership:1,assignment:1,capability:1,channel:1}});f.tasks.admit(f.owner,room);
    const roomOwned=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:room.requestId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token),roomOwnership=parseOwnership(roomOwned.data.ownership),roomContext=f.tasks.context(f.principal,room.requestId,{requestId:randomUUID(),ownership:roomOwnership,expectedTaskRevision:2},token),roomCall={id:randomUUID(),function:{name:'edit_profile',arguments:JSON.stringify({revision:2,name:'No'})}},roomExpected=2;
    assert.deepEqual((roomContext.data.snapshot as {tools:unknown[]}).tools,[]);assert.throws(()=>f.tasks.contextMutations(f.principal,room.requestId,{requestId:randomUUID(),actionId:randomUUID(),ownership:roomOwnership,toolCall:roomCall,expectedRevision:roomExpected,payloadDigest:canonicalToolDigest({toolCall:roomCall,expectedRevision:roomExpected})},token),code('execution_denied'));
    assert.equal(f.db.prepare('SELECT instructions FROM agents WHERE id=?').get(f.agent)!.instructions,'Updated instructions');
  }finally{await f.close();}
});

test('canonical agent directory pages authorized teammates and scopes activity to project, human and channel', async () => {
  const f=await fixture(['list_agents']);
  try {
    const other=randomUUID();f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    const add=async(project=f.project)=>{
      const agent=randomUUID();await f.access.createAgent(f.owner,{requestId:agent,id:agent,name:'Peer',role:'Research agent',model:'fixture',backupModel:'',instructions:'x'.repeat(400),threadLimit:2,projectId:project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});return agent;
    };
    const visible=(await Promise.all(Array.from({length:11},()=>add()))).sort(),hidden=await add(),deleted=await add(),foreign=await add(other),unowned=randomUUID();
    f.db.exec('CREATE TABLE IF NOT EXISTS agent_visibility(agent TEXT PRIMARY KEY,hidden INTEGER,revision INTEGER);');
    f.db.prepare('INSERT INTO agent_visibility VALUES (?,1,1)').run(hidden);
    f.db.prepare('UPDATE agent_projects SET deleted=1 WHERE agent=?').run(deleted);
    f.db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES (?,'Foreign','fixture','PRIVATE_PROFILE')").run(unowned);
    f.db.prepare("INSERT INTO agent_projects VALUES (?,?,'','{\"tools\":[]}',1,0)").run(f.project,unowned);
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(unowned,f.foreign.accountId,f.home);
    for(const agent of [f.agent,visible[0]])f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,agent);
    f.db.prepare('INSERT INTO response_policies VALUES (?,?,?,0,1)').run(f.project,f.member.accountId,visible[0]);
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);
    for(const agent of [f.agent,visible[0],foreign,hidden])f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);
    f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    const admit=(agent=f.agent,actor=f.owner,project=f.project,kind:'direct'|'side'|'channel'='direct')=>{
      const thread=randomUUID();
      if(kind==='side'){
        f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(thread,agent);
        f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),actor.accountId,project,thread);
      }
      const command=f.command({agentId:agent,projectId:project,payload:{v:1,kind,...(kind==='side'?{threadId:thread}:kind==='channel'?{channelId:channel,routing:'assigned'}:{}),message:{text:'Directory',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='side'?{thread:1}:kind==='channel'?{channel:1}:{})}});
      f.tasks.admit(actor,command);return command.requestId;
    };
    const start=(taskId:string)=>{
      const token=randomBytes(32).toString('base64url'),acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
      return {taskId,token,ownership:parseOwnership(acquired.data.ownership),sequence:0};
    };
    type AgentPage={agents:{id:string;role:string;description:string;status:string;queuedMessages:number}[];next_after:string|null;status?:number};
    const run=(task:ReturnType<typeof start>,args:unknown={})=>{
      const expectedTaskRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.taskId)!.revision),context=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision},task.token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name:'list_agents',arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),sequence=task.sequence++;
      const intentDigest=digestCommand([task.taskId,actionId,sequence,task.ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.taskId,actionId,{requestId:randomUUID(),sequence,ownership:task.ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},task.token);
      f.tasks.commit(f.principal,task.taskId,actionId,{requestId:randomUUID(),ownership:task.ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},task.token);
      return f.tasks.contextMutations(f.principal,task.taskId,{requestId:randomUUID(),actionId,ownership:task.ownership,toolCall,payloadDigest,expectedRevision},task.token).data.resultContent as AgentPage;
    };
    const main=start(admit()),first=run(main);
    assert.deepEqual(first.agents.map(row=>row.id),visible.slice(0,10));assert.equal(first.next_after,visible[9]);assert(first.agents.every(row=>row.role==='Research agent'&&row.description.length===300&&row.status==='idle'&&row.queuedMessages===0));
    const second=run(main,{after:first.next_after});assert.deepEqual(second.agents.map(row=>row.id),visible.slice(10));assert.equal(second.next_after,null);
    for(const after of ['',null,42,'bad'])assert.equal(run(main,{after}).status,400);
    const peer=visible[0],side=start(admit(f.agent,f.member,f.project,'side')),room=start(admit(f.agent,f.member,f.project,'channel'));
    assert.deepEqual(run(side).agents.map(row=>row.id),[peer]);assert.deepEqual(run(room).agents.map(row=>row.id),[peer]);
    const privateTask=start(admit(peer));assert.equal(run(side).agents[0].status,'idle');assert.equal(run(room).agents[0].status,'idle');
    assert.equal(run(main).agents[0].status,'working');
    f.db.prepare("INSERT INTO agent_projects SELECT ?,agent,rules,capabilities_json,1,0 FROM agent_projects WHERE project=? AND agent=?").run(other,f.project,peer);
    start(admit(peer,f.owner,other));
    f.tasks.control(f.owner,privateTask.taskId,{requestId:randomUUID(),expectedRevision:2,operation:'cancel'});
    assert.equal(run(main).agents[0].status,'idle');
    admit(peer,f.member);assert.equal(run(side).agents[0].status,'waiting');assert.equal(run(side).agents[0].queuedMessages,1);assert.equal(run(room).agents[0].status,'idle');
    const shared=start(admit(peer,f.member,f.project,'channel'));assert.equal(run(room).agents[0].status,'working');assert.equal(run(room).agents[0].queuedMessages,0);
    f.tasks.control(f.member,shared.taskId,{requestId:randomUUID(),expectedRevision:2,operation:'pause'});assert.equal(run(room).agents[0].status,'waiting');
    f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE project=? AND account=? AND agent=?').run(f.project,f.member.accountId,peer);
    assert.deepEqual(run(side).agents,[]);assert.deepEqual(run(room).agents,[]);
    const toolCall={id:randomUUID(),function:{name:'list_agents',arguments:JSON.stringify({projectId:other})}},expectedRevision=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(main.taskId)!.revision);
    assert.throws(()=>f.tasks.contextMutations(f.principal,main.taskId,{requestId:randomUUID(),actionId:randomUUID(),ownership:main.ownership,toolCall,expectedRevision,payloadDigest:canonicalToolDigest({toolCall,expectedRevision})},main.token),code('unknown_field'));
    f.tasks.control(f.owner,main.taskId,{requestId:randomUUID(),expectedRevision,operation:'pause'});
    const paused=Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(main.taskId)!.revision),moved=f.tasks.control(f.owner,main.taskId,{requestId:randomUUID(),expectedRevision:paused,operation:'reassign',recipientAgentId:peer});
    const successor=start(String(moved.data.taskId));assert(!run(successor).agents.some(row=>row.id===f.agent||row.id===peer));
  } finally { await f.close(); }
});

test('canonical interruption isolates sender, human and project while preserving terminal outcomes and atomic notice rollback',async()=>{
  const f=await fixture(['send_message','interrupt_agent']),beta=randomUUID(),gamma=randomUUID(),delta=randomUUID(),epsilon=randomUUID(),other=randomUUID(),channel=randomUUID();
  try{
    for(const agent of [beta,gamma,delta,epsilon])await f.access.createAgent(f.owner,{requestId:agent,id:agent,name:agent,model:'fixture',backupModel:'',instructions:'Teammate',threadLimit:2,projectId:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});
    for(const agent of [f.agent,beta,gamma,delta,epsilon])f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,agent);
    f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);for(const agent of [f.agent,beta])f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(other,f.member.accountId);
    for(const agent of [f.agent,beta]){f.db.prepare('INSERT INTO agent_projects SELECT ?,agent,rules,capabilities_json,1,0 FROM agent_projects WHERE project=? AND agent=?').run(other,f.project,agent);f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(other,f.member.accountId,agent);}
    const admit=(agent=f.agent,actor=f.member,project=f.project,kind='direct')=>{
      const thread=randomUUID();if(kind==='side'){f.db.prepare("INSERT INTO threads(id,agent,name) VALUES (?,?,'Side')").run(thread,agent);f.db.prepare("INSERT INTO record_scopes VALUES ('threads',?,?,?,'owner','thread',?)").run(JSON.stringify([thread]),actor.accountId,project,thread);}
      const command=f.command({agentId:agent,projectId:project,payload:{v:1,kind,...(kind==='channel'?{channelId:channel,routing:'assigned'}:kind==='side'?{threadId:thread}:{}),message:{text:'Task',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,...(kind==='channel'?{channel:1}:kind==='side'?{thread:1}:{})}});f.tasks.admit(actor,command);return command.requestId;
    };
    const start=(taskId:string)=>{const token=randomBytes(32).toString('base64url'),acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);return {taskId,token,ownership:parseOwnership(acquired.data.ownership),sequence:0};};
    const snapshot=(task:ReturnType<typeof start>)=>f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision:Number(f.db.prepare('SELECT revision FROM tasks WHERE id=?').get(task.taskId)!.revision)},task.token);
    const stage=(task:ReturnType<typeof start>,name:string,args:unknown)=>{
      const context=snapshot(task),ref=context.data.snapshotRef as {snapshotId:string;digest:string},expectedTaskRevision=Number((context.data.snapshot as {taskRevision:number}).taskRevision),actionId=randomUUID(),toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),sequence=task.sequence,intentDigest=digestCommand([task.taskId,actionId,sequence,task.ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.taskId,actionId,{requestId:randomUUID(),sequence,ownership:task.ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},task.token);task.sequence++;f.tasks.commit(f.principal,task.taskId,actionId,{requestId:randomUUID(),ownership:task.ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},task.token);
      const request={requestId:randomUUID(),actionId,ownership:task.ownership,toolCall,payloadDigest,expectedRevision};return ()=>f.tasks.contextMutations(f.principal,task.taskId,request,task.token);
    };
    const run=(task:ReturnType<typeof start>,name:string,args:unknown)=>stage(task,name,args)().data.resultContent as any;
    const send=(task:ReturnType<typeof start>,recipients=[beta],expects_reply=true)=>run(task,'send_message',{recipients,text:'Explicit work',expects_reply});
    const children=(request:string)=>f.db.prepare('SELECT turn FROM agent_deliveries WHERE request=? ORDER BY turn').all(request).map(row=>String(row.turn));
    const main=start(admit()),ownId=children(send(main).request)[0],own=start(ownId);assert.equal(run(own,'interrupt_agent',{recipient:f.agent,reason:'Cannot interrupt requester'}).status,409);
    const nested=children(send(own,[gamma,delta,epsilon],false).request),byAgent=(agent:string)=>nested.find(turn=>f.db.prepare('SELECT agent FROM tasks WHERE id=?').get(turn)!.agent===agent)!,finished=byAgent(gamma),failed=byAgent(epsilon),unfinished=byAgent(delta);
    f.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(finished);f.db.prepare("UPDATE turns SET status='done',reply='Preserved outcome' WHERE id=?").run(finished);
    f.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run(failed);f.db.prepare("UPDATE turns SET status='failed',error='Preserved failure' WHERE id=?").run(failed);
    f.tasks.control(f.member,ownId,{requestId:randomUUID(),expectedRevision:Number(f.tasks.lookup(f.member,ownId).data.revision),operation:'pause'});
    const senderOther=children(send(start(admit(delta)),[beta],false).request)[0],humanOther=children(send(start(admit(f.agent,f.owner)),[beta],false).request)[0],projectOther=children(send(start(admit(f.agent,f.member,other)),[beta],false).request)[0],userWork=admit(beta);
    const room=start(admit(f.agent,f.member,f.project,'channel')),channelChild=children(send(room).request)[0],roomChild=start(channelChild),childTools=(snapshot(roomChild).data.snapshot as any).tools;assert(!childTools.some((tool:any)=>tool.function.name==='interrupt_agent'));assert.throws(()=>stage(roomChild,'interrupt_agent',{recipient:gamma,reason:'Private only'})(),code('execution_denied'));
    const roomCaller=start(admit(f.agent,f.member,f.project,'channel'));assert.throws(()=>stage(roomCaller,'interrupt_agent',{recipient:beta,reason:'Private only'})(),code('execution_denied'));
    const noReply=start(senderOther);assert.throws(()=>stage(noReply,'interrupt_agent',{recipient:gamma,reason:'No notification loops'})(),code('execution_denied'));
    const stopper=start(admit(f.agent,f.member,f.project,'side'));
    for(const args of [{recipient:beta,reason:''},{recipient:beta,reason:'x'.repeat(2001)},{recipient:beta,reason:'\u0000'},{recipient:'bad',reason:'Invalid ID'},{recipient:randomUUID(),reason:'Unavailable'},{recipient:f.agent,reason:'Self'}])assert.equal(typeof run(stopper,'interrupt_agent',args).status,'number');
    const scope=f.db.prepare("SELECT * FROM record_scopes WHERE table_name='agent_deliveries' AND key_json=?").get(JSON.stringify([ownId]))!;f.db.prepare("DELETE FROM record_scopes WHERE table_name='agent_deliveries' AND key_json=?").run(scope.key_json);assert.equal(run(stopper,'interrupt_agent',{recipient:beta,reason:'Scope required'}).status,403);f.db.prepare('INSERT INTO record_scopes VALUES (?,?,?,?,?,?,?)').run(...Object.values(scope));
    const interrupt=stage(stopper,'interrupt_agent',{recipient:beta.toUpperCase(),reason:'Changed direction'}),before=Number(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n);
    f.db.exec("CREATE TRIGGER fail_interrupt_notice BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT,'notice failed'); END");assert.throws(interrupt,code('storage_failed'));f.db.exec('DROP TRIGGER fail_interrupt_notice');assert.equal(f.tasks.lookup(f.member,ownId).data.state,'paused');assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n,before);
    f.db.exec("CREATE TRIGGER fail_interrupt_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'result journal failed'); END");assert.throws(interrupt,code('storage_failed'));f.db.exec('DROP TRIGGER fail_interrupt_result');assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n,before);assert.equal(f.tasks.lookup(f.member,ownId).data.state,'paused');assert.notEqual(f.tasks.lookup(f.member,unfinished).data.state,'cancelled');
    const result=interrupt(),content=result.data.resultContent as any;assert.equal(content.status,'interrupted');assert.equal(content.recipient,beta);assert.deepEqual(content.cancelled,[ownId,unfinished].sort());assert.deepEqual(interrupt(),result);
    for(const taskId of [ownId,unfinished])assert.equal(f.tasks.lookup(f.member,taskId).data.state,'cancelled');
    for(const taskId of [senderOther,humanOther,projectOther,userWork,channelChild])assert.notEqual(f.db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId)!.state,'cancelled');
    assert.equal(f.tasks.lookup(f.member,failed).data.state,'failed');assert.equal(f.db.prepare('SELECT error FROM turns WHERE id=?').get(failed)!.error,'Preserved failure');
    assert.equal(f.tasks.lookup(f.member,finished).data.state,'completed');assert.equal(f.db.prepare('SELECT reply FROM turns WHERE id=?').get(finished)!.reply,'Preserved outcome');assert.equal(children(content.request).length,1);assert.equal(f.db.prepare('SELECT expects_reply FROM agent_requests WHERE id=?').get(content.request)!.expects_reply,0);assert.match(String(f.db.prepare('SELECT text FROM turns WHERE id=?').get(children(content.request)[0])!.text),/Changed direction/);snapshot(main);
  }finally{await f.close();}
});

test('canonical messages retain full assignment, isolated children, group waits and atomic cancellation',async()=>{
  const f=await fixture(['send_message','list_agents','read_provider_settings','search_memory']),peers=Array.from({length:11},()=>randomUUID()).sort(),other=randomUUID(),foreign=randomUUID();
  try{
    f.access.createProject(f.owner,{requestId:randomUUID(),id:other,name:'Other'});
    for(const agent of [...peers,foreign])await f.access.createAgent(f.owner,{requestId:agent,id:agent,name:agent,model:'fixture',backupModel:'',instructions:'Recipient',threadLimit:2,projectId:agent===foreign?other:f.project,homeDeviceId:f.home,expectedProjectRevision:1,expectedHomeDeviceRevision:1,providerBinding:null});
    for(const agent of [f.agent,...peers])f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project,f.member.accountId,agent);
    const start=(taskId?:string,actor=f.owner)=>{
      if(!taskId){const command=f.command();f.tasks.admit(actor,command);taskId=command.requestId;}
      const token=randomBytes(32).toString('base64url'),acquired=f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId,previousExecutorGeneration:0,executorTokenHash:sha256(token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},token);
      return {taskId,token,ownership:parseOwnership(acquired.data.ownership),sequence:0};
    };
    const stage=(task:ReturnType<typeof start>,args:unknown,name='send_message')=>{
      const expectedTaskRevision=Number(f.tasks.lookup(f.member,task.taskId).data.revision),context=f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision},task.token),ref=context.data.snapshotRef as {snapshotId:string;digest:string},actionId=randomUUID(),toolCall={id:actionId,function:{name,arguments:JSON.stringify(args)}},expectedRevision=expectedTaskRevision+1,payloadDigest=canonicalToolDigest({toolCall,expectedRevision}),sequence=task.sequence,intentDigest=digestCommand([task.taskId,actionId,sequence,task.ownership,payloadDigest,'canonical',ref.snapshotId,ref.digest,null,null,1,null,null,null]);
      f.tasks.prepare(f.principal,task.taskId,actionId,{requestId:randomUUID(),sequence,ownership:task.ownership,payloadDigest,actionKind:'canonical',contextSnapshotId:ref.snapshotId,contextDigest:ref.digest,grantRevision:1,expectedTaskRevision,journalSequence:sequence+1,intentDigest},task.token);task.sequence++;f.tasks.commit(f.principal,task.taskId,actionId,{requestId:randomUUID(),ownership:task.ownership,intentDigest,expectedTaskRevision,journalSequence:sequence+1},task.token);
      const request={requestId:randomUUID(),actionId,ownership:task.ownership,toolCall,payloadDigest,expectedRevision};return ()=>f.tasks.contextMutations(f.principal,task.taskId,request,task.token);
    };
    const run=(task:ReturnType<typeof start>,args:unknown,name='send_message')=>stage(task,args,name)().data.resultContent as {request:string;status:string|number;error?:string;agents?:{id:string}[]};
    const children=(request:string)=>f.db.prepare('SELECT turn FROM agent_deliveries WHERE request=? ORDER BY turn').all(request).map(row=>String(row.turn));
    const snapshot=(task:ReturnType<typeof start>)=>(f.tasks.context(f.principal,task.taskId,{requestId:randomUUID(),ownership:task.ownership,expectedTaskRevision:Number(f.tasks.lookup(f.member,task.taskId).data.revision)},task.token).data.snapshot as any);
    const main=start(undefined,f.member),sent=run(main,{recipients:[peers[10]],text:'Only explicit text',expects_reply:false});assert.equal(sent.status,'sent');
    const notice=start(children(sent.request)[0]),noticeSnapshot=snapshot(notice);assert.deepEqual(noticeSnapshot.conversation.message,{text:'Only explicit text',files:[]});assert.deepEqual(noticeSnapshot.conversation.history,[]);assert(!noticeSnapshot.tools.some((row:any)=>['list_agents','send_message'].includes(row.function.name)));
    assert.throws(()=>stage(notice,{},'list_agents')(),code('execution_denied'));
    const invalid=run(main,{recipients:[peers[0],foreign],text:'No partial delivery',expects_reply:false});assert.equal(invalid.status,404);assert.equal(f.db.prepare('SELECT count(*) n FROM agent_requests WHERE turn=?').get(main.taskId)!.n,1);
    for(const args of [{recipients:[peers[0],peers[0].toUpperCase()],text:'Duplicate',expects_reply:false},{recipients:[peers[0]],text:'\u0000',expects_reply:false},{recipients:[],text:'Empty',expects_reply:false},{recipients:[peers[0]],text:'Missing flag'}])assert.equal(typeof run(main,args).status,'number');
    const atomic=stage(main,{recipients:[peers[0],peers[1]],text:'Atomic group',expects_reply:true}),before=Number(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n);
    f.db.exec("CREATE TRIGGER fail_message_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT,'result journal failed'); END");assert.throws(atomic,code('storage_failed'));f.db.exec('DROP TRIGGER fail_message_result');assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get()!.n,before);
    const group=atomic().data.resultContent as {request:string};assert.equal(children(group.request).length,2);assert.deepEqual(atomic().data.resultContent,group);
    assert.throws(()=>snapshot(main),code('waiting_agents'));
    const ids=children(group.request),child=start(ids[0]);assert(f.db.prepare('SELECT 1 FROM tasks WHERE id=? AND initiator_account=?').get(child.taskId,f.member.accountId));
    const roster=run(child,{},'list_agents');assert(!roster.agents!.some(row=>row.id===f.agent));
    const oldContext=f.tasks.context(f.principal,child.taskId,{requestId:randomUUID(),ownership:child.ownership,expectedTaskRevision:Number(f.tasks.lookup(f.member,child.taskId).data.revision)},child.token);
    const control=(task:ReturnType<typeof start>,operation:string)=>f.tasks.control(f.member,task.taskId,{requestId:randomUUID(),expectedRevision:Number(f.tasks.lookup(f.member,task.taskId).data.revision),operation});
    control(main,'pause');assert.throws(()=>snapshot(child),code('task_not_runnable'));assert.throws(()=>start(ids[1]),code('task_not_runnable'));
    control(main,'resume');
    const oldRef=oldContext.data.snapshotRef as {snapshotId:string;digest:string},staleAction=randomUUID(),childRevision=Number(f.tasks.lookup(f.member,child.taskId).data.revision),stalePayload=sha256('read'),staleSequence=child.sequence;
    const staleIntent=digestCommand([child.taskId,staleAction,staleSequence,child.ownership,stalePayload,'read',oldRef.snapshotId,oldRef.digest,null,null,1,null,null,null]);
    assert.throws(()=>f.tasks.prepare(f.principal,child.taskId,staleAction,{requestId:randomUUID(),sequence:staleSequence,ownership:child.ownership,payloadDigest:stalePayload,actionKind:'read',contextSnapshotId:oldRef.snapshotId,contextDigest:oldRef.digest,grantRevision:1,expectedTaskRevision:childRevision,journalSequence:staleSequence+1,intentDigest:staleIntent},child.token),code('context_stale'));
    control(child,'pause');control(main,'pause');control(main,'resume');assert.equal(f.tasks.lookup(f.member,child.taskId).data.state,'paused');assert.throws(()=>stage(child,{},'list_agents'),code('task_not_runnable'));control(child,'resume');
    const nested=run(child,{recipients:[peers[2]],text:'Nested explicit task',expects_reply:true}),grandchild=children(nested.request)[0];
    for(const taskId of ids){const revision=Number(f.tasks.lookup(f.member,taskId).data.revision);f.tasks.control(f.member,taskId,{requestId:randomUUID(),expectedRevision:revision,operation:'cancel'});}
    assert.equal(f.tasks.lookup(f.member,grandchild).data.state,'cancelled');assert.throws(()=>f.tasks.acquire(f.principal,{requestId:randomUUID(),taskId:grandchild,previousExecutorGeneration:0,executorTokenHash:sha256(child.token),lockProof:{bootId:randomUUID(),processId:1234,processStart:'999',lockId:randomUUID(),previousOwnerStopped:true,reconciledThrough:0,journalDigest:sha256('journal')}},child.token),code('execution_denied'));
    const settled=snapshot(main).coordination.find((row:any)=>row.request===group.request);assert(settled.replies.every((row:any)=>row.status==='cancelled'&&row.paused===0));assert.equal(f.tasks.lookup(f.member,main.taskId).data.state,'running');
    const channel=randomUUID();f.db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES (?,'Room','',?)").run(channel,f.agent);for(const agent of [f.agent,peers[0]])f.db.prepare('INSERT INTO channel_members VALUES (?,?)').run(channel,agent);f.db.prepare("INSERT INTO record_scopes VALUES ('channels',?,?,?,'project','channel',?)").run(JSON.stringify([channel]),f.owner.accountId,f.project,channel);
    initializeMemory(f.db);const channelScope=`project:${f.project}/channels:${channel}`,privateScope=`project:${f.project}/agents:${peers[0]}/human:${f.member.accountId}`;
    for(const [scope,kind,root,value] of [[channelScope,'channel',channel,'SHARED_ROOM_MEMORY'],[privateScope,'agent',peers[0],'PRIVATE_AGENT_MEMORY']]){const saved=rememberMemory(f.db,scope,{text:value}) as {id:string};f.db.prepare("INSERT INTO record_scopes VALUES ('memories',?,?,?,?,?,?)").run(JSON.stringify([scope,saved.id]),f.member.accountId,f.project,kind==='channel'?'project':'owner',kind,root);}
    f.db.exec('UPDATE memories SET essential=1');
    const roomCommand=f.command({payload:{v:1,kind:'channel',channelId:channel,routing:'assigned',message:{text:'Room request',files:[]}},expectedRevisions:{project:1,agent:1,homeBinding:1,membership:1,assignment:1,capability:1,channel:1}});f.tasks.admit(f.member,roomCommand);const room=start(roomCommand.requestId);
    assert.equal(run(room,{recipients:[peers[0],peers[1]],text:'Members only',expects_reply:false}).status,404);
    const roomSend=run(room,{recipients:[peers[0]],text:'Room child',expects_reply:true}),roomChild=start(children(roomSend.request)[0]),roomSnapshot=snapshot(roomChild);assert(!roomSnapshot.tools.some((row:any)=>row.function.name==='read_provider_settings'));assert(roomSnapshot.memories.some((row:any)=>row.text==='SHARED_ROOM_MEMORY'));assert(!JSON.stringify(roomSnapshot).includes('PRIVATE_AGENT_MEMORY'));
    assert.throws(()=>stage(roomChild,{},'read_provider_settings')(),code('execution_denied'));f.db.prepare('DELETE FROM channel_members WHERE channel=? AND agent=?').run(channel,peers[0]);assert.throws(()=>snapshot(roomChild),code('execution_denied'));
    const bounded=start(undefined,f.member);for(let batch=0;batch<3;batch++)assert.equal(run(bounded,{recipients:peers.slice(0,8),text:'Bounded family',expects_reply:false}).status,'sent');assert.equal(run(bounded,{recipients:peers.slice(0,7),text:'Final family slots',expects_reply:false}).status,'sent');assert.equal(run(bounded,{recipients:[peers[0]],text:'Over family bound',expects_reply:false}).status,409);
    let deep=start(undefined,f.member);for(let level=0;level<7;level++){const next=run(deep,{recipients:[peers[level]],text:'Bounded depth',expects_reply:true});assert.equal(next.status,'waiting');deep=start(children(next.request)[0]);}assert.equal(run(deep,{recipients:[peers[7]],text:'Over depth bound',expects_reply:false}).status,409);
    f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE account=? AND agent=?').run(f.member.accountId,peers[3]);assert.equal(run(main,{recipients:[peers[3]],text:'No grant',expects_reply:false}).status,404);
    const revoked=run(main,{recipients:[peers[4]],text:'Accepted before revoke',expects_reply:true}),revokedChild=children(revoked.request)[0];f.db.prepare('UPDATE collaborator_agents SET enabled=0,revision=revision+1 WHERE account=? AND agent=?').run(f.member.accountId,peers[4]);assert.throws(()=>start(revokedChild),code('execution_denied'));
    const requestScope=f.db.prepare("SELECT * FROM record_scopes WHERE table_name='agent_requests' AND key_json=?").get(JSON.stringify([revoked.request]))!;f.db.prepare("DELETE FROM record_scopes WHERE table_name='agent_requests' AND key_json=?").run(requestScope.key_json);assert.throws(()=>snapshot(main),code('record_scope_missing'));
  }finally{await f.close();}
});

test('context counts projected result bytes once, including escaped JSON content', async () => {
  const f = await preparedTask();
  try {
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    const resultContent = { text: '\\'.repeat(2*1024*1024+100000) }, encoded = canonicalJson(resultContent), resultDigest = sha256(encoded);
    const report = f.tasks.reconcile(f.principal,f.taskId,{requestId:randomUUID(),actionId:f.actionId,ownership:f.ownership,payloadDigest:f.payloadDigest,state:'acknowledged',effectStatus:'known',journalSequence:2,resultContent,resultDigest,resultRef:{v:1,taskId:f.taskId,actionId:f.actionId,digest:resultDigest,size:Buffer.byteLength(encoded),encoding:'canonical-json-v1'}},f.token);
    const context = f.tasks.context(f.principal,f.taskId,{requestId:randomUUID(),ownership:f.ownership,expectedTaskRevision:report.receipt.recordRevision},f.token);
    assert.deepEqual((context.data.snapshot as any).toolJournal[0].result,resultContent);
    assert(Buffer.byteLength(canonicalJson(context.data)) < 8*1024*1024);
  } finally { await f.close(); }
});

function recoveryEnvelope(f: Awaited<ReturnType<typeof preparedTask>>, requestId: string, recoveryGeneration: string, resultContent?: unknown) {
  const action=f.db.prepare('SELECT * FROM task_actions WHERE id=?').get(f.actionId)!;
  const resultDigest=resultContent===undefined?undefined:sha256(canonicalJson(resultContent));
  const entry: JournalEntry={taskId:f.taskId,actionId:f.actionId,sequence:Number(action.sequence),executorGeneration:f.ownership.executorGeneration,actionKind:String(action.action_kind),payloadDigest:f.payloadDigest,intentDigest:String(action.intent_digest),grantRevision:Number(action.grant_revision),state:resultContent===undefined?'uncertain':'reported',effectStatus:resultContent===undefined?'unknown':'known',journalSequence:2,...(resultDigest?{resultDigest,resultRef:{v:1,taskId:f.taskId,actionId:f.actionId,digest:resultDigest,size:Buffer.byteLength(canonicalJson(resultContent)),encoding:'canonical-json-v1'}}:{})};
  const signed={...entry,signature:sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,entry))),f.signing.privateKey).toString('base64url')};
  const envelope={v:1,sourceAuthority:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1,watermark:2,entries:[signed],stopEvidence:[]};
  const signature=sign(null,Buffer.from(JSON.stringify(['briefsip-recovery-envelope-v1',recoveryGeneration,requestId,envelope.sourceAuthority,envelope.sourceDeviceId,envelope.sourceDeviceGeneration,envelope.watermark,envelope.entries.map(e=>[e.taskId,e.actionId,e.sequence,e.executorGeneration,e.actionKind,e.payloadDigest,e.intentDigest,e.bindingId??null,e.bindingRevision??null,e.grantRevision,e.state,e.effectStatus,e.resultDigest??null,e.resultRef??null,e.journalSequence,e.signature]),[]])),f.signing.privateKey).toString('base64url');
  return {requestId,recoveryGeneration,envelope,signature,...(resultContent===undefined?{}:{resultContent})};
}

test('disaster mixed batches reconcile known evidence and privately quarantine only unknown actions atomically',async()=>{
  const f=await preparedTask();
  try{
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    f.db.exec('CREATE TABLE minarbot_backup_authority(generation TEXT,owner_account TEXT)');
    f.db.prepare('INSERT INTO minarbot_backup_authority VALUES (?,?)').run(f.principal.authorityGeneration,f.owner.accountId);
    f.db.prepare("UPDATE authority_state SET generation=?,serving_state='read_only_recovery'").run(randomUUID());
    const auth={requireCurrent:(actor:HumanActor)=>actor},gate=prepareRestoreBootstrap(f.db),proof=issueRestoreSession(f.db,auth,f.owner,gate.bootstrap);
    const request=recoveryEnvelope(f,randomUUID(),proof.recoveryGeneration),unknown=structuredClone(request.envelope.entries[0]);
    unknown.actionId=randomUUID();unknown.sequence=1;unknown.journalSequence=3;
    const resign=()=>{
      for(const entry of request.envelope.entries)entry.signature=sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,entry))),f.signing.privateKey).toString('base64url');
      request.signature=sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(proof.recoveryGeneration,request.requestId,request.envelope))),f.signing.privateKey).toString('base64url');
    };
    request.envelope.entries.push(unknown);request.envelope.entries.sort((a,b)=>a.actionId.localeCompare(b.actionId));request.envelope.watermark=3;
    const known=request.envelope.entries.find(entry=>entry.actionId===f.actionId)!;known.intentDigest=sha256('wrong known intent');resign();
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,request,proof.session),code('recovery_provenance_invalid'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_quarantine').get()!.n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,0);
    known.intentDigest=f.commit.intentDigest;resign();
    const result=f.tasks.recoveryImport(f.owner,f.taskId,request,proof.session);
    assert.deepEqual(result.data.importedActionIds,[f.actionId]);assert.deepEqual(result.data.quarantinedActionIds,[unknown.actionId]);
    assert.equal(result.receipt.projectId,undefined);assert.deepEqual(f.tasks.recoveryImport(f.owner,f.taskId,request,proof.session),result);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_actions').get()!.n,1);
    const saved=f.db.prepare('SELECT * FROM recovery_quarantine').get()!;
    assert.equal(saved.owner_account,f.owner.accountId);assert.deepEqual(JSON.parse(String(saved.envelope_json)),request);
    const previousReceipt=result.receipt.requestId;
    request.requestId=randomUUID();resign();
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,request,proof.session),code('recovery_conflict'));
    assert.equal(f.db.prepare('SELECT receipt_id FROM task_reports').get()!.receipt_id,previousReceipt);
  }finally{await f.close();}
});

test('owner recovery session is scoped, nonsecret on retry, rotates and requires revoked original source', async()=>{
  const f=await preparedTask();
  try {
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    const command={requestId:randomUUID(),expectedAuthorityGeneration:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1};
    assert.throws(()=>f.tasks.recoverySession(f.owner,f.taskId,command),code('recovery_source_current'));
    f.devices.revoke(f.owner,f.home,{requestId:randomUUID(),expectedRevision:1});
    assert.throws(()=>f.tasks.recoverySession(f.member,f.taskId,command),code('owner_required'));
    const first=f.tasks.recoverySession(f.owner,f.taskId,command),session=String(first.data.session);
    assert.match(session,/^[A-Za-z0-9_-]{43}$/);
    const retry=f.tasks.recoverySession(f.owner,f.taskId,command);
    assert.equal(retry.data.session,undefined);assert.equal(retry.data.recoveryGeneration,first.data.recoveryGeneration);
    assert(!JSON.stringify(f.db.prepare('SELECT * FROM receipts').all()).includes(session));
    const next=f.tasks.recoverySession(f.owner,f.taskId,{...command,requestId:randomUUID()});
    assert.notEqual(next.data.recoveryGeneration,first.data.recoveryGeneration);
    assert.equal(f.db.prepare('SELECT revoked FROM recovery_evidence_sessions WHERE id_hash=?').get(sha256(session))!.revoked,1);
    assert.equal(f.db.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'active');
  } finally {await f.close();}
});

test('revoked-source recovery retains signed evidence then publishes exact content without granting execution',async()=>{
  const f=await preparedTask();
  try {
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    f.devices.revoke(f.owner,f.home,{requestId:randomUUID(),expectedRevision:1});
    const command={requestId:randomUUID(),expectedAuthorityGeneration:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1};
    const session=f.tasks.recoverySession(f.owner,f.taskId,command),proof=String(session.data.session),generation=String(session.data.recoveryGeneration),content={text:'Recovered original result'};
    const request=recoveryEnvelope(f,randomUUID(),generation,content),{resultContent,...metadata}=request;
    const imported=f.tasks.recoveryImport(f.owner,f.taskId,metadata,proof);
    assert.equal(imported.data.state,'result_missing');
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_results').get()!.n,0);
    assert.deepEqual(f.tasks.recoveryImport(f.owner,f.taskId,metadata,proof),imported);
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,{...metadata,signature:Buffer.alloc(64).toString('base64url')},proof),code('recovery_signature_invalid'));
    const resultRequest=recoveryEnvelope(f,randomUUID(),generation,content);
    const published=f.tasks.recoveryResults(f.owner,f.taskId,resultRequest,proof);
    assert.deepEqual(f.tasks.recoveryResults(f.owner,f.taskId,resultRequest,proof),published);
    assert.deepEqual((f.tasks.lookup(f.owner,f.taskId).data.results as any[])[0].content,content);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_results').get()!.n,1);
    assert.equal(f.db.prepare('SELECT status FROM devices WHERE id=?').get(f.home)!.status,'revoked');
    assert.equal(f.db.prepare('SELECT executor_generation FROM execution_owners WHERE task=?').get(f.taskId)!.executor_generation,1);
    assert.throws(()=>f.tasks.acquire(f.principal,{requestId:randomUUID()},f.token));
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,{...metadata,requestId:randomUUID()},proof),code('recovery_signature_invalid'));
  }finally{await f.close();}
});


test('recovery rejects replacement keys, expired proof, changed content and non-advancing watermarks atomically',async()=>{
  const f=await preparedTask();
  try{
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);
    f.devices.revoke(f.owner,f.home,{requestId:randomUUID(),expectedRevision:1});
    const session=f.tasks.recoverySession(f.owner,f.taskId,{requestId:randomUUID(),expectedAuthorityGeneration:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1}),proof=String(session.data.session),generation=String(session.data.recoveryGeneration),content={text:'Signed result'};
    const request=recoveryEnvelope(f,randomUUID(),generation,content);
    const other=generateKeyPairSync('ed25519');
    f.db.prepare('UPDATE devices SET signing_public_key=? WHERE id=?').run(other.publicKey.export({format:'der',type:'spki'}).toString('base64url'),f.home);
    const substituted=structuredClone(request);
    substituted.envelope.entries[0].signature=sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,substituted.envelope.entries[0]))),other.privateKey).toString('base64url');
    substituted.signature=sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(generation,substituted.requestId,substituted.envelope))),other.privateKey).toString('base64url');
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,substituted,proof),code('recovery_signature_invalid'));
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,{...request,resultContent:{text:'Altered'}},proof),code('result_digest_mismatch'));
    const unknown=structuredClone(request);unknown.envelope.entries[0].actionId=randomUUID();unknown.envelope.entries[0].resultRef!.actionId=unknown.envelope.entries[0].actionId;
    unknown.envelope.entries[0].signature=sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,unknown.envelope.entries[0]))),f.signing.privateKey).toString('base64url');
    unknown.signature=sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(generation,unknown.requestId,unknown.envelope))),f.signing.privateKey).toString('base64url');
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,unknown,proof),code('recovery_provenance_invalid'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_results').get()!.n,0);
    const result=f.tasks.recoveryResults(f.owner,f.taskId,request,proof);
    const repeat=recoveryEnvelope(f,randomUUID(),generation,content);delete repeat.resultContent;
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,repeat,proof),code('recovery_conflict'));
    const changed=recoveryEnvelope(f,randomUUID(),generation,{text:'Different signed result'});
    changed.envelope.watermark=3;changed.envelope.entries[0].journalSequence=3;
    changed.envelope.entries[0].signature=sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,changed.envelope.entries[0]))),f.signing.privateKey).toString('base64url');
    changed.signature=sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(generation,changed.requestId,changed.envelope))),f.signing.privateKey).toString('base64url');
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,changed,proof),code('recovery_conflict'));
    f.db.prepare('UPDATE recovery_evidence_sessions SET expires_at=0 WHERE id_hash=?').run(sha256(proof));
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,request,proof),code('recovery_session_invalid'));
    f.db.prepare('UPDATE recovery_evidence_sessions SET expires_at=? WHERE id_hash=?').run(Date.now()+60000,sha256(proof));
    f.db.prepare('UPDATE authority_state SET generation=?').run(randomUUID());
    assert.throws(()=>f.tasks.recoveryResults(f.owner,f.taskId,request,proof),code('recovery_session_invalid'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,1);
    assert.equal(f.db.prepare('SELECT receipt_id FROM task_reports').get()!.receipt_id,result.receipt.requestId);
  }finally{await f.close();}
});

test('recovery stop proof preserves original journal signature and rejects altered runner evidence',async()=>{
  const f=await preparedTask();
  try{
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);f.devices.revoke(f.owner,f.home,{requestId:randomUUID(),expectedRevision:1});
    const session=f.tasks.recoverySession(f.owner,f.taskId,{requestId:randomUUID(),expectedAuthorityGeneration:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1}),proof=String(session.data.session),generation=String(session.data.recoveryGeneration);
    const entry:JournalEntry={taskId:f.taskId,actionId:f.actionId,sequence:0,executorGeneration:1,actionKind:'read',payloadDigest:f.payloadDigest,intentDigest:f.commit.intentDigest,grantRevision:1,state:'not_sent',effectStatus:'none',journalSequence:2};
    const signed={...entry,signature:sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,entry))),f.signing.privateKey).toString('base64url')};
    const stop:StopEvidence={v:1,sourceAuthority:f.principal.authorityGeneration,taskId:f.taskId,actionId:f.actionId,sourceDeviceId:f.home,sourceDeviceGeneration:1,executorGeneration:1,bootId:f.lockProof.bootId,processId:f.lockProof.processId,processStart:f.lockProof.processStart,lockId:f.lockProof.lockId,observationBootId:f.lockProof.bootId,observation:'process_exited',children:[],observedAt:Date.now(),journalDigest:sha256(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,entry))),signature:''};
    stop.signature=sign(null,Buffer.from(JSON.stringify(stopEvidenceBody(stop))),f.signing.privateKey).toString('base64url');
    const envelope={v:1,sourceAuthority:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1,watermark:2,entries:[signed],stopEvidence:[stop]},requestId=randomUUID();
    const request={requestId,recoveryGeneration:generation,envelope,signature:sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(generation,requestId,envelope))),f.signing.privateKey).toString('base64url')};
    const altered=structuredClone(request);altered.envelope.stopEvidence[0].processStart='1000';
    assert.throws(()=>f.tasks.recoveryImport(f.owner,f.taskId,altered,proof),code('recovery_signature_invalid'));
    const result=f.tasks.recoveryImport(f.owner,f.taskId,request,proof);
    assert.equal(f.db.prepare('SELECT state FROM task_actions WHERE id=?').get(f.actionId)!.state,'not_sent');
    assert.equal(JSON.parse(String(f.db.prepare('SELECT envelope_json FROM recovery_imports').get()!.envelope_json)).entries[0].signature,signed.signature);
    assert.deepEqual(f.tasks.recoveryImport(f.owner,f.taskId,request,proof),result);
  }finally{await f.close();}
});

test('late content completes a saved recovery batch without lowering newer evidence watermark',async()=>{
  const f=await preparedTask();
  try{
    f.tasks.commit(f.principal,f.taskId,f.actionId,f.commit,f.token);f.devices.revoke(f.owner,f.home,{requestId:randomUUID(),expectedRevision:1});
    const session=f.tasks.recoverySession(f.owner,f.taskId,{requestId:randomUUID(),expectedAuthorityGeneration:f.principal.authorityGeneration,sourceDeviceId:f.home,sourceDeviceGeneration:1}),proof=String(session.data.session),generation=String(session.data.recoveryGeneration),content={text:'Late content'};
    const old=recoveryEnvelope(f,randomUUID(),generation,content),{resultContent,...metadata}=old;
    f.tasks.recoveryImport(f.owner,f.taskId,metadata,proof);
    const newer=recoveryEnvelope(f,randomUUID(),generation,content);delete newer.resultContent;
    newer.envelope.watermark=3;newer.envelope.entries[0].journalSequence=3;
    newer.envelope.entries[0].signature=sign(null,Buffer.from(JSON.stringify(journalEntryBody(f.principal.authorityGeneration,f.home,1,newer.envelope.entries[0]))),f.signing.privateKey).toString('base64url');
    newer.signature=sign(null,Buffer.from(JSON.stringify(recoveryEnvelopeBody(generation,newer.requestId,newer.envelope))),f.signing.privateKey).toString('base64url');
    f.tasks.recoveryImport(f.owner,f.taskId,newer,proof);
    const late=recoveryEnvelope(f,randomUUID(),generation,content),published=f.tasks.recoveryResults(f.owner,f.taskId,late,proof);
    assert.equal(published.receipt.recordId,f.actionId);
    assert.equal(f.db.prepare('SELECT journal_sequence FROM task_reports').get()!.journal_sequence,3);
    assert.equal(JSON.parse(String(f.db.prepare('SELECT payload_json FROM task_reports').get()!.payload_json)).journalSequence,3);
    assert.equal(f.db.prepare('SELECT max(watermark) n FROM recovery_imports').get()!.n,3);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_imports').get()!.n,2);
    assert.deepEqual((f.tasks.lookup(f.owner,f.taskId).data.results as any[])[0].content,content);
  }finally{await f.close();}
});
