import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { digestCommand, ProtocolError } from './shared/protocol.ts';
import type { startCanonicalApp } from './test-bridge.ts';
import { createMailWorker } from './test-support/legacy-mail-worker.ts';

import { canonicalHttp } from './test-support/canonical-http.ts';

type SyncEvent = { position: number; recordId: string; recordKind: string; operation: string; revision: number; body: Record<string, unknown> };
type SyncPage = { mode: string; highWaterPosition: number; retentionFloor: number; nextCursor: string | null; nextPage: string | null; snapshotHash: string | null; page: { events: SyncEvent[] } };
type Query = { projectId: string; cursor?: string | null; page?: string | null };
async function fixture(options: Partial<Parameters<typeof startCanonicalApp>[0]> = {}) {
  const f = canonicalHttp('briefsip-sync-');
  const { owner } = f;
  const project = randomUUID(), created = { requestId: randomUUID(), id: project, name: 'First project' };
  const projectPath = (id: string) => `/api/projects/${id}`;
  const access = {
    createProject: (actor: typeof owner, command: Record<string, unknown>) => f.request('/api/projects', 'POST', command, actor),
    editProject: (actor: typeof owner, id: string, command: Record<string, unknown>) => f.request(projectPath(id), 'PATCH', command, actor),
    editMember: (actor: typeof owner, id: string, account: string, command: Record<string, unknown>) => f.request(projectPath(id) + '/members/' + account, 'PATCH', command, actor),
    agentParticipation: (actor: typeof owner, id: string, agent: string, command: Record<string, unknown>) => f.request(projectPath(id) + '/agents/' + agent, 'PUT', command, actor),
    setResponsePolicy: (actor: typeof owner, id: string, agent: string, command: Record<string, unknown>) => f.request(projectPath(id) + '/agents/' + agent + '/response-policy', 'PUT', command, actor),
    createInvitation: (actor: typeof owner, id: string, command: Record<string, unknown>) => f.request(projectPath(id) + '/invitations', 'POST', command, actor),
  };
  const sync = { async read(actor: typeof owner, query: Query): Promise<SyncPage> {
    const params = new URLSearchParams({ projectId: query.projectId });
    if (query.cursor != null) params.set('cursor', query.cursor);
    if (query.page != null) params.set('page', query.page);
    return (await f.request('/api/sync?' + params, 'GET', undefined, actor)).data;
  } };
  try {
    await f.start(options);
    await access.createProject(owner, created);
    return { ...f, access, sync, project, created };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('sync captures current records and delta changes exactly once with scope-bound cursors', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.sync.read(f.owner, { projectId: f.project });
    assert.equal(snapshot.mode, 'snapshot'); assert(snapshot.nextCursor); assert.equal(snapshot.nextPage, null);
    assert.equal(snapshot.snapshotHash, digestCommand(snapshot.page.events));
    assert(snapshot.page.events.some(event => event.recordKind === 'project' && event.body.name === 'First project'));
    const edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Second name' };
    const accepted = await f.access.editProject(f.owner, f.project, edit);
    assert.deepEqual((await f.access.editProject(f.owner, f.project, edit)).receipt, accepted.receipt);
    const delta = await f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor });
    assert.equal(delta.mode, 'delta'); assert.equal(delta.page.events.length, 1);
    assert.equal(delta.page.events[0].body.name, 'Second name');
    assert.deepEqual((await f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor })).page.events, delta.page.events);
    assert.deepEqual((await f.sync.read(f.owner, { projectId: f.project, cursor: delta.nextCursor! })).page.events, []);
    await assert.rejects(() => f.access.editProject(f.owner, f.project, { ...edit, name: 'Conflicting body' }), (error: unknown) => error instanceof ProtocolError && error.code === 'payload_conflict');
    await assert.rejects(() => f.access.editProject(f.owner, f.project, { ...edit, requestId: randomUUID() }), (error: unknown) => error instanceof ProtocolError && error.code === 'stale_revision');
  } finally { await f.close(); }
});

