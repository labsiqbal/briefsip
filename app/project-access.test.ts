import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createProjectAccess, parseInvitationCreate, parseMemberEdit, parseResponsePolicy } from './project-access.ts';
import { initializeCanonicalSchema } from './schema.ts';
import { decryptMail } from './test-support/mail-fixture.ts';
import type { HumanActor } from './test-support/auth.ts';
import { ProtocolError } from './shared/protocol.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT'); initializeCanonicalSchema(db, Date.now(), 1);
  const project = randomUUID(), agent = randomUUID(), secondAgent = randomUUID();
  const actor = (subject: string): HumanActor => ({ accountId: randomUUID(), issuer: 'https://fixture.example', subject, sessionId: `sess_${subject}`, expiresAt: Date.now() + 60000 });
  const owner = actor('owner'), member = actor('member'), stranger = actor('stranger');
  for (const a of [owner, member, stranger]) db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(a.accountId, a.issuer, a.subject, Date.now());
  db.prepare('INSERT INTO projects VALUES (?,?,?,0,0,1)').run(project, owner.accountId, 'Fixture');
  db.prepare("INSERT INTO project_members VALUES (?,?,'owner',1,0)").run(project, owner.accountId);
  for (const a of [agent, secondAgent]) {
    db.prepare('INSERT INTO agents(id,revision) VALUES (?,1)').run(a);
    db.prepare("INSERT INTO agent_projects VALUES (?,?,'','{\"v\":1,\"tools\":[],\"resources\":[]}',1,0)").run(project, a);
    db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'project','agent',?)").run(JSON.stringify([a]), owner.accountId, project, a);
  }
  let mailbox = 'member@example.com';
  const config = { from: 'Briefsip <noreply@example.com>', origin: 'https://briefsip.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
  const access = createProjectAccess(db, {
    requireCurrent(a) { if (db.prepare('SELECT blocked FROM accounts WHERE id=?').get(a.accountId)?.blocked !== 0 || db.prepare('SELECT 1 FROM session_denials WHERE issuer=? AND sid=?').get(a.issuer, a.sessionId)) throw new ProtocolError(401, 'session_invalid', 'Session denied.'); return a; },
    async verifiedMailboxes() { return [mailbox]; },
  }, () => config);
  const assignment = (agentId = agent) => ({ agentId, expectedAgentRevision: 1, expectedParticipationRevision: 1 });
  const create = (agents: ReturnType<typeof assignment>[] = [assignment()]) => {
    const command = { requestId: randomUUID(), email: 'MEMBER@Example.com', agentAssignments: agents, expiresAt: Date.now() + 60000, expectedProjectRevision: 1 };
    const result = access.createInvitation(owner, project, command);
    const invitation = db.prepare('SELECT * FROM invitations WHERE id=?').get(command.requestId)!;
    const outbox = db.prepare('SELECT * FROM mail_outbox WHERE id=?').get(command.requestId)!;
    const plain = decryptMail(command.requestId, 1, String(invitation.authority_generation), String(invitation.email_hash), outbox.ciphertext as Uint8Array, config.key);
    const proof = plain.payload.text.match(/#([A-Za-z0-9_-]{43})/)![1];
    return { command, result, proof, accept: { requestId: randomUUID(), mailboxProof: proof, expectedRevision: 1 } };
  };
  return { db, owner, member, stranger, access, project, agent, secondAgent, assignment, create, mailbox: (value: string) => { mailbox = value; } };
}

test('closed invitation/member/policy parsers normalize flags and reject obsolete authority', () => {
  const input = { requestId: randomUUID(), email: 'User@Example.COM', expiresAt: Date.now() + 60000, expectedProjectRevision: 1, agentAssignments: [{ agentId: randomUUID().toUpperCase(), expectedAgentRevision: 1, expectedParticipationRevision: 1 }] };
  const result = parseInvitationCreate(input); assert.equal(result.email, 'user@example.com'); assert.equal(result.agentAssignments[0].enabled, true); assert.equal(result.agentAssignments[0].respond, true);
  assert.throws(() => parseInvitationCreate({ ...input, agentAssignments: [...input.agentAssignments, ...input.agentAssignments] }), /Duplicate/);
  for (const change of [{ expectedProjectRevision: 0 }, { role: 'owner' }, { agentAssignments: [{ ...input.agentAssignments[0], respond: 'false' }] }]) assert.throws(() => parseInvitationCreate({ ...input, ...change }));
  assert.throws(() => parseMemberEdit({ requestId: randomUUID(), expectedRevision: 1, deleted: true, agentAssignments: [] }));
  assert.throws(() => parseMemberEdit({ requestId: randomUUID(), expectedRevision: 1, agents: [] }));
  assert.throws(() => parseResponsePolicy({ requestId: randomUUID(), accountId: randomUUID(), expectedRevision: 1, respond: 0 }));
});

test('accept consumes once; exact retry preserves later policy changes and revoked access stays denied', async () => {
  const f = fixture(); const { db, access, owner, member, stranger, project, agent } = f;
  try {
    const invite = f.create(); assert.equal(access.createInvitation(owner, project, invite.command).status, 200);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, { ...invite.accept, mailboxProof: randomBytes(32).toString('base64url') }), /Resource/);
    f.mailbox('wrong@example.com'); await assert.rejects(access.acceptInvitation(member, invite.command.requestId, invite.accept), /Resource/); f.mailbox('member@example.com');
    const accepted = await access.acceptInvitation(member, invite.command.requestId, invite.accept); assert.equal(accepted.data.grantRevision, 1);
    assert(access.requireAgentExecution(member, project, agent)); assert.equal(access.requireAgentResponsePolicy(member, project, agent), true);
    const toggle = { requestId: randomUUID(), accountId: member.accountId, expectedRevision: 1, respond: false };
    access.setResponsePolicy(owner, project, agent, toggle); assert.equal(access.requireAgentResponsePolicy(member, project, agent), false); assert(access.requireAgentExecution(member, project, agent));
    assert.deepEqual((await access.acceptInvitation(member, invite.command.requestId, invite.accept)).data, accepted.data); assert.equal(access.requireAgentResponsePolicy(member, project, agent), false);
    assert.equal(db.prepare('SELECT revision FROM collaborator_agents').get()!.revision, 1);
    assert.equal(access.setResponsePolicy(owner, project, agent, toggle).status, 200);
    assert.throws(() => access.setResponsePolicy(owner, project, agent, { ...toggle, requestId: randomUUID() }), /revision/);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, { ...invite.accept, requestId: randomUUID() }), /used/);
    const revoke = { requestId: randomUUID(), expectedRevision: 1, deleted: true };
    access.editMember(owner, project, member.accountId, revoke);
    assert.throws(() => access.requireProjectMember(member, project), /Resource/); assert.throws(() => access.requireProjectMember(stranger, project), /Resource/);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, invite.accept), /Resource/);
    assert.equal(access.editMember(owner, project, member.accountId, revoke).status, 200);
    assert.equal(db.prepare('SELECT length(ciphertext) AS n FROM mail_outbox').get()!.n, 0);
  } finally { db.close(); }
});

