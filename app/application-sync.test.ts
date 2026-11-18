import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { HumanActor } from './auth.ts';
import { createApplicationSync } from './application-sync.ts';
import { createProjectAccess } from './project-access.ts';
import { initializeCanonicalSchema } from './schema.ts';
import { digestCommand, ProtocolError } from './shared/protocol.ts';
import { startCanonicalApp } from './test-bridge.ts';
import { createServer } from 'node:http';
import { createMailWorker } from './mail.ts';
import { createProjectWorkflows, initializeWorkflowConfigurations, initializeWorkflowRuns, initializeWorkflowNotifications } from './workflow-store.ts';

function fixture(workflows = false) {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-sync-')), db = new DatabaseSync(join(dir, 'canonical.sqlite'));
  initializeCanonicalSchema(db);
  if (workflows) { initializeWorkflowConfigurations(db); initializeWorkflowRuns(db); initializeWorkflowNotifications(db); }
  const owner: HumanActor = { accountId: randomUUID(), issuer: 'https://fixture.example', subject: 'owner', sessionId: 'session_owner', expiresAt: Date.now() + 60000 };
  const auth = { requireCurrent(actor: HumanActor) { if (actor.expiresAt <= Date.now() || db.prepare('SELECT blocked FROM accounts WHERE id=?').get(actor.accountId)?.blocked !== 0) throw new ProtocolError(401, 'session_invalid', 'Denied'); return actor; }, async verifiedMailboxes() { return []; } };
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(owner.accountId, owner.issuer, owner.subject, Date.now());
  let now = Date.now(); const secret = randomBytes(32);
  const options = { key: () => secret, now: () => now };
  const sync = createApplicationSync(db, auth, options), access = createProjectAccess(db, auth, () => { throw new Error('No mail fixture'); }, [], sync);
  const project = randomUUID(), created = { requestId: randomUUID(), id: project, name: 'First project' };
  access.createProject(owner, created);
  return { dir, db, auth, owner, project, created, access, sync, options, clock: (value: number) => { now = value; }, close: () => { sync.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('sync captures current records and delta changes exactly once with scope-bound cursors', () => {
  const f = fixture();
  try {
    const snapshot = f.sync.read(f.owner, { projectId: f.project });
    assert.equal(snapshot.mode, 'snapshot'); assert(snapshot.nextCursor); assert.equal(snapshot.nextPage, null);
    assert.equal(snapshot.snapshotHash, digestCommand(snapshot.page.events));
    assert(snapshot.page.events.some(event => event.recordKind === 'project' && event.body.name === 'First project'));
    const edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Second name' };
    const accepted = f.access.editProject(f.owner, f.project, edit);
    assert.deepEqual(f.access.editProject(f.owner, f.project, edit).receipt, accepted.receipt);
    const delta = f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor });
    assert.equal(delta.mode, 'delta'); assert.equal(delta.page.events.length, 1);
    assert.equal(delta.page.events[0].body.name, 'Second name');
    assert.deepEqual(f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor }).page.events, delta.page.events);
    assert.deepEqual(f.sync.read(f.owner, { projectId: f.project, cursor: delta.nextCursor! }).page.events, []);
    assert.throws(() => f.access.editProject(f.owner, f.project, { ...edit, name: 'Conflicting body' }), (error: unknown) => error instanceof ProtocolError && error.code === 'payload_conflict');
    assert.throws(() => f.access.editProject(f.owner, f.project, { ...edit, requestId: randomUUID() }), (error: unknown) => error instanceof ProtocolError && error.code === 'stale_revision');
  } finally { f.close(); }
});

function members(f: ReturnType<typeof fixture>, count: number) {
  f.db.exec('BEGIN');
  try {
    for (let n = 0; n < count; n++) {
      const account = randomUUID();
      f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, f.owner.issuer, account, Date.now());
      f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, account);
    }
    f.db.exec('COMMIT');
  } catch (error) { f.db.exec('ROLLBACK'); throw error; }
}