function members(f: Awaited<ReturnType<typeof fixture>>, count: number) {
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

test('large snapshots keep one read position while writes continue and latest-page retries stay exact', async () => {
  const f = await fixture();
  try {
    members(f, 1200);
    const first = await f.sync.read(f.owner, { projectId: f.project });
    assert(first.nextPage); assert.equal(first.nextCursor, null); assert.equal(first.snapshotHash, null);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'During snapshot' });
    const second = await f.sync.read(f.owner, { projectId: f.project, page: first.nextPage });
    assert.deepEqual(await f.sync.read(f.owner, { projectId: f.project, page: first.nextPage }), second);
    assert(second.nextPage);
    const final = await f.sync.read(f.owner, { projectId: f.project, page: second.nextPage });
    const all = [first, second, final].flatMap(page => page.page.events);
    assert.equal(final.snapshotHash, digestCommand(all)); assert(final.nextCursor); assert.equal(final.nextPage, null);
    assert.equal(all.find(event => event.recordKind === 'project')!.body.name, 'First project');
    for (const page of [first, second, final]) { assert(page.page.events.length <= 500); assert(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 256 * 1024); assert(page.page.events.every(event => event.position === first.highWaterPosition)); }
    await assert.rejects(() => f.sync.read(f.owner, { projectId: f.project, page: first.nextPage! }), (error: unknown) => error instanceof ProtocolError && error.code === 'sync_page_conflict');
    assert.deepEqual((await f.sync.read(f.owner, { projectId: f.project, cursor: final.nextCursor })).page.events.map(event => event.body.name), ['During snapshot']);
  } finally { await f.close(); }
});

const errorCode = (code: string) => (error: unknown) => error instanceof ProtocolError && error.code === code;

test('scope denial, permission changes and malformed cursors disclose no historical payload', async () => {
  const f = await fixture();
  try {
    const first = await f.sync.read(f.owner, { projectId: f.project }), other = randomUUID();
    await f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Other project' });
    await assert.rejects(() => f.sync.read(f.owner, { projectId: other, cursor: first.nextCursor! }), errorCode('sync_cursor_scope'));
    for (const cursor of ['', 'broken', first.nextCursor! + 'x']) await assert.rejects(() => f.sync.read(f.owner, { projectId: f.project, cursor }), errorCode('invalid_sync_cursor'));
    const account = randomUUID(), member = { ...f.owner, accountId: account, subject: 'member' };
    f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, member.issuer, member.subject, Date.now());
    f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, account);
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: first.nextCursor! }), errorCode('sync_cursor_scope'));
    const own = await f.sync.read(member, { projectId: f.project });
    assert(own.page.events.every(event => event.recordKind !== 'member' || event.body.accountId === account));
    await f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 1, deleted: true });
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: own.nextCursor! }), errorCode('sync_scope_denied'));
    f.db.prepare('UPDATE project_members SET deleted=0,grant_revision=grant_revision+1 WHERE project=? AND account=?').run(f.project, account);
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: own.nextCursor! }), errorCode('resync_required'));
    const delta = await f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert(delta.page.events.some(event => event.recordKind === 'member' && event.operation === 'revoke'));
    f.db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(f.owner.accountId);
    await assert.rejects(() => f.sync.read(f.owner, { projectId: f.project }), errorCode('session_invalid'));
  } finally { await f.close(); }
});

test('scoped event chains distinguish unrelated numeric gaps from actual segment loss', async () => {
  const f = await fixture();
  try {
    const first = await f.sync.read(f.owner, { projectId: f.project }), other = randomUUID();
    await f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Unrelated' });
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'One' });
    const second = await f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert.equal(second.page.events.length, 1); assert(second.page.events[0].position > first.highWaterPosition + 1);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 2, name: 'Missing' });
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 3, name: 'After missing' });
    f.db.prepare('DELETE FROM sync_events WHERE project=? AND revision=3').run(f.project);
    await assert.rejects(() => f.sync.read(f.owner, { projectId: f.project, cursor: second.nextCursor! }), errorCode('resync_required'));
  } finally { await f.close(); }
});

test('event persistence failures roll back canonical mutation and receipt before exact retry', async () => {
  const f = await fixture();
  try {
    const first = await f.sync.read(f.owner, { projectId: f.project }), edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Atomic name' };
    f.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON sync_events BEGIN SELECT RAISE(ABORT,'event storage failed'); END;");
    await assert.rejects(() => f.access.editProject(f.owner, f.project, edit), errorCode('storage_failed'));
    assert.equal((await f.sync.read(f.owner, { projectId: f.project })).page.events.find(event => event.recordKind === 'project')!.body.name, 'First project');
    assert.equal(f.db.prepare('SELECT 1 FROM receipts WHERE request_id=?').get(edit.requestId), undefined);
    f.db.exec('DROP TRIGGER fail_event');
    await f.access.editProject(f.owner, f.project, edit);
    const delta = await f.sync.read(f.owner, { projectId: f.project, cursor: first.nextCursor! });
    assert.equal(delta.page.events.length, 1); assert.equal(delta.page.events[0].body.name, 'Atomic name');
  } finally { await f.close(); }
});

