import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { decryptMail } from './test-support/mail-fixture.ts';
import { ProtocolError } from './shared/protocol.ts';

import { createClerkClient } from '@clerk/backend';
import { canonicalHttp } from './test-support/canonical-http.ts';

async function fixture() {
  const f = canonicalHttp('minarbot-project-access-');
  const { db, owner } = f;
  const project = randomUUID(), agent = randomUUID(), secondAgent = randomUUID(), home = randomUUID(), installation = randomUUID();
  const member = f.addAccount('user_member'), stranger = f.addAccount('user_stranger');
  db.prepare("INSERT INTO projects VALUES (?,?,?,0,0,1)").run(project, owner.accountId, 'Fixture');
  db.prepare("INSERT INTO project_members VALUES (?,?,'owner',1,0)").run(project, owner.accountId);
  db.prepare("INSERT INTO installations VALUES (?,?,'fixture',?,1,0,1,0)").run(installation, owner.accountId, installation);
  db.prepare(`INSERT INTO devices VALUES (?,?,?,'fixture','fixture',?,?,'{}',1,0,'offline','UTC',1,NULL,'["execution"]',1)`).run(home, installation, owner.accountId, home, home);
  for (const id of [agent, secondAgent]) {
    db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES (?,'Fixture','fixture','Help')").run(id);
    db.prepare(`INSERT INTO agent_projects VALUES (?,?,'','{"v":1,"tools":[],"resources":[]}',1,0)`).run(project, id);
    db.prepare("INSERT INTO agent_authority VALUES (?,?,?,NULL,1)").run(id, owner.accountId, home);
    db.prepare("INSERT INTO record_scopes VALUES ('agents',?,?,?,'project','agent',?)").run(JSON.stringify([id]), owner.accountId, project, id);
  }
  let mailbox = 'member@example.com';
  const clerk = createClerkClient({ ...f.auth, telemetry: { disabled: true } });
  clerk.users.getUser = async subject => ({ id: subject, banned: false, locked: false, emailAddresses: [{ emailAddress: mailbox, verification: { status: 'verified' } }] }) as Awaited<ReturnType<typeof clerk.users.getUser>>;
  const mail = { from: 'Minarbot <noreply@example.com>', origin: 'https://minarbot.example', keyId: randomUUID(), key: randomBytes(32), lookupKey: randomBytes(32) };
  const path = `/api/projects/${project}`;
  const access = {
    createInvitation: (body: Record<string, unknown>) => f.request(path + '/invitations', 'POST', body),
    acceptInvitation: (actor: typeof owner, id: string, body: Record<string, unknown>) => f.request(`/api/invitations/${id}/accept`, 'POST', body, actor),
    revokeInvitation: (id: string, body: Record<string, unknown>) => f.request(`/api/invitations/${id}/revoke`, 'POST', body),
    requireProjectMember: (actor: typeof owner) => f.request(path, 'GET', undefined, actor),
    setResponsePolicy: (id: string, body: Record<string, unknown>) => f.request(path + '/agents/' + id + '/response-policy', 'PUT', body),
    editMember: (body: Record<string, unknown>) => f.request(path + '/members/' + member.accountId, 'PATCH', body),
  };
  const assignment = (agentId: string = agent) => ({ agentId, expectedAgentRevision: 1, expectedParticipationRevision: 1 });
  const readInvitationMail = (invitationId: string) => {
    const invitation = db.prepare('SELECT authority_generation,email_hash FROM invitations WHERE id=?').get(invitationId)!;
    const outbox = db.prepare('SELECT ciphertext FROM mail_outbox WHERE id=?').get(invitationId)!;
    return decryptMail(invitationId, 1, String(invitation.authority_generation), String(invitation.email_hash), outbox.ciphertext as Uint8Array, mail.key).payload;
  };
  const create = async (agents: ReturnType<typeof assignment>[] = [assignment()]) => {
    const command = { requestId: randomUUID(), email: 'MEMBER@Example.com', agentAssignments: agents, expiresAt: Date.now() + 60000, expectedProjectRevision: 1 };
    const result = await access.createInvitation(command);
    const proof = readInvitationMail(command.requestId).text.match(/#([A-Za-z0-9_-]{43})/)![1];
    return { command, result, accept: { requestId: randomUUID(), mailboxProof: proof, expectedRevision: 1 } };
  };
  try {
    await f.start({ clerk, mail: () => mail, mailFrom: mail.from, mailOrigin: mail.origin });
    return { ...f, member, stranger, access, project, agent, secondAgent, assignment, create, readInvitationMail, mailbox: (value: string) => { mailbox = value; } };
  } catch (error) { await f.close(); throw error; }
}
const code = (value: string) => (error: unknown) => error instanceof ProtocolError && error.code === value;

test('closed invitation/member/policy parsers normalize flags and reject obsolete authority', async () => {
  const f = await fixture();
  const { access, db, agent, member } = f;
  try {
    const input = { requestId: randomUUID(), email: 'User@Example.COM', expiresAt: Date.now() + 60000, expectedProjectRevision: 1, agentAssignments: [f.assignment(agent.toUpperCase())] };
    await assert.rejects(() => access.createInvitation({ ...input, agentAssignments: [...input.agentAssignments, ...input.agentAssignments] }), /Duplicate/);
    for (const change of [{ expectedProjectRevision: 0 }, { role: 'owner' }, { agentAssignments: [{ ...input.agentAssignments[0], respond: 'false' }] }]) await assert.rejects(() => access.createInvitation({ ...input, ...change }));
    await assert.rejects(() => access.editMember({ requestId: randomUUID(), expectedRevision: 1, deleted: true, agentAssignments: [] }));
    await assert.rejects(() => access.editMember({ requestId: randomUUID(), expectedRevision: 1, agents: [] }));
    await assert.rejects(() => access.setResponsePolicy(agent, { requestId: randomUUID(), accountId: member.accountId, expectedRevision: 1, respond: 0 }));
    await access.createInvitation(input);
    assert.equal(f.readInvitationMail(input.requestId).to, 'user@example.com');
    const stored = db.prepare('SELECT assignments_json AS assignment FROM invitations WHERE id=?').get(input.requestId);
    assert(stored);
    assert.deepEqual(JSON.parse(String(stored.assignment)).agents, [{ agentId: agent, agentRevision: 1, participationRevision: 1, enabled: true, respond: true }]);
  } finally { await f.close(); }
});

test('accept consumes once; exact retry preserves later policy changes and revoked access stays denied', async () => {
  const f = await fixture(); const { db, access, member, stranger, agent } = f;
  try {
    const invite = await f.create(); assert.equal((await access.createInvitation(invite.command)).status, 200);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, { ...invite.accept, mailboxProof: randomBytes(32).toString('base64url') }), /Resource/);
    f.mailbox('wrong@example.com'); await assert.rejects(access.acceptInvitation(member, invite.command.requestId, invite.accept), /Resource/); f.mailbox('member@example.com');
    const accepted = await access.acceptInvitation(member, invite.command.requestId, invite.accept); assert.equal(accepted.data.grantRevision, 1);
    const assignment = () => db.prepare('SELECT enabled,revision FROM collaborator_agents WHERE agent=?').get(agent);
    const policy = () => db.prepare('SELECT respond FROM response_policies WHERE agent=?').get(agent)?.respond;
    assert.equal(assignment()?.enabled, 1); assert.equal(policy(), 1);
    const toggle = { requestId: randomUUID(), accountId: member.accountId, expectedRevision: 1, respond: false };
    await access.setResponsePolicy(agent, toggle); assert.equal(policy(), 0); assert.equal(assignment()?.enabled, 1);
    assert.deepEqual((await access.acceptInvitation(member, invite.command.requestId, invite.accept)).data, accepted.data); assert.equal(policy(), 0);
    assert.equal(db.prepare('SELECT revision FROM collaborator_agents').get()!.revision, 1);
    assert.equal((await access.setResponsePolicy(agent, toggle)).status, 200);
    await assert.rejects(() => access.setResponsePolicy(agent, { ...toggle, requestId: randomUUID() }), /revision/);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, { ...invite.accept, requestId: randomUUID() }), /used/);
    const revoke = { requestId: randomUUID(), expectedRevision: 1, deleted: true };
    await access.editMember(revoke);
    await assert.rejects(() => access.requireProjectMember(member), /Resource/); await assert.rejects(() => access.requireProjectMember(stranger), /Resource/);
    await assert.rejects(access.acceptInvitation(member, invite.command.requestId, invite.accept), /Resource/);
    assert.equal((await access.editMember(revoke)).status, 200);
    assert.equal(db.prepare('SELECT length(ciphertext) AS n FROM mail_outbox').get()!.n, 0);
  } finally { await f.close(); }
});