test('large snapshots keep one read position while writes continue and latest-page retries stay exact', () => {
  const f = fixture();
  try {
    members(f, 1200);
    const first = f.sync.read(f.owner, { projectId: f.project });
    assert(first.nextPage); assert.equal(first.nextCursor, null); assert.equal(first.snapshotHash, null);
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'During snapshot' });
    const second = f.sync.read(f.owner, { projectId: f.project, page: first.nextPage });
    assert.deepEqual(f.sync.read(f.owner, { projectId: f.project, page: first.nextPage }), second);
    assert(second.nextPage);
    const final = f.sync.read(f.owner, { projectId: f.project, page: second.nextPage });
    const all = [first, second, final].flatMap(page => page.page.events);
    assert.equal(final.snapshotHash, digestCommand(all)); assert(final.nextCursor); assert.equal(final.nextPage, null);
    assert.equal(all.find(event => event.recordKind === 'project')!.body.name, 'First project');
    for (const page of [first, second, final]) { assert(page.page.events.length <= 500); assert(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 256 * 1024); assert(page.page.events.every(event => event.position === first.highWaterPosition)); }
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: first.nextPage! }), (error: unknown) => error instanceof ProtocolError && error.code === 'sync_page_conflict');
    assert.deepEqual(f.sync.read(f.owner, { projectId: f.project, cursor: final.nextCursor }).page.events.map(event => event.body.name), ['During snapshot']);
  } finally { f.close(); }
});

const errorCode = (code: string) => (error: unknown) => error instanceof ProtocolError && error.code === code;

test('scope denial, permission changes and malformed cursors disclose no historical payload', () => {
  const f = fixture();
  try {
    const first = f.sync.read(f.owner, { projectId: f.project }), other = randomUUID();
    f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Other project' });
    assert.throws(() => f.sync.read(f.owner, { projectId: other, cursor: first.nextCursor! }), errorCode('sync_cursor_scope'));
    for (const cursor of ['', 'broken', first.nextCursor! + 'x']) assert.throws(() => f.sync.read(f.owner, { projectId: f.project, cursor }), errorCode('invalid_sync_cursor'));
    const account = randomUUID(), member = { ...f.owner, accountId: account, subject: 'member' };
    f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, member.issuer, member.subject, Date.now());
    f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, account);
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: first.nextCursor! }), errorCode('sync_cursor_scope'));
    const own = f.sync.read(member, { projectId: f.project });
    assert(own.page.events.every(event => event.recordKind !== 'member' || event.body.accountId === account));
    f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 1, deleted: true });
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: own.nextCursor! }), errorCode('sync_scope_denied'));
    f.db.prepare('UPDATE project_members SET deleted=0,grant_revision=grant_revision+1 WHERE project=? AND account=?').run(f.project, account);
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: own.nextCursor! }), errorCode('resync_required'));
    const delta = f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert(delta.page.events.some(event => event.recordKind === 'member' && event.operation === 'revoke'));
    f.db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(f.owner.accountId);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project }), errorCode('session_invalid'));
  } finally { f.close(); }
});

test('retention honors exact 90-day boundary, retains receipts and tombstones, and rolls back failed floor writes', () => {
  const f = fixture();
  try {
    const started = f.options.now(), first = f.sync.read(f.owner, { projectId: f.project });
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'Retained value' });
    f.clock(started + 90 * 86400_000);
    assert.equal(f.sync.prune().removed, 0);
    assert.equal(f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! }).page.events[0].body.name, 'Retained value');
    f.clock(started + 90 * 86400_000 + 1);
    f.db.exec("CREATE TRIGGER fail_floor BEFORE INSERT ON retention_floors BEGIN SELECT RAISE(ABORT,'floor write failed'); END;");
    assert.throws(() => f.sync.prune(), /floor write failed/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM retention_floors').get()!.n, 0);
    f.db.exec('DROP TRIGGER fail_floor');
    assert.equal(f.sync.prune(1).removed, 1);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! }), errorCode('resync_required'));
    while (f.sync.prune(1).removed) { /* bounded batches */ }
    assert.equal(f.sync.prune().removed, 0);
    const replacement = f.sync.read(f.owner, { projectId: f.project });
    assert.equal(replacement.page.events.find(event => event.recordKind === 'project')!.body.name, 'Retained value');
    assert(replacement.retentionFloor >= first.highWaterPosition);
    assert.equal(f.access.createProject(f.owner, f.created).receipt.recordRevision, 1);
    const before = replacement.highWaterPosition;
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 2, name: 'After cleanup' });
    assert(f.sync.read(f.owner, { projectId: f.project, cursor: replacement.nextCursor! }).page.events[0].position > before);
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 3, deleted: true });
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project }), errorCode('sync_scope_denied'));
    assert.equal(f.db.prepare('SELECT deleted FROM projects WHERE id=?').get(f.project)!.deleted, 1);
  } finally { f.close(); }
});