test('same agent keeps project-specific rules while response policies and assignment revocations remain reader scoped', async () => {
  const f = await fixture();
  try {
    const installation = randomUUID(), device = randomUUID(), agent = randomUUID(), account = randomUUID(), other = randomUUID();
    f.db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation, f.owner.accountId, 'fixture-public-key', 'fixture-thumbprint', Date.now());
    f.db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[]',1)").run(device, installation, f.owner.accountId, 'fixture-public-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
    f.db.prepare('INSERT INTO agents(id,name,role,model,instructions) VALUES (?,?,?,?,?)').run(agent, 'Shared profile', 'Personal agent', 'fixture', 'Private profile instructions');
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, f.owner.accountId, device);
    f.db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'owner','agent',?)").run(JSON.stringify([agent]), f.owner.accountId, f.project, agent);
    await f.access.createProject(f.owner, { requestId: randomUUID(), id: other, name: 'Other context' });
    for (const [project, rules] of [[f.project, 'Project A rules'], [other, 'Project B rules']]) await f.access.agentParticipation(f.owner, project, agent, { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 0, rules, capabilities: { v: 1, tools: [], resources: [] } });
    const member = { ...f.owner, accountId: account, subject: 'member' };
    f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, member.issuer, member.subject, Date.now());
    f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, account);
    const beforeAssignment = await f.sync.read(member, { projectId: f.project });
    assert(!beforeAssignment.page.events.some(event => event.recordKind === 'agent'));
    await f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 1, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 0, enabled: true }] });
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: beforeAssignment.nextCursor! }), errorCode('resync_required'));
    const assigned = await f.sync.read(member, { projectId: f.project });
    assert.equal(assigned.page.events.find(event => event.recordKind === 'agent')!.body.rules, 'Project A rules');
    assert.equal(assigned.page.events.find(event => event.recordKind === 'agent')!.body.role, 'Personal agent');
    assert(!JSON.stringify(assigned).includes('Project B rules')); assert(!JSON.stringify(assigned).includes('Private profile instructions'));
    await f.access.setResponsePolicy(f.owner, f.project, agent, { requestId: randomUUID(), accountId: account, expectedRevision: 1, respond: false });
    const policy = await f.sync.read(member, { projectId: f.project, cursor: assigned.nextCursor! });
    assert.equal(policy.page.events.length, 1); assert.equal(policy.page.events[0].body.respond, false);
    await f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 2, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 1, enabled: false }] });
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: policy.nextCursor! }), errorCode('resync_required'));
    assert(!(await f.sync.read(member, { projectId: f.project })).page.events.some(event => event.recordKind === 'agent'));
    await f.access.editMember(f.owner, f.project, account, { requestId: randomUUID(), expectedRevision: 3, agentAssignments: [{ agentId: agent, expectedAgentRevision: 1, expectedParticipationRevision: 1, expectedAssignmentRevision: 2, enabled: true }] });
    const ownerBeforeReactivation = await f.sync.read(f.owner, { projectId: f.project });
    f.db.prepare('UPDATE agent_projects SET deleted=1,revision=2 WHERE project=? AND agent=?').run(f.project, agent);
    await f.access.agentParticipation(f.owner, f.project, agent, { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 2, rules: 'Reactivated rules', capabilities: { v: 1, tools: [], resources: [] } });
    const reactivated = await f.sync.read(f.owner, { projectId: f.project, cursor: ownerBeforeReactivation.nextCursor! });
    assert(reactivated.page.events.some(event => event.recordKind === 'assignment' && event.operation === 'revoke'));
    assert(reactivated.page.events.some(event => event.recordKind === 'response_policy' && event.body.respond === false));
  } finally { await f.close(); }
});