test('invitation CAS, rollback, tombstone rejoin, missing policy and revoke ordering', async () => {
  const f = fixture(); const { db, access, owner, member, project, agent, secondAgent } = f;
  try {
    const first = f.create([f.assignment(), f.assignment(secondAgent)]); await access.acceptInvitation(member, first.command.requestId, first.accept);
    access.editMember(owner, project, member.accountId, { requestId: randomUUID(), expectedRevision: 1, deleted: true });
    const rejoin = f.create([f.assignment(secondAgent)]); await access.acceptInvitation(member, rejoin.command.requestId, rejoin.accept);
    assert.equal(db.prepare('SELECT grant_revision FROM project_members WHERE account=?').get(member.accountId)!.grant_revision, 3);
    assert.deepEqual({ ...db.prepare('SELECT enabled,revision FROM collaborator_agents WHERE agent=?').get(agent) }, { enabled: 0, revision: 3 });
    assert.equal(db.prepare('SELECT respond FROM response_policies WHERE agent=?').get(agent)!.respond, 0);
    assert.equal(db.prepare('SELECT enabled FROM collaborator_agents WHERE agent=?').get(secondAgent)!.enabled, 1);
    db.prepare('DELETE FROM response_policies WHERE agent=?').run(agent);
    assert.throws(() => access.requireAgentResponsePolicy(member, project, agent), /policy/);
    assert.throws(() => access.setResponsePolicy(owner, project, agent, { requestId: randomUUID(), accountId: member.accountId, expectedRevision: 1, respond: true }), /policy/);
    const before = Number(db.prepare('SELECT count(*) AS n FROM invitations').get()!.n);
    db.exec("CREATE TRIGGER fail_mail BEFORE INSERT ON mail_outbox BEGIN SELECT RAISE(ABORT,'synthetic mail fault'); END");
    assert.throws(() => f.create([]), /synthetic mail fault/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM invitations').get()!.n, before); db.exec('DROP TRIGGER fail_mail');
    const pending = f.create([]); access.revokeInvitation(owner, pending.command.requestId, { requestId: randomUUID(), expectedRevision: 1 });
    await assert.rejects(access.acceptInvitation(member, pending.command.requestId, pending.accept), /Resource/);
  } finally { db.close(); }
});