test('scoped event chains distinguish unrelated numeric gaps from actual segment loss', () => {
  const f = fixture();
  try {
    const first = f.sync.read(f.owner, { projectId: f.project }), other = randomUUID();
    f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Unrelated' });
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'One' });
    const second = f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert.equal(second.page.events.length, 1); assert(second.page.events[0].position > first.highWaterPosition + 1);
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 2, name: 'Missing' });
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 3, name: 'After missing' });
    f.db.prepare('DELETE FROM sync_events WHERE project=? AND revision=3').run(f.project);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, cursor: second.nextCursor! }), errorCode('resync_required'));
  } finally { f.close(); }
});

test('snapshot admission, expiry, revoked continuations and restart release readers without granting stale access', () => {
  const f = fixture();
  try {
    members(f, 600);
    const first = f.sync.read(f.owner, { projectId: f.project }), second = f.sync.read(f.owner, { projectId: f.project });
    assert(first.nextPage && second.nextPage);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project }), errorCode('server_capacity'));
    f.db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(f.owner.accountId);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: first.nextPage! }), errorCode('session_invalid'));
    f.db.prepare('UPDATE accounts SET blocked=0 WHERE id=?').run(f.owner.accountId);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: second.nextPage! }), errorCode('resync_required'));
    const expiring = f.sync.read(f.owner, { projectId: f.project });
    f.clock(f.options.now() + 60_000);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: expiring.nextPage! }), errorCode('resync_required'));
    const restarting = f.sync.read(f.owner, { projectId: f.project });
    f.sync.close();
    const reopened = createApplicationSync(f.db, f.auth, f.options);
    try { assert.throws(() => reopened.read(f.owner, { projectId: f.project, page: restarting.nextPage! }), errorCode('resync_required')); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('cleanup and excessive WAL growth invalidate unfinished snapshots and preserve consistent retry', () => {
  const f = fixture();
  try {
    members(f, 600);
    const snapshot = f.sync.read(f.owner, { projectId: f.project });
    assert(snapshot.nextPage);
    f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'New snapshot required' });
    f.clock(f.options.now() + 90 * 86400_000 + 1); f.sync.prune();
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: snapshot.nextPage! }), errorCode('resync_required'));
    const wal = f.sync.read(f.owner, { projectId: f.project });
    f.db.exec('CREATE TABLE private_test_bytes(bytes BLOB) STRICT; INSERT INTO private_test_bytes VALUES (zeroblob(34603008));');
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, page: wal.nextPage! }), errorCode('resync_required'));
    const replacement = f.sync.read(f.owner, { projectId: f.project });
    const final = f.sync.read(f.owner, { projectId: f.project, page: replacement.nextPage! });
    assert.equal(final.page.events.find(event => event.recordKind === 'project')!.body.name, 'New snapshot required');
    assert(!JSON.stringify(final).includes('private_test_bytes'));
  } finally { f.close(); }
});

test('event persistence failures roll back canonical mutation and receipt before exact retry', () => {
  const f = fixture();
  try {
    const first = f.sync.read(f.owner, { projectId: f.project }), edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Atomic name' };
    f.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON sync_events BEGIN SELECT RAISE(ABORT,'event storage failed'); END;");
    assert.throws(() => f.access.editProject(f.owner, f.project, edit), /event storage failed/);
    assert.equal(f.sync.read(f.owner, { projectId: f.project }).page.events.find(event => event.recordKind === 'project')!.body.name, 'First project');
    assert.equal(f.db.prepare('SELECT 1 FROM receipts WHERE request_id=?').get(edit.requestId), undefined);
    f.db.exec('DROP TRIGGER fail_event');
    f.access.editProject(f.owner, f.project, edit);
    const delta = f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert.equal(delta.page.events.length, 1); assert.equal(delta.page.events[0].body.name, 'Atomic name');
  } finally { f.close(); }
});