test('task and home-device observations sync without task payload or device secrets', async () => {
  const f = await fixture();
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
    const page = await f.sync.read(f.owner, { projectId: f.project });
    const taskEvent = page.page.events.find(event => event.recordKind === 'task'), deviceEvent = page.page.events.find(event => event.recordKind === 'device');
    assert.equal(taskEvent?.body.state, 'queued'); assert.equal(taskEvent?.body.taskId, task); assert(!JSON.stringify(taskEvent).includes('do not sync'));
    assert.equal(deviceEvent?.body.status, 'offline'); assert(!JSON.stringify(deviceEvent).includes('fixture-encryption-key'));
    const member = { ...f.owner, accountId: randomUUID(), subject: 'member' }, unassigned = { ...f.owner, accountId: randomUUID(), subject: 'unassigned' };
    for (const actor of [member,unassigned]) {
      f.db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(actor.accountId, actor.issuer, actor.subject, Date.now());
      f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, actor.accountId);
    }
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project, member.accountId, agent);
    const visible = await f.sync.read(member, { projectId: f.project });
    assert.deepEqual(visible.page.events.filter(event => ['task','device'].includes(event.recordKind)).map(event => event.recordId).sort(), [device,task].sort());
    assert(!(await f.sync.read(unassigned, { projectId: f.project })).page.events.some(event => ['task','device'].includes(event.recordKind)));
    f.db.prepare("UPDATE record_scopes SET visibility='owner' WHERE table_name='turns' AND key_json=?").run(JSON.stringify([task]));
    await assert.rejects(() => f.sync.read(member, { projectId: f.project, cursor: visible.nextCursor! }), errorCode('resync_required'));
    assert(!(await f.sync.read(member, { projectId: f.project })).page.events.some(event => event.recordKind === 'task'));
  } finally { await f.close(); }
});

test('delta pagination keeps every event once within item and encoded response budgets', async () => {
  const f = await fixture();
  try {
    const first = await f.sync.read(f.owner, { projectId: f.project });
    for (let n = 0; n < 600; n++) await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: n + 1, name: String(n).padStart(200, 'x') });
    let cursor = first.nextCursor!, seen = new Set<number>(), pages = 0;
    for (;;) {
      const page = await f.sync.read(f.owner, { projectId: f.project, cursor }); pages++;
      assert(page.page.events.length <= 500); assert(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 256 * 1024);
      for (const event of page.page.events) { assert(!seen.has(event.position)); seen.add(event.position); }
      if (!page.page.events.length) break;
      cursor = page.nextCursor!;
    }
    assert.equal(seen.size, 600); assert(pages >= 3);
  } finally { await f.close(); }
});

test('changed authorization closes prior readers before required resync can exhaust project capacity', async () => {
  const f = await fixture();
  try {
    const old = await f.sync.read(f.owner, { projectId: f.project });
    members(f, 600);
    const one = await f.sync.read(f.owner, { projectId: f.project }), two = await f.sync.read(f.owner, { projectId: f.project });
    assert(one.nextPage && two.nextPage);
    f.db.prepare('UPDATE project_members SET grant_revision=grant_revision+1 WHERE project=? AND account=?').run(f.project, f.owner.accountId);
    await assert.rejects(() => f.sync.read(f.owner, { projectId: f.project, cursor: old.nextCursor! }), errorCode('resync_required'));
    assert((await f.sync.read(f.owner, { projectId: f.project })).nextPage);
  } finally { await f.close(); }
});

test('replacement invitation emits expiration of previous invitation in same canonical stream', async () => {
  const mail = { from: 'owner@example.com', origin: 'https://briefsip.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
  const f = await fixture({ mail: () => mail, mailFrom: mail.from, mailOrigin: mail.origin });
  try {
    const { access } = f;
    const first = { requestId: randomUUID(), email: 'member@example.com', expiresAt: Date.now() + 60000, expectedProjectRevision: 1, agentAssignments: [] };
    await access.createInvitation(f.owner, f.project, first);
    f.db.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, first.requestId);
    const snapshot = await f.sync.read(f.owner, { projectId: f.project });
    const next = { ...first, requestId: randomUUID() }; await access.createInvitation(f.owner, f.project, next);
    const events = (await f.sync.read(f.owner, { projectId: f.project, cursor: snapshot.nextCursor! })).page.events;
    assert(events.some(event => event.recordId === first.requestId && event.body.state === 'expired'));
    assert(events.some(event => event.recordId === next.requestId && event.body.state === 'pending_delivery'));
  } finally { await f.close(); }
});