test('invitation CAS, rollback, tombstone rejoin, missing policy and revoke ordering', async () => {
  const f = await fixture(); const { db, access, member, agent, secondAgent } = f;
  try {
    const first = await f.create([f.assignment(), f.assignment(secondAgent)]); await access.acceptInvitation(member, first.command.requestId, first.accept);
    await access.editMember({ requestId: randomUUID(), expectedRevision: 1, deleted: true });
    const rejoin = await f.create([f.assignment(secondAgent)]); await access.acceptInvitation(member, rejoin.command.requestId, rejoin.accept);
    assert.equal(db.prepare('SELECT grant_revision FROM project_members WHERE account=?').get(member.accountId)!.grant_revision, 3);
    assert.deepEqual({ ...db.prepare('SELECT enabled,revision FROM collaborator_agents WHERE agent=?').get(agent) }, { enabled: 0, revision: 3 });
    assert.equal(db.prepare('SELECT respond FROM response_policies WHERE agent=?').get(agent)!.respond, 0);
    assert.equal(db.prepare('SELECT enabled FROM collaborator_agents WHERE agent=?').get(secondAgent)!.enabled, 1);
    db.prepare('DELETE FROM response_policies WHERE agent=?').run(agent);
    await assert.rejects(() => access.setResponsePolicy(agent, { requestId: randomUUID(), accountId: member.accountId, expectedRevision: 1, respond: true }), /policy/);
    const before = Number(db.prepare('SELECT count(*) AS n FROM invitations').get()!.n);
    db.exec("CREATE TRIGGER fail_mail BEFORE INSERT ON mail_outbox BEGIN SELECT RAISE(ABORT,'synthetic mail fault'); END");
    await assert.rejects(() => f.create([]), code('storage_failed'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM invitations').get()!.n, before); db.exec('DROP TRIGGER fail_mail');
    const pending = await f.create([]); await access.revokeInvitation(pending.command.requestId, { requestId: randomUUID(), expectedRevision: 1 });
    await assert.rejects(access.acceptInvitation(member, pending.command.requestId, pending.accept), /Resource/);
  } finally { await f.close(); }
});