test('same agent keeps project-specific rules while response policies and assignment revocations remain reader scoped', () => {
  const f = fixture();
  try {
    const installation = randomUUID(), device = randomUUID(), agent = randomUUID(), account = randomUUID(), other = randomUUID();
    f.db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation, f.owner.accountId, 'fixture-public-key', 'fixture-thumbprint', Date.now());
    f.db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[]',1)").run(device, installation, f.owner.accountId, 'fixture-public-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
    f.db.prepare('INSERT INTO agents(id,name,role,model,instructions) VALUES (?,?,?,?,?)').run(agent, 'Shared profile', 'Personal agent', 'fixture', 'Private profile instructions');
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, f.owner.accountId, device);
    f.db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'owner','agent',?)").run(JSON.stringify([agent]), f.owner.accountId, f.project, agent);
    f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Other context' });
    for (const [project, rules] of [[f.project, 'Project A rules'], [other, 'Project B rules']]) f.access.agentParticipation(f.owner, project, agent, { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 0, rules, capabilities: { v: 1, tools: [], resources: [] } });
    const member = { ...f.owner, accountId: account, subject: 'member' };
    f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, member.issuer, member.subject, Date.now());
    f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, account);
    const beforeAssignment = f.sync.read(member, { projectId: f.project });
    assert(!beforeAssignment.page.events.some(event => event.recordKind === 'agent'));
    f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 1, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 0, enabled: true }] });
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: beforeAssignment.nextCursor! }), errorCode('resync_required'));
    const assigned = f.sync.read(member, { projectId: f.project });
    assert.equal(assigned.page.events.find(event => event.recordKind === 'agent')!.body.rules, 'Project A rules');
    assert.equal(assigned.page.events.find(event => event.recordKind === 'agent')!.body.role, 'Personal agent');
    assert(!JSON.stringify(assigned).includes('Project B rules')); assert(!JSON.stringify(assigned).includes('Private profile instructions'));
    f.access.setResponsePolicy(f.owner, f.project, agent, { requestId: randomUUID(), accountId: account, expectedRevision: 1, respond: false });
    const policy = f.sync.read(member, { projectId: f.project, cursor: assigned.nextCursor! });
    assert.equal(policy.page.events.length, 1); assert.equal(policy.page.events[0].body.respond, false);
    f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 2, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 1, enabled: false }] });
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: policy.nextCursor! }), errorCode('resync_required'));
    assert(!f.sync.read(member, { projectId: f.project }).page.events.some(event => event.recordKind === 'agent'));
    f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 3, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 2, enabled: true }] });
    const ownerBeforeReactivation = f.sync.read(f.owner, { projectId: f.project });
    f.db.prepare('UPDATE agent_projects SET deleted=1,revision=2 WHERE project=? AND agent=?').run(f.project, agent);
    f.access.agentParticipation(f.owner, f.project, agent, { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 2, rules: 'Reactivated rules', capabilities: { v: 1, tools: [], resources: [] } });
    const reactivated = f.sync.read(f.owner, { projectId: f.project, cursor: ownerBeforeReactivation.nextCursor! });
    assert(reactivated.page.events.some(event => event.recordKind === 'assignment' && event.operation === 'revoke'));
    assert(reactivated.page.events.some(event => event.recordKind === 'response_policy' && event.body.respond === false));
  } finally { f.close(); }
});