test('canonical maintenance prunes old sync events without deleting canonical receipts', async () => {
  const f = await fixture();
  try {
    f.db.prepare('UPDATE sync_events SET committed_at=?').run(Date.now() - 90 * 86400_000 - 1);
    const deadline = Date.now() + 10000;
    while (Number(f.db.prepare('SELECT count(*) AS n FROM sync_events').get()!.n) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sync_events').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n, 1);
    assert(Number(f.db.prepare('SELECT event_position FROM retention_floors').get()!.event_position) > 0);
  } finally { await f.close(); }
});

test('snapshot admission, expiry, revoked continuations and restart release readers without granting stale access', async () => {
  const now = Date.now();
  const f = await fixture({ fixedClock: now });
  const query = { projectId: f.project };
  try {
    members(f, 600);
    const first = await f.sync.read(f.owner, query), second = await f.sync.read(f.owner, query);
    assert(first.nextPage && second.nextPage);
    await assert.rejects(f.sync.read(f.owner, query), errorCode('server_capacity'));
    f.db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(f.owner.accountId);
    await assert.rejects(f.sync.read(f.owner, { ...query, page: first.nextPage }), errorCode('session_invalid'));
    f.db.prepare('UPDATE accounts SET blocked=0 WHERE id=?').run(f.owner.accountId);
    await assert.rejects(f.sync.read(f.owner, { ...query, page: second.nextPage }), errorCode('resync_required'));
    const expiring = await f.sync.read(f.owner, query);
    await f.start({ fixedClock: now + 60000 });
    await assert.rejects(f.sync.read(f.owner, { ...query, page: expiring.nextPage }), errorCode('resync_required'));
    const restarting = await f.sync.read(f.owner, query);
    await f.start({ fixedClock: now + 60000 });
    await assert.rejects(f.sync.read(f.owner, { ...query, page: restarting.nextPage }), errorCode('resync_required'));
  } finally { await f.close(); }
});

test('cleanup and excessive WAL growth invalidate unfinished snapshots and preserve consistent retry', async () => {
  const f = await fixture();
  const query = { projectId: f.project };
  try {
    members(f, 600);
    const snapshot = await f.sync.read(f.owner, query);
    assert(snapshot.nextPage);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'New snapshot required' });
    f.db.prepare('UPDATE sync_events SET committed_at=?').run(Date.now() - 90 * 86400_000 - 1);
    await waitFor(() => f.db.prepare('SELECT count(*) AS n FROM sync_events').get()!.n === 0);
    await assert.rejects(f.sync.read(f.owner, { ...query, page: snapshot.nextPage }), errorCode('resync_required'));
    const wal = await f.sync.read(f.owner, query);
    f.db.exec('CREATE TABLE private_test_bytes(bytes BLOB) STRICT; INSERT INTO private_test_bytes VALUES (zeroblob(34603008));');
    await assert.rejects(f.sync.read(f.owner, { ...query, page: wal.nextPage }), errorCode('resync_required'));
    const replacement = await f.sync.read(f.owner, query);
    const final = await f.sync.read(f.owner, { ...query, page: replacement.nextPage });
    assert.equal(final.page.events.find(event => event.recordKind === 'project')!.body.name, 'New snapshot required');
    assert(!JSON.stringify(final).includes('private_test_bytes'));
  } finally { await f.close(); }
});

async function waitFor(ready: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!ready()) {
    assert(Date.now() < deadline, 'Rust maintenance did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('retention honors exact 90-day boundary, retains receipts and tombstones, and rolls back failed floor writes', async () => {
  const started = Date.now(), horizon = 90 * 86400_000;
  const f = await fixture({ fixedClock: started });
  const query = { projectId: f.project };
  try {
    const first = await f.sync.read(f.owner, query);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 1, name: 'Retained value' });
    await f.start({ fixedClock: started + horizon });
    const events = () => f.db.prepare('SELECT count(*) n FROM sync_events').get()!.n;
    const floors = () => f.db.prepare('SELECT count(*) n FROM retention_floors').get()!.n;

    // Use an older unrelated event to prove maintenance ran past the boundary.
    const unrelated = randomUUID();
    await f.access.createProject(f.owner, { requestId: randomUUID(), id: unrelated, name: 'Maintenance sentinel' });
    f.db.prepare('UPDATE sync_events SET committed_at=? WHERE project=?').run(started - 1, unrelated);
    await waitFor(() => events() === 2);
    assert.equal((await f.sync.read(f.owner, { ...query, cursor: first.nextCursor })).page.events[0].body.name, 'Retained value');
    const priorFloors = floors();
    f.db.exec("CREATE TRIGGER fail_floor BEFORE INSERT ON retention_floors BEGIN SELECT RAISE(ABORT,'floor write failed'); END");
    await f.start({ fixedClock: started + horizon + 1 });
    await new Promise(resolve => setTimeout(resolve, 5200));
    assert.equal(floors(), priorFloors);
    assert.equal(events(), 2);
    f.db.exec('DROP TRIGGER fail_floor');
    await waitFor(() => events() === 0);
    await assert.rejects(f.sync.read(f.owner, { ...query, cursor: first.nextCursor }), errorCode('resync_required'));
    const replacement = await f.sync.read(f.owner, query);
    assert.equal(replacement.page.events.find(event => event.recordKind === 'project')!.body.name, 'Retained value');
    assert(replacement.retentionFloor >= first.highWaterPosition);
    assert.equal((await f.access.createProject(f.owner, f.created)).receipt.recordRevision, 1);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 2, name: 'After cleanup' });
    assert((await f.sync.read(f.owner, { ...query, cursor: replacement.nextCursor })).page.events[0].position > replacement.highWaterPosition);
    await f.access.editProject(f.owner, f.project, { requestId: randomUUID(), expectedRevision: 3, deleted: true });
    await assert.rejects(f.sync.read(f.owner, query), errorCode('sync_scope_denied'));
    assert.equal(f.db.prepare('SELECT deleted FROM projects WHERE id=?').get(f.project)!.deleted, 1);
  } finally { await f.close(); }
});