test('task and home-device observations sync without task payload or device secrets', () => {
  const f = fixture();
  try {
    const installation = randomUUID(), device = randomUUID(), agent = randomUUID(), task = randomUUID();
    f.db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation, f.owner.accountId, 'fixture-public-key', 'fixture-thumbprint', Date.now());
    f.db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[\"execution\"]',1)").run(device, installation, f.owner.accountId, 'fixture-public-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
    f.db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(agent, 'Shared', 'fixture', 'private instructions');
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, f.owner.accountId, device);
    f.db.prepare('INSERT INTO agent_projects VALUES (?,?,?,?,1,0)').run(f.project, agent, 'project rules', '{"v":1,"tools":[],"resources":[]}');
    f.db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES (?,?,?,'queued',?)").run(task, agent, 'private prompt', new Date().toISOString());
    f.db.prepare("INSERT INTO record_scopes VALUES ('turns',?,?,?,'project','channel',?)").run(JSON.stringify([task]), f.owner.accountId, f.project, task);
    const payload = { kind: 'direct', message: { text: 'do not sync this prompt', files: [] } };
    f.db.prepare('INSERT INTO tasks(id,logical_turn,project,agent,initiator_account,home_device,assignment_revision,capability_revision,capability_digest,capability_snapshot_json,state,payload_digest,payload_json,revision,created) VALUES (?,?,?,?,?,?,1,1,?,?,\'queued\',?,?,1,?)').run(task, task, f.project, agent, f.owner.accountId, device, 'a'.repeat(64), '{"v":1}', 'b'.repeat(64), JSON.stringify(payload), Date.now());
    f.db.exec('BEGIN'); f.sync.appendRecord(f.project, 'task', task); f.sync.appendRecord(f.project, 'device', device); f.db.exec('COMMIT');
    const page = f.sync.read(f.owner, { projectId: f.project });
    const taskEvent = page.page.events.find(event => event.recordKind === 'task'), deviceEvent = page.page.events.find(event => event.recordKind === 'device');
    assert.equal(taskEvent?.body.state, 'queued'); assert.equal(taskEvent?.body.taskId, task); assert(!JSON.stringify(taskEvent).includes('do not sync'));
    assert.equal(deviceEvent?.body.status, 'offline'); assert(!JSON.stringify(deviceEvent).includes('fixture-encryption-key'));
    const member = { ...f.owner, accountId: randomUUID(), subject: 'member' }, unassigned = { ...f.owner, accountId: randomUUID(), subject: 'unassigned' };
    for (const actor of [member,unassigned]) {
      f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(actor.accountId, actor.issuer, actor.subject, Date.now());
      f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, actor.accountId);
    }
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project, member.accountId, agent);
    f.db.exec('BEGIN'); f.sync.appendRecord(f.project, 'task', task); f.db.exec('COMMIT');
    const visible = f.sync.read(member, { projectId: f.project });
    assert.deepEqual(visible.page.events.filter(event => ['task','device'].includes(event.recordKind)).map(event => event.recordId).sort(), [device,task].sort());
    assert(!f.sync.read(unassigned, { projectId: f.project }).page.events.some(event => ['task','device'].includes(event.recordKind)));
    f.db.prepare("UPDATE record_scopes SET visibility='owner' WHERE table_name='turns' AND key_json=?").run(JSON.stringify([task]));
    assert.throws(() => f.sync.read(member, { projectId: f.project, cursor: visible.nextCursor! }), errorCode('resync_required'));
    assert(!f.sync.read(member, { projectId: f.project }).page.events.some(event => event.recordKind === 'task'));
  } finally { f.close(); }
});

test('workflow maintenance rolls back failed observations and retries one transition atomically', () => {
  const f = fixture(true);
  try {
    const installation = randomUUID(), device = randomUUID(), agent = randomUUID(), workflow = randomUUID(), run = randomUUID();
    f.db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation, f.owner.accountId, 'fixture-public-key', 'fixture-thumbprint', Date.now());
    f.db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[\"execution\"]',1)").run(device, installation, f.owner.accountId, 'fixture-public-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
    f.db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(agent, 'Workflow', 'fixture', 'Private instructions');
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, f.owner.accountId, device);
    f.db.prepare('INSERT INTO agent_projects VALUES (?,?,?,?,1,0)').run(f.project, agent, '', '{"v":1,"tools":[],"resources":[]}');
    f.db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'owner','agent',?)").run(JSON.stringify([agent]), f.owner.accountId, f.project, agent);
    const workflows = createProjectWorkflows(f.db, f.access, undefined, f.sync), detail = `/api/projects/${f.project}/workflows/${workflow}`;
    workflows.command(f.owner,f.project,`/api/projects/${f.project}/agents/${agent}/workflows`,'create',agent,{requestId:workflow,id:workflow,revision:0,name:'Atomic',graph:{entry:'approve',maxSteps:2,nodes:[{id:'approve',kind:'approval',prompt:'Approve',yes:'out'},{id:'out',kind:'output'}]}});
    workflows.runCommand(f.owner,f.project,detail+'/run','run',workflow,{requestId:run,id:run,revision:1,input:''});
    const before = f.sync.read(f.owner,{projectId:f.project});
    f.db.exec("CREATE TRIGGER fail_workflow_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='workflow_run' BEGIN SELECT RAISE(ABORT,'synthetic workflow observation failure'); END");
    assert.throws(() => workflows.maintain(), /synthetic workflow observation failure/);
    const unchanged = workflows.runRead(f.owner,f.project,{runId:run},new URLSearchParams()) as Record<string,unknown>;
    assert.equal(unchanged.status,'ready'); assert.equal(unchanged.revision,1); assert.deepEqual(unchanged.steps,[]);
    assert.deepEqual(f.sync.read(f.owner,{projectId:f.project,cursor:before.nextCursor!}).page.events,[]);
    f.db.exec('DROP TRIGGER fail_workflow_sync');
    workflows.maintain(); workflows.maintain();
    const recovered = f.sync.read(f.owner,{projectId:f.project,cursor:before.nextCursor!});
    assert.deepEqual(recovered.page.events.map(event => [event.recordId,event.revision,event.body.status]),[[run,2,'approval']]);
    const approved=randomUUID(); workflows.runCommand(f.owner,f.project,`/api/projects/${f.project}/workflow-runs/${run}/approve`,'approve',run,{requestId:approved,id:approved,revision:2,accepted:true});
    const beforeOutput=f.sync.read(f.owner,{projectId:f.project});
    for (const trigger of ["BEFORE INSERT ON project_workflow_notifications", "BEFORE INSERT ON sync_events WHEN NEW.record_kind='workflow_notification'"]) {
      f.db.exec(`CREATE TRIGGER fail_notice ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic inbox failure'); END`);
      assert.throws(()=>workflows.maintain(),/synthetic inbox failure/);
      const unchanged=workflows.runRead(f.owner,f.project,{runId:run},new URLSearchParams()) as Record<string,any>;
      assert.equal(unchanged.status,'ready'); assert.equal(unchanged.revision,3); assert.equal(unchanged.steps.length,1);
      assert.deepEqual(workflows.notifications(f.owner,f.project,new URLSearchParams()).items,[]);
      assert.deepEqual(f.sync.read(f.owner,{projectId:f.project,cursor:beforeOutput.nextCursor!}).page.events,[]);
      f.db.exec('DROP TRIGGER fail_notice');
    }
    workflows.maintain(); workflows.maintain();
    assert.equal(workflows.notifications(f.owner,f.project,new URLSearchParams()).items.length,1);
    assert.deepEqual(f.sync.read(f.owner,{projectId:f.project,cursor:beforeOutput.nextCursor!}).page.events.map(event=>[event.recordKind,event.revision]),[['workflow_notification',1],['workflow_run',4]]);
  } finally { f.close(); }
});

test('mail delivery observations commit with state and recover one provider effect after event failure', async () => {
  const f = fixture(), mail = { from: 'owner@example.com', origin: 'https://briefsip.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
  const access = createProjectAccess(f.db, f.auth, () => mail, [], f.sync), effects = new Set<string>(); let calls = 0;
  const provider = createServer(async (req,res) => {
    for await (const _ of req) { /* drain exact delivery bytes */ }
    calls++; effects.add(String(req.headers['idempotency-key']));
    res.setHeader('Content-Type','application/json'); res.end('{"id":"fixture-delivery"}');
  });
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const worker = createMailWorker(f.db, { apiKey: 'fixture', key: () => mail.key, endpoint: `http://127.0.0.1:${address.port}/emails`, development: true, now: f.options.now, sync: f.sync });
  try {
    const invitation = randomUUID();
    access.createInvitation(f.owner,f.project,{requestId:invitation,email:'member@example.com',expiresAt:Date.now()+86400000,expectedProjectRevision:1,agentAssignments:[]});
    const first = f.sync.read(f.owner,{projectId:f.project});
    f.db.exec("CREATE TRIGGER fail_mail_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='invitation' BEGIN SELECT RAISE(ABORT,'mail event failed'); END");
    await assert.rejects(worker.deliver(invitation),/mail event failed/);
    assert.equal(f.sync.read(f.owner,{projectId:f.project}).page.events.find(event=>event.recordId===invitation)!.body.state,'pending_delivery');
    assert.equal(f.sync.read(f.owner,{projectId:f.project,cursor:first.nextCursor!}).page.events.length,0);
    f.db.exec('DROP TRIGGER fail_mail_sync'); f.clock(f.options.now()+16000);
    assert.deepEqual(await worker.deliver(invitation),{state:'sent'}); assert.deepEqual(await worker.deliver(invitation),{state:'deferred'});
    const delta = f.sync.read(f.owner,{projectId:f.project,cursor:first.nextCursor!});
    assert.equal(delta.page.events.length,1); assert.deepEqual(delta.page.events.map(event=>[event.recordKind,event.revision,event.body.state]),[['invitation',2,'sent']]);
    assert.equal(calls,2); assert.equal(effects.size,1);
    for (const secret of ['member@example.com','fixture-delivery','invitationUrl','ciphertext','token_digest']) assert(!JSON.stringify(delta).includes(secret));
    const expired = randomUUID();
    access.createInvitation(f.owner,f.project,{requestId:expired,email:'expired@example.com',expiresAt:Date.now()+60000,expectedProjectRevision:1,agentAssignments:[]});
    const beforeExpiry = f.sync.read(f.owner,{projectId:f.project}); f.clock(Date.now()+61000); await worker.deliver(expired);
    assert.deepEqual(f.sync.read(f.owner,{projectId:f.project,cursor:beforeExpiry.nextCursor!}).page.events.map(event=>event.body.state),['expired']); assert.equal(calls,2);
  } finally { provider.closeAllConnections(); await new Promise<void>(resolve=>provider.close(()=>resolve())); f.close(); }
});

test('delta pagination keeps every event once within item and encoded response budgets', () => {
  const f = fixture();
  try {
    const first = f.sync.read(f.owner, { projectId: f.project });
    for (let n = 0; n < 600; n++) f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: n + 1, name: String(n).padStart(200, 'x') });
    let cursor = first.nextCursor!, seen = new Set<number>(), pages = 0;
    for (;;) {
      const page = f.sync.read(f.owner, { projectId: f.project, cursor }); pages++;
      assert(page.page.events.length <= 500); assert(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 256 * 1024);
      for (const event of page.page.events) { assert(!seen.has(event.position)); seen.add(event.position); }
      if (!page.page.events.length) break;
      cursor = page.nextCursor!;
    }
    assert.equal(seen.size, 600); assert(pages >= 3);
  } finally { f.close(); }
});