test('mail delivery observations commit with state and recover one provider effect after event failure', async () => {
  const now = Date.now();
  const mail = { from: 'owner@example.com', origin: 'https://briefsip.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
  const options = { mail: () => mail, mailFrom: mail.from, mailOrigin: mail.origin, fixedClock: now };
  const f = await fixture(options);
  const effects = new Set<string>();
  let calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* drain exact delivery bytes */ }
    calls++;
    effects.add(String(req.headers['idempotency-key']));
    res.setHeader('Content-Type', 'application/json');
    res.end('{"id":"fixture-delivery"}');
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert(address && typeof address !== 'string');
    const delivery = { mailApiKey: 'fixture', mailEndpoint: `http://127.0.0.1:${address.port}/emails` };
    const invitation = randomUUID(), query = { projectId: f.project };
    await f.access.createInvitation(f.owner, f.project, { requestId: invitation, email: 'member@example.com', expiresAt: now + 86400000, expectedProjectRevision: 1, agentAssignments: [] });
    const first = await f.sync.read(f.owner, query);
    f.db.exec("CREATE TRIGGER fail_mail_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='invitation' BEGIN SELECT RAISE(ABORT,'mail event failed'); END");
    await f.start({ ...options, ...delivery });
    await waitFor(() => calls === 1);
    assert.equal((await f.sync.read(f.owner, query)).page.events.find(event => event.recordId === invitation)!.body.state, 'pending_delivery');
    assert.equal((await f.sync.read(f.owner, { ...query, cursor: first.nextCursor })).page.events.length, 0);
    await f.stop();
    f.db.exec('DROP TRIGGER fail_mail_sync');
    await f.start({ ...options, ...delivery, fixedClock: now + 16000 });
    const state = (id: string) => f.db.prepare('SELECT state FROM invitations WHERE id=?').get(id)?.state;
    await waitFor(() => state(invitation) === 'sent');
    const delta = await f.sync.read(f.owner, { ...query, cursor: first.nextCursor });
    assert.deepEqual(delta.page.events.map(event => [event.recordKind,event.revision,event.body.state]), [['invitation',2,'sent']]);
    assert.equal(calls, 2);
    assert.equal(effects.size, 1);
    assert(!effects.has('undefined'));
    for (const secret of ['member@example.com','fixture-delivery','invitationUrl','ciphertext','token_digest']) assert(!JSON.stringify(delta).includes(secret));
    await f.start(options);
    const expired = randomUUID();
    await f.access.createInvitation(f.owner, f.project, { requestId: expired, email: 'expired@example.com', expiresAt: now + 60000, expectedProjectRevision: 1, agentAssignments: [] });
    const beforeExpiry = await f.sync.read(f.owner, query);
    await f.start({ ...options, ...delivery, fixedClock: now + 61000 });
    await waitFor(() => state(expired) === 'expired');
    assert.deepEqual((await f.sync.read(f.owner, { ...query, cursor: beforeExpiry.nextCursor })).page.events.map(event => event.body.state), ['expired']);
    assert.equal(calls, 2);
  } finally {
    await f.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test('workflow maintenance rolls back failed observations and retries one transition atomically', async () => {
  const f = await fixture();
  try {
    const installation = randomUUID(), device = randomUUID(), agent = randomUUID(), workflow = randomUUID(), run = randomUUID();
    f.db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation, f.owner.accountId, 'fixture-public-key', 'fixture-thumbprint', Date.now());
    f.db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[\"execution\"]',1)").run(device, installation, f.owner.accountId, 'fixture-public-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
    f.db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(agent, 'Workflow', 'fixture', 'Private instructions');
    f.db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, f.owner.accountId, device);
    f.db.prepare('INSERT INTO agent_projects VALUES (?,?,?,?,1,0)').run(f.project, agent, '', '{"v":1,"tools":[],"resources":[]}');
    f.db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'owner','agent',?)").run(JSON.stringify([agent]), f.owner.accountId, f.project, agent);
    const base = `/api/projects/${f.project}`, path = `${base}/workflow-runs/${run}`, query = { projectId: f.project };
    await f.request(`${base}/agents/${agent}/workflows`, 'POST', {requestId:workflow,id:workflow,revision:0,name:'Atomic',graph:{entry:'approve',maxSteps:2,nodes:[{id:'approve',kind:'approval',prompt:'Approve',yes:'out'},{id:'out',kind:'output'}]}});
    f.db.exec("CREATE TRIGGER fail_workflow_sync BEFORE INSERT ON sync_events WHEN NEW.record_kind='workflow_run' AND NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic workflow observation failure'); END");
    await f.request(`${base}/workflows/${workflow}/run`, 'POST', {requestId:run,id:run,revision:1,input:''});
    const before = await f.sync.read(f.owner, query);
    const runState = () => f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run)?.status;
    const checkRun = async (revision: number, steps: number) => {
      const { data } = await f.request(path);
      assert.equal(data.status, 'ready');
      assert.equal(data.revision, revision);
      assert.equal(data.steps.length, steps);
    };
    await new Promise(resolve => setTimeout(resolve, 1200));
    await checkRun(1, 0);
    assert.deepEqual((await f.sync.read(f.owner, { ...query, cursor: before.nextCursor })).page.events, []);
    f.db.exec('DROP TRIGGER fail_workflow_sync');
    await waitFor(() => runState() === 'approval');
    const recovered = await f.sync.read(f.owner, { ...query, cursor: before.nextCursor });
    assert.deepEqual(recovered.page.events.map(event => [event.recordId,event.revision,event.body.status]), [[run,2,'approval']]);
    f.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON project_workflow_notifications BEGIN SELECT RAISE(ABORT,'synthetic inbox failure'); END");
    const approved = randomUUID();
    await f.request(path + '/approve', 'POST', {requestId:approved,id:approved,revision:2,accepted:true});
    const beforeOutput = await f.sync.read(f.owner, query);
    for (const next of ["BEFORE INSERT ON sync_events WHEN NEW.record_kind='workflow_notification'", null]) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await checkRun(3, 1);
      assert.equal(f.db.prepare('SELECT count(*) n FROM project_workflow_notifications').get()!.n, 0);
      assert.deepEqual((await f.sync.read(f.owner, { ...query, cursor: beforeOutput.nextCursor })).page.events, []);
      f.db.exec('DROP TRIGGER fail_notice;' + (next ? `CREATE TRIGGER fail_notice ${next} BEGIN SELECT RAISE(ABORT,'synthetic inbox failure'); END` : ''));
    }
    await waitFor(() => runState() === 'done');
    assert.equal(f.db.prepare('SELECT count(*) n FROM project_workflow_notifications').get()!.n, 1);
    assert.deepEqual((await f.sync.read(f.owner, { ...query, cursor: beforeOutput.nextCursor })).page.events.map(event => [event.recordKind,event.revision]), [['workflow_notification',1],['workflow_run',4]]);
  } finally { await f.close(); }
});