test('changed authorization closes prior readers before required resync can exhaust project capacity', () => {
  const f = fixture();
  try {
    const old = f.sync.read(f.owner, { projectId: f.project });
    members(f, 600);
    const one = f.sync.read(f.owner, { projectId: f.project }), two = f.sync.read(f.owner, { projectId: f.project });
    assert(one.nextPage && two.nextPage);
    f.db.prepare('UPDATE project_members SET grant_revision=grant_revision+1 WHERE project=? AND account=?').run(f.project, f.owner.accountId);
    assert.throws(() => f.sync.read(f.owner, { projectId: f.project, cursor: old.nextCursor! }), errorCode('resync_required'));
    assert(f.sync.read(f.owner, { projectId: f.project }).nextPage);
  } finally { f.close(); }
});

test('replacement invitation emits expiration of previous invitation in same canonical stream', () => {
  const f = fixture();
  try {
    const mail = { from: 'owner@example.com', origin: 'https://briefsip.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
    const access = createProjectAccess(f.db, f.auth, () => mail, [], f.sync);
    const first = { requestId: randomUUID(), email: 'member@example.com', expiresAt: Date.now() + 60000, expectedProjectRevision: 1, agentAssignments: [] };
    access.createInvitation(f.owner, f.project, first);
    f.db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, first.requestId);
    const snapshot = f.sync.read(f.owner, { projectId: f.project });
    const next = { ...first, requestId: randomUUID() }; access.createInvitation(f.owner, f.project, next);
    const events = f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor! }).page.events;
    assert(events.some(event => event.recordId === first.requestId && event.body.state === 'expired'));
    assert(events.some(event => event.recordId === next.requestId && event.body.state === 'pending_delivery'));
  } finally { f.close(); }
});

test('canonical maintenance prunes old sync events without deleting canonical receipts', async () => {
  const f = fixture();
  let app: Awaited<ReturnType<typeof startCanonicalApp>> | undefined;
  try {
    f.db.prepare('UPDATE sync_events SET committed_at=?').run(Date.now() - 90 * 86400_000 - 1);
    app = await startCanonicalApp({ database: join(f.dir, 'canonical.sqlite'), auth: { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_' + Buffer.from('fixture.clerk.accounts.dev$').toString('base64'), issuer: f.owner.issuer, origin: 'http://127.0.0.1', development: true } });
    const deadline = Date.now() + 10000;
    while (Number(f.db.prepare('SELECT count(*) AS n FROM sync_events').get()!.n) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sync_events').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n, 1);
    assert(Number(f.db.prepare('SELECT event_position FROM retention_floors').get()!.event_position) > 0);
  } finally { await app?.close(); f.close(); }
});
