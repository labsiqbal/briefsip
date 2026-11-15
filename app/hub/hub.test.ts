import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { canonicalJson, ProtocolError, sha256 } from '../protocol.ts';
import { activateRestoredHub, backupHub, fenceRestoredHub, initializeHubSchema, openHubDatabase, transaction } from './schema.ts';
import { createHubAuthority, parsePolicy, PERMISSIONS, slug, type IdentityVerifier, type InvocationPolicy, type ParticipationPolicy, type ProjectContext, type VerifiedIdentity } from './project-authority.ts';
import { createHubRouting, type RoutingFrame } from './routing.ts';

const key = Buffer.alloc(32, 7);
const identity = (subject: string): VerifiedIdentity => ({ issuer: 'https://identity.example', subject, verifiedMailboxes: [`${subject}@example.com`] });
const signingPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const encryptionPublicKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
function code(work: () => unknown, expected: string) { assert.throws(work, e => e instanceof ProtocolError && e.code === expected); }
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); initializeHubSchema(db); t.after(() => db.close());
  let clock = 1_800_000_000_000;
  const a = createHubAuthority(db, { domain: 'briefsip.test', mailboxKey: key, now: () => clock });
  const r = createHubRouting(a);
  const ids = Object.fromEntries(['alice','bob','carol','dave','eve'].map(s => [s, a.provisionAccount(identity(s), true)]));
  const alpha = a.createProject(ids.alice, 'alpha', 'Alpha'), beta = a.createProject(ids.bob, 'beta', 'Beta');
  const ctx = (who: string, project = alpha) => a.resolveProject(project.host, ids[who], project.projectId);
  function join(who: string, role: 'admin' | 'member' | 'viewer' = 'member', project = alpha) {
    const owner = project.projectId === alpha.projectId ? 'alice' : 'bob';
    const invite = a.invite(ctx(owner, project), { mailbox: `${who}@example.com`, role, expiresAt: clock + 10_000 });
    a.acceptInvite(ctx(who, project), invite.invitationId, invite.token, identity(who));
  }
  function node(who: string) {
    const nodeId = a.registerNode(ids[who], { id: randomUUID(), installationId: randomUUID(), signingPublicKey, encryptionPublicKey, capabilities: ['chat'] });
    const agentId = a.registerAgent(ids[who], nodeId, randomUUID(), `${who}'s agent`);
    const principal = a.connectNode(ids[who], nodeId, 1); return { nodeId, agentId, principal };
  }
  function participate(who: string, n: ReturnType<typeof node>, invocation: InvocationPolicy = { mode: 'owner' }, project = alpha, sections = [project.sectionId]) {
    const policy: ParticipationPolicy = { sectionIds: sections, invocation, scopes: ['read','invoke'], localPolicyDigest: sha256('local policy'), payerBindingRef: 'node-local-payer', maxCostMicros: 1_000_000 };
    const p = a.propose(ctx(who, project), n.agentId, policy);
    const owner = project.projectId === alpha.projectId ? 'alice' : 'bob';
    a.consent(ctx(owner, project), p.participationId, p.revision, p.policyDigest, 'project');
    a.consent(ctx(who, project), p.participationId, p.revision, p.policyDigest, 'owner', n.principal);
    return { ...p, policy };
  }
  const post = (who: string, participationId: string, project = alpha, requestId = randomUUID()) => r.post(ctx(who, project), { requestId, sectionId: project.sectionId, text: 'Hello', mentions: [participationId] });
  return { db, a, r, ids, alpha, beta, ctx, join, node, participate, post, tick: (ms: number) => { clock += ms; } };
}
function request(f: ReturnType<typeof fixture>, n: ReturnType<ReturnType<typeof fixture>['node']>) {
  const frame = f.r.pending(n.principal).find(v => v.kind === 'turn.request'); assert(frame && 'fence' in frame); return frame;
}
function result(request: RoutingFrame, kind: RoutingFrame['kind'], sequence: number, payload: Record<string, unknown>): RoutingFrame {
  return { ...request, kind, eventId: randomUUID(), sequence, payload, payloadDigest: sha256(canonicalJson(payload)) };
}

test('four roles enforce complete permission matrix; admins cannot appoint/remove peers or owner', t => {
  const f = fixture(t); f.join('bob','admin'); f.join('carol'); f.join('dave','viewer');
  const roles = { alice: 'owner', bob: 'admin', carol: 'member', dave: 'viewer' };
  for (const [who, role] of Object.entries(roles)) for (const [action, permitted] of Object.entries(PERMISSIONS)) {
    if ((permitted as string[]).includes(role)) assert.equal(f.a.member(f.ctx(who), action as keyof typeof PERMISSIONS).role, role);
    else code(() => f.a.member(f.ctx(who), action as keyof typeof PERMISSIONS), 'authority_denied');
  }
  code(() => f.a.invite(f.ctx('bob'), { mailbox: 'eve@example.com', role: 'admin', expiresAt: f.a.now() + 1000 }), 'authority_denied');
  code(() => f.a.editMember(f.ctx('bob'), f.ids.alice, 1, 'revoked'), 'authority_denied');
  code(() => f.a.editMember(f.ctx('bob'), f.ids.bob, 1, 'member'), 'authority_denied');
  code(() => f.a.editMember(f.ctx('bob'), f.ids.carol, 1, 'admin'), 'authority_denied');
  code(() => f.r.post(f.ctx('dave'), { requestId: randomUUID(), sectionId: f.alpha.sectionId, text: 'No', mentions: [] }), 'authority_denied');
  code(() => f.a.member(f.ctx('eve')), 'resource_not_found');
  f.a.editMember(f.ctx('bob'), f.ids.carol, 1, 'viewer');
  assert.equal(f.a.member(f.ctx('carol')).role, 'viewer');
});

test('UUID/slug binding is immutable, exact, reserved and tombstoned; cross-project section IDs fail', t => {
  const f = fixture(t); f.join('bob');
  assert.match(f.alpha.projectId, /^[0-9a-f-]{36}$/); assert(Object.isFrozen(f.ctx('alice')));
  for (const value of ['accounts','api','www','admin','status','assets','UPPER','a','-alpha','alpha-','alpha.beta','alpha:443','équipe']) code(() => slug(value), 'invalid_slug');
  for (const host of ['ALPHA.briefsip.test','alpha.briefsip.test:443','alpha.briefsip.test.','unknown.briefsip.test','alpha.briefsip.test@evil.test']) code(() => f.a.resolveProject(host, f.ids.alice), 'resource_not_found');
  code(() => f.a.resolveProject(f.alpha.host, f.ids.bob, f.beta.projectId), 'resource_not_found');
  code(() => f.a.section(f.ctx('bob'), f.beta.sectionId), 'resource_not_found');
  assert.throws(() => f.db.prepare("UPDATE projects SET slug='changed' WHERE id=?").run(f.alpha.projectId), /immutable/);
  assert.throws(() => f.db.prepare('UPDATE sections SET project_id=? WHERE id=?').run(f.beta.projectId, f.alpha.sectionId), /immutable/);
  f.a.deleteProject(f.ctx('alice'));
  code(() => f.a.resolveProject(f.alpha.host, f.ids.alice), 'resource_not_found');
  code(() => f.a.createProject(f.ids.bob, 'alpha', 'Recycled'), 'slug_unavailable');
  assert.throws(() => f.db.prepare('DELETE FROM projects WHERE id=?').run(f.alpha.projectId), /tombstoned/);
});

test('identity verifier is pluggable, mailbox is not identity, pilot admission is explicit', async t => {
  const f = fixture(t);
  const verifier: IdentityVerifier = { async verify(token) { if (token !== 'stub:alice') throw new Error('invalid proof'); return identity('alice'); } };
  assert.equal((await f.a.authenticate(verifier, 'stub:alice')).accountId, f.ids.alice);
  assert.equal(f.a.provisionAccount({ ...identity('alice'), verifiedMailboxes: ['new@example.com'] }, false), f.ids.alice);
  await assert.rejects(f.a.authenticate(verifier, 'forged'), /invalid proof/);
  const unadmitted = f.a.provisionAccount(identity('unadmitted'), false);
  code(() => f.a.createProject(unadmitted, 'private', 'No'), 'account_unavailable');
  const unknown: IdentityVerifier = { async verify() { return identity('unknown'); } };
  await assert.rejects(f.a.authenticate(unknown, 'stub'), e => e instanceof ProtocolError && e.code === 'account_unavailable');
  assert.throws(() => createHubAuthority(f.db, { domain: 'briefsip.test', mailboxKey: new Uint8Array(1) }));
});

test('invites bind mailbox/account/project, store hashes, expire within 24h and consume exactly once', t => {
  const f = fixture(t), i = f.a.invite(f.ctx('alice'), { mailbox: 'BOB@example.com', role: 'member', expiresAt: f.a.now() + 1000, targetAccountId: f.ids.bob });
  const row = f.a.one('SELECT * FROM invitations WHERE id=?', i.invitationId)!;
  assert.notEqual(row.token_digest, i.token); assert.notEqual(row.mailbox_digest, 'bob@example.com');
  code(() => f.a.acceptInvite(f.ctx('eve'), i.invitationId, i.token, identity('eve')), 'authority_denied');
  code(() => f.a.acceptInvite(f.ctx('eve'), i.invitationId, i.token, { ...identity('eve'), verifiedMailboxes: ['bob@example.com'] }), 'authority_denied');
  code(() => f.a.acceptInvite(f.ctx('bob'), i.invitationId, i.token, identity('alice')), 'authority_denied');
  code(() => f.a.acceptInvite(f.ctx('bob', f.beta), i.invitationId, i.token, identity('bob')), 'resource_not_found');
  code(() => f.a.acceptInvite(f.ctx('bob'), i.invitationId, 'wrong', identity('bob')), 'resource_not_found');
  assert.equal(f.a.acceptInvite(f.ctx('bob'), i.invitationId, i.token, identity('bob')).role, 'member');
  code(() => f.a.acceptInvite(f.ctx('bob'), i.invitationId, i.token, identity('bob')), 'invitation_unavailable');
  code(() => f.a.invite(f.ctx('alice'), { mailbox: 'eve@example.com', role: 'member', expiresAt: f.a.now() + 86_400_001 }), 'invalid_expiry');
  const e = f.a.invite(f.ctx('alice'), { mailbox: 'eve@example.com', role: 'member', expiresAt: f.a.now() + 100 }); f.tick(100);
  code(() => f.a.acceptInvite(f.ctx('eve'), e.invitationId, e.token, identity('eve')), 'invitation_unavailable');
});

test('revoked invites and invites issued by removed/demoted admins cannot grant membership', t => {
  const f = fixture(t); f.join('bob','admin');
  const i = f.a.invite(f.ctx('bob'), { mailbox: 'eve@example.com', role: 'viewer', expiresAt: f.a.now() + 1000 });
  f.a.revokeInvite(f.ctx('alice'), i.invitationId);
  code(() => f.a.acceptInvite(f.ctx('eve'), i.invitationId, i.token, identity('eve')), 'invitation_unavailable');
  const j = f.a.invite(f.ctx('bob'), { mailbox: 'carol@example.com', role: 'member', expiresAt: f.a.now() + 1000 });
  f.a.editMember(f.ctx('alice'), f.ids.bob, 1, 'member');
  code(() => f.a.acceptInvite(f.ctx('carol'), j.invitationId, j.token, identity('carol')), 'authority_denied');
});

test('ownership transfer preserves exactly one active owner transactionally', t => {
  const f = fixture(t); f.join('bob'); f.join('dave','viewer');
  code(() => f.a.transferOwner(f.ctx('alice'), f.ids.dave), 'authority_denied');
  f.a.transferOwner(f.ctx('alice'), f.ids.bob);
  assert.equal(f.a.member(f.ctx('bob')).role, 'owner'); assert.equal(f.a.member(f.ctx('alice')).role, 'admin');
  assert.equal(f.a.one("SELECT count(*) AS n FROM memberships WHERE project_id=? AND role='owner' AND status='active'", f.alpha.projectId)!.n, 1);
  assert.throws(() => transaction(f.db, () => f.db.prepare("UPDATE memberships SET role='admin' WHERE project_id=? AND account_id=?").run(f.alpha.projectId, f.ids.bob)), /FOREIGN KEY/);
  assert.equal(f.a.member(f.ctx('bob')).role, 'owner');
});

test('account-owned fixed-home node/agent IDs cannot be adopted by a project owner', t => {
  const f = fixture(t), n = f.node('bob');
  code(() => f.a.connectNode(f.ids.alice, n.nodeId, 1), 'resource_not_found');
  code(() => f.a.registerAgent(f.ids.alice, n.nodeId, randomUUID(), 'Stolen'), 'resource_not_found');
  code(() => f.a.revokeNode(f.ids.alice, n.nodeId), 'resource_not_found');
  code(() => f.a.propose(f.ctx('alice'), n.agentId, { sectionIds: [f.alpha.sectionId], invocation: { mode: 'owner' }, scopes: ['read'], localPolicyDigest: sha256('x'), payerBindingRef: 'payer', maxCostMicros: 0 }), 'resource_not_found');
  assert.throws(() => f.db.prepare('UPDATE agents SET owner_account_id=? WHERE id=?').run(f.ids.alice, n.agentId), /immutable/);
  assert.throws(() => f.db.prepare('UPDATE agents SET home_node_id=? WHERE id=?').run(randomUUID(), n.agentId), /immutable/);
  assert.throws(() => f.db.prepare('UPDATE nodes SET owner_account_id=? WHERE id=?').run(f.ids.alice, n.nodeId), /immutable/);
});

test('dual consent binds exact proposal and authenticated owner node; project approval cannot forge it', t => {
  const f = fixture(t); f.join('bob'); const n = f.node('bob'), other = f.node('alice');
  const policy: ParticipationPolicy = { sectionIds: [f.alpha.sectionId], invocation: { mode: 'owner' }, scopes: ['read','invoke'], localPolicyDigest: sha256('policy'), payerBindingRef: 'payer', maxCostMicros: 0 };
  const p = f.a.propose(f.ctx('bob'), n.agentId, policy);
  code(() => f.post('bob', p.participationId), 'authority_denied');
  f.a.consent(f.ctx('alice'), p.participationId, p.revision, p.policyDigest, 'project');
  code(() => f.post('bob', p.participationId), 'authority_denied');
  code(() => f.a.consent(f.ctx('alice'), p.participationId, p.revision, p.policyDigest, 'owner', other.principal), 'authority_denied');
  code(() => f.a.consent(f.ctx('bob'), p.participationId, p.revision, p.policyDigest, 'owner'), 'authority_denied');
  code(() => f.a.consent(f.ctx('bob'), p.participationId, p.revision, sha256('changed'), 'owner', n.principal), 'stale_revision');
  f.a.consent(f.ctx('bob'), p.participationId, p.revision, p.policyDigest, 'owner', n.principal);
  assert.equal(f.post('bob', p.participationId).turnIds.length, 1);
  const wider = f.a.propose(f.ctx('bob'), n.agentId, { ...policy, invocation: { mode: 'all-members' } });
  assert(wider.revision > p.revision);
  code(() => f.post('alice', p.participationId), 'authority_denied');
  code(() => f.a.consent(f.ctx('bob'), p.participationId, p.revision, p.policyDigest, 'owner', n.principal), 'stale_revision');
});

test('owner-only invocation is default; specific members/all-members never give viewers spending rights', t => {
  const f = fixture(t); f.join('bob'); f.join('carol'); f.join('dave','viewer'); const n = f.node('bob');
  const p = f.participate('bob', n);
  const { invocation: _invocation, ...withoutInvocation } = p.policy;
  assert.deepEqual(parsePolicy(withoutInvocation).invocation, { mode: 'owner' });
  assert.equal(f.post('bob', p.participationId).turnIds.length, 1);
  code(() => f.post('alice', p.participationId), 'authority_denied');
  code(() => f.post('carol', p.participationId), 'authority_denied');
  const specific = f.participate('bob', n, { mode: 'members', accountIds: [f.ids.carol] });
  assert.equal(f.post('carol', specific.participationId).turnIds.length, 1);
  code(() => f.post('alice', specific.participationId), 'authority_denied');
  const everyone = f.participate('bob', n, { mode: 'all-members' });
  assert.equal(f.post('alice', everyone.participationId).turnIds.length, 1);
  code(() => f.post('dave', everyone.participationId), 'authority_denied');
});

test('section events route only to active participants, mentions carry independent requester/payer attribution', t => {
  const f = fixture(t); f.join('bob'); const alice = f.node('alice'), bob = f.node('bob'), foreign = f.node('eve');
  const pa = f.participate('alice', alice), pb = f.participate('bob', bob, { mode: 'all-members' });
  f.participate('bob', bob, { mode: 'all-members' }, f.beta);
  const extra = f.a.createSection(f.ctx('alice'), 'private future work');
  const onlyExtra = f.node('alice'); f.participate('alice', onlyExtra, { mode: 'owner' }, f.alpha, [extra]);
  f.post('alice', pb.participationId);
  assert.equal(f.r.pending(alice.principal).filter(v => v.kind === 'section.event').length, 1);
  assert.equal(f.r.pending(bob.principal).filter(v => v.kind === 'section.event').length, 1);
  assert.equal(f.r.pending(foreign.principal).length, 0); assert.equal(f.r.pending(onlyExtra.principal).length, 0);
  const req = request(f, bob);
  assert.equal(req.projectId, f.alpha.projectId); assert.equal(req.requesterAccountId, f.ids.alice); assert.equal(req.payerAccountId, f.ids.bob);
  assert.equal(req.payerBindingRef, 'node-local-payer'); assert.notEqual(req.participationId, pa.participationId);
  assert.equal(f.r.grants(bob.principal).length, 2);
});

test('foreign participation, section, turn, receipts and forged host contexts never cross projects', t => {
  const f = fixture(t); f.join('bob'); const n = f.node('bob'), p = f.participate('bob', n), b = f.participate('bob', n, { mode: 'owner' }, f.beta);
  code(() => f.post('bob', b.participationId), 'resource_not_found');
  code(() => f.r.post(f.ctx('bob'), { requestId: randomUUID(), sectionId: f.beta.sectionId, text: 'No', mentions: [] }), 'resource_not_found');
  const posted = f.post('bob', p.participationId);
  code(() => f.r.turn(f.ctx('bob', f.beta), posted.turnIds[0]), 'resource_not_found');
  code(() => f.r.history(f.ctx('bob', f.beta), f.alpha.sectionId), 'resource_not_found');
  const forged: ProjectContext = { ...f.ctx('bob'), projectId: f.beta.projectId };
  code(() => f.a.member(forged), 'resource_not_found');
  assert.throws(() => f.db.prepare('INSERT INTO participation_sections VALUES(?,?,?)').run(f.alpha.projectId, p.participationId, f.beta.sectionId), /FOREIGN KEY/);
});

test('posting idempotency survives retries and conflicts; receipts scope by project and requester', t => {
  const f = fixture(t); f.join('bob'); const n = f.node('bob'), p = f.participate('bob', n, { mode: 'all-members' });
  const id = randomUUID(), first = f.post('bob', p.participationId, f.alpha, id), pending = f.r.pending(n.principal).length;
  assert.deepEqual(f.post('bob', p.participationId, f.alpha, id), first); assert.equal(f.r.pending(n.principal).length, pending);
  code(() => f.r.post(f.ctx('bob'), { requestId: id, sectionId: f.alpha.sectionId, text: 'Changed', mentions: [p.participationId] }), 'idempotency_conflict');
  assert.notEqual(f.post('alice', p.participationId, f.alpha, id).messageId, first.messageId);
  assert.notEqual(f.r.post(f.ctx('bob',f.beta), { requestId: id, sectionId: f.beta.sectionId, text: 'Hello', mentions: [] }).messageId, first.messageId);
});

test('ordered node admission/results use durable receipts, reject spoofing/digest/sequence conflicts', t => {
  const f = fixture(t); f.join('bob'); const n = f.node('bob'), rogue = f.node('alice'), p = f.participate('bob', n); f.post('bob', p.participationId);
  const req = request(f, n), admitted = result(req, 'turn.admitted', 1, {});
  code(() => f.r.accept(rogue.principal, { ...admitted, nodeId: rogue.nodeId }), 'resource_not_found');
  code(() => f.r.accept(n.principal, { ...admitted, sectionId: f.beta.sectionId }), 'authority_denied');
  code(() => f.r.accept(n.principal, result(req,'turn.final',1,{ text: 'Premature' })), 'authority_denied');
  assert.equal(f.r.accept(n.principal, admitted).duplicate, false);
  assert.equal(f.r.accept(n.principal, admitted).duplicate, true);
  code(() => f.r.accept(n.principal, { ...admitted, eventId: randomUUID() }), 'idempotency_conflict');
  const partial = result(req, 'turn.partial', 2, { text: 'Answer' });
  code(() => f.r.accept(n.principal, { ...partial, payloadDigest: sha256('wrong') }), 'digest_mismatch');
  code(() => f.r.accept(n.principal, { ...partial, sequence: 3 }), 'stale_revision');
  assert.equal(f.r.accept(n.principal, partial).sequence, 2);
  const final = result(req,'turn.final',3,{ text: 'Answer complete' }); f.r.accept(n.principal, final);
  f.r.pending(n.principal); // Terminal delivery cleanup cannot erase immutable admission provenance.
  assert.equal(f.r.accept(n.principal, final).duplicate, true);
  assert.throws(() => f.db.prepare('UPDATE turns SET payer_account_id=? WHERE id=?').run(f.ids.alice,req.turnId!), /immutable/);
  assert.equal(f.r.turn(f.ctx('bob'), req.turnId!).state, 'done');
  assert.equal(f.r.history(f.ctx('alice'), f.alpha.sectionId).results.length, 3);
  code(() => f.r.accept(n.principal, result(req,'turn.partial',4,{ text: 'Late' })), 'stale_revision');
});

test('per-effect lease binds action digest/current grant for 5s; receipt cannot invent local approval', t => {
  const f = fixture(t), n = f.node('alice'), p = f.participate('alice',n); f.post('alice',p.participationId);
  const req = request(f,n), command = { projectId: req.projectId, turnId: req.turnId!, actionId: randomUUID(), actionDigest: sha256('effect'), fence: req.fence };
  code(() => f.r.lease(n.principal, command), 'authority_denied');
  f.r.accept(n.principal,result(req,'turn.admitted',1,{}));
  const lease = f.r.lease(n.principal,command); assert.equal(lease.expiresAt,f.a.now()+5000);
  assert.deepEqual(f.r.lease(n.principal,command),lease);
  code(() => f.r.lease(n.principal,{...command,actionDigest:sha256('changed')}),'idempotency_conflict');
  const receipt = { actionId: command.actionId, actionDigest: command.actionDigest, leaseId: lease.leaseId, outcome: 'succeeded' };
  code(() => f.r.accept(n.principal,result(req,'turn.effect.receipt',2,{...receipt,leaseId:randomUUID()})),'authority_denied');
  f.r.accept(n.principal,result(req,'turn.effect.receipt',2,receipt));
  f.tick(5000); code(() => f.r.lease(n.principal,command),'stale_revision');
  f.a.withdraw(f.ctx('alice'),p.participationId);
  code(() => f.r.lease(n.principal,{...command,actionId:randomUUID()}),'authority_denied');
});

test('member revocation fences queued delivery, future effects and late results; beta stays active', t => {
  const f = fixture(t); f.join('bob'); const n = f.node('bob'), p = f.participate('bob',n,{mode:'all-members'}), b = f.participate('bob',n,{mode:'owner'},f.beta);
  f.post('alice',p.participationId); const req = request(f,n); f.r.accept(n.principal,result(req,'turn.admitted',1,{}));
  f.a.editMember(f.ctx('alice'),f.ids.bob,1,'revoked');
  assert.equal(f.r.turn(f.ctx('alice'), req.turnId!).state, 'unknown');
  code(() => f.r.accept(n.principal,result(req,'turn.final',2,{text:'Late'})),'authority_denied');
  code(() => f.post('alice',p.participationId),'authority_denied');
  const pending = f.r.pending(n.principal); assert(pending.some(v=>v.kind==='grant.revoked')); assert(pending.some(v=>v.kind==='turn.cancel'));
  assert(!pending.some(v=>v.kind==='turn.request' || v.kind==='section.event'));
  assert.equal(f.post('bob',b.participationId,f.beta).turnIds.length,1);
  f.join('bob'); code(() => f.post('bob',p.participationId),'authority_denied');
});

test('requester removal revokes their turns without revoking agent owner participation', t => {
  const f = fixture(t); f.join('bob'); f.join('carol'); const n=f.node('bob'),p=f.participate('bob',n,{mode:'all-members'});
  f.post('carol',p.participationId); const req=request(f,n);
  f.a.editMember(f.ctx('alice'),f.ids.carol,1,'revoked');
  assert.equal(f.r.turn(f.ctx('alice'),req.turnId!).state,'revoked');
  assert.equal(f.post('bob',p.participationId).turnIds.length,1);
});

test('viewer demotion, section archive, node revocation and account block stop authority immediately', t => {
  const f = fixture(t); f.join('bob'); const n=f.node('bob'),p=f.participate('bob',n);
  f.a.editMember(f.ctx('alice'),f.ids.bob,1,'viewer'); code(()=>f.post('bob',p.participationId),'authority_denied');
  code(()=>f.a.propose(f.ctx('bob'),n.agentId,p.policy),'authority_denied'); f.a.withdraw(f.ctx('bob'),p.participationId);
  const own=f.node('alice'),ownP=f.participate('alice',own); f.post('alice',ownP.participationId);
  f.a.archiveSection(f.ctx('alice'),f.alpha.sectionId,1); assert(!f.r.pending(own.principal).some(v=>v.kind==='turn.request'));
  f.a.revokeNode(f.ids.alice,own.nodeId); code(()=>f.r.pending(own.principal),'resource_not_found');
  f.a.setAccountStatus(f.ids.bob,'blocked'); code(()=>f.a.member(f.ctx('bob',f.beta)),'account_unavailable');
  f.a.setAccountStatus(f.ids.bob,'active'); assert.equal(f.a.member(f.ctx('bob',f.beta)).role,'owner');
  code(()=>f.r.pending(n.principal),'stale_revision');
});

test('offline mentions fail atomically; disconnect/reconnect fences old connection and marks uncertain', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n); f.post('alice',p.participationId); const req=request(f,n);
  f.r.accept(n.principal,result(req,'turn.admitted',1,{})); f.a.disconnectNode(n.principal);
  const before=f.a.one('SELECT count(*) AS n FROM messages')!.n;
  code(()=>f.post('alice',p.participationId),'node_offline'); assert.equal(f.a.one('SELECT count(*) AS n FROM messages')!.n,before);
  assert.equal(f.r.turn(f.ctx('alice'),req.turnId!).state,'unknown');
  const fresh=f.a.connectNode(f.ids.alice,n.nodeId,1); code(()=>f.r.pending(n.principal),'stale_revision');
  assert.equal(f.r.pending(fresh).length,0); code(()=>f.r.accept(fresh,result(req,'turn.final',2,{text:'Old connection'})),'stale_revision');
  assert.equal(f.r.grants(fresh).length,1);
});

test('outbox ACK binds node/event/digest; revocation rechecks every delivery and receipt lookup', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n); const id=randomUUID(); f.post('alice',p.participationId,f.alpha,id);
  const req=request(f,n); code(()=>f.r.acknowledge(n.principal,req.eventId,sha256('wrong')),'idempotency_conflict');
  f.r.acknowledge(n.principal,req.eventId,sha256(canonicalJson(req))); assert(!f.r.pending(n.principal).some(v=>v.eventId===req.eventId));
  f.a.withdraw(f.ctx('alice'),p.participationId); code(()=>f.post('alice',p.participationId,f.alpha,id),'authority_denied');
  code(()=>f.r.acknowledge(n.principal,req.eventId,sha256(canonicalJson(req))),'resource_not_found');
});

test('invalid policy, foreign section/requester, key, unknown fields and oversized result fail closed', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n);
  code(()=>f.a.propose(f.ctx('alice'),n.agentId,{...p.policy,sectionIds:[f.beta.sectionId]}),'resource_not_found');
  code(()=>f.a.propose(f.ctx('alice'),n.agentId,{...p.policy,invocation:{mode:'members',accountIds:[f.ids.eve]}}),'authority_denied');
  code(()=>f.a.propose(f.ctx('alice'),n.agentId,{...p.policy,payerBindingRef:'/home/secret'}),'invalid_policy');
  assert.throws(()=>f.a.registerNode(f.ids.alice,{id:randomUUID(),installationId:randomUUID(),signingPublicKey:'bad',encryptionPublicKey,capabilities:[]}));
  f.post('alice',p.participationId); const req=request(f,n);
  assert.throws(()=>f.r.accept(n.principal,{...result(req,'turn.admitted',1,{}),providerKey:'must never exist'}));
  f.r.accept(n.principal,result(req,'turn.admitted',1,{}));
  code(()=>f.r.accept(n.principal,result(req,'turn.partial',2,{text:'x'.repeat(8001)})),'invalid_text');
  code(()=>f.r.accept(n.principal,result(req,'turn.approval.request',2,{actionId:randomUUID(),actionDigest:sha256('x'),requiredApproverAccountId:f.ids.bob,expiresAt:f.a.now()+1000})),'authority_denied');
});

test('expired frames, forged fences and publication limits cannot admit new work', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n); f.post('alice',p.participationId); const req=request(f,n);
  const admitted=result(req,'turn.admitted',1,{});
  for(const name of Object.keys(req.fence)) {
    const fence={...req.fence,[name]:name==='authorityGeneration'?randomUUID():99};
    code(()=>f.r.accept(n.principal,{...admitted,fence}),'authority_denied');
  }
  f.r.accept(n.principal,admitted);
  for(let sequence=2;sequence<=33;sequence++) f.r.accept(n.principal,result(req,'turn.partial',sequence,{text:'x'.repeat(8000)}));
  code(()=>f.r.accept(n.principal,result(req,'turn.partial',34,{text:'x'.repeat(8000)})),'result_limit');
  f.tick(600000); code(()=>f.r.accept(n.principal,result(req,'turn.final',34,{text:'Late'})),'stale_revision');
  assert.equal(f.r.pending(n.principal).length,0);
  code(()=>f.r.lease(n.principal,{projectId:req.projectId,turnId:req.turnId!,actionId:randomUUID(),actionDigest:sha256('x'),fence:req.fence}),'stale_revision');
});

test('lost approval ACK consults existing receipt after approval expiry without creating new approval', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n); f.post('alice',p.participationId); const req=request(f,n);
  f.r.accept(n.principal,result(req,'turn.admitted',1,{}));
  const approval=result(req,'turn.approval.request',2,{actionId:randomUUID(),actionDigest:sha256('effect'),requiredApproverAccountId:f.ids.alice,expiresAt:f.a.now()+1000});
  f.r.accept(n.principal,approval); f.tick(1000);
  assert.equal(f.r.accept(n.principal,approval).duplicate,true);
  const forged={...approval,eventId:randomUUID(),sequence:3}; code(()=>f.r.accept(n.principal,forged),'authority_denied');
  assert.equal(f.a.one('SELECT count(*) AS n FROM node_results')!.n,2);
});

test('oversized outbound frame rolls back message and turn rather than omitting delivery', t => {
  const f=fixture(t),n=f.node('alice'),p=f.participate('alice',n);
  code(()=>f.r.post(f.ctx('alice'),{requestId:randomUUID(),sectionId:f.alpha.sectionId,text:'\u0001'.repeat(16000),mentions:[p.participationId]}),'payload_too_large');
  assert.equal(f.a.one('SELECT count(*) AS n FROM messages')!.n,0);
  assert.equal(f.a.one('SELECT count(*) AS n FROM turns')!.n,0);
});

test('migration v0 fixture initializes atomically, checksum/future/foreign database rejection preserves data', () => {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE hub_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT'); initializeHubSchema(db);
  const rows=db.prepare('SELECT * FROM hub_migrations').all(); initializeHubSchema(db); assert.deepEqual(db.prepare('SELECT * FROM hub_migrations').all(),rows);
  db.prepare("UPDATE hub_migrations SET checksum='tampered'").run(); assert.throws(()=>initializeHubSchema(db),/checksum/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM hub_state').get()!.n,1); db.close();
  const future=new DatabaseSync(':memory:'); future.exec("CREATE TABLE hub_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT; INSERT INTO hub_migrations VALUES(99,'future')"); assert.throws(()=>initializeHubSchema(future),/version/); assert(!future.prepare("SELECT 1 FROM sqlite_schema WHERE name='projects'").get()); future.close();
  const foreign=new DatabaseSync(':memory:'); foreign.exec('CREATE TABLE agents(id TEXT)'); assert.throws(()=>initializeHubSchema(foreign),/non-hub/); foreign.close();
  const broken=new DatabaseSync(':memory:'); broken.exec('CREATE TABLE hub_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT; CREATE TABLE sections(id TEXT)'); assert.throws(()=>initializeHubSchema(broken)); assert(!broken.prepare("SELECT 1 FROM sqlite_schema WHERE name='accounts'").get()); assert.equal(broken.prepare('SELECT count(*) AS n FROM hub_migrations').get()!.n,0); broken.close();
});

test('exclusive writer/WAL, consistent backup/reopen and restore generation fence invitations and unfinished work', async t => {
  const dir=mkdtempSync(resolve(tmpdir(),'briefsip-hub-')), handles: ReturnType<typeof openHubDatabase>[]=[]; t.after(()=>{ for(const handle of handles) handle.close(); rmSync(dir,{recursive:true,force:true}); });
  const file=resolve(dir,'hub.sqlite'), original=openHubDatabase(file); handles.push(original);
  assert.equal(original.db.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal'); assert.equal(original.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);
  assert.throws(()=>openHubDatabase(file),/EEXIST/);
  const competitor = spawnSync(process.execPath, ['--experimental-strip-types','--input-type=module','-e', `import {openHubDatabase} from ${JSON.stringify(new URL('./schema.ts', import.meta.url).href)}; try {openHubDatabase(${JSON.stringify(file)});process.exitCode=1} catch(e) {if(e.code!=='EEXIST') throw e}`], { encoding: 'utf8' });
  assert.equal(competitor.status, 0, competitor.stderr);
  const alias=resolve(dir,'alias.sqlite'); symlinkSync(file,alias); assert.throws(()=>openHubDatabase(alias),/aliases/);
  const hard=resolve(dir,'hard.sqlite'); linkSync(file,hard); assert.throws(()=>openHubDatabase(hard),/hard links/); unlinkSync(hard);
  const a=createHubAuthority(original.db,{domain:'briefsip.test',mailboxKey:key}),r=createHubRouting(a),alice=a.provisionAccount(identity('alice'),true),bob=a.provisionAccount(identity('bob'),true),p=a.createProject(alice,'alpha','Alpha'),ctx=a.resolveProject(p.host,alice);
  const invite=a.invite(ctx,{mailbox:'bob@example.com',role:'member',expiresAt:Date.now()+10000});
  const nodeId=a.registerNode(alice,{id:randomUUID(),installationId:randomUUID(),signingPublicKey,encryptionPublicKey,capabilities:['chat']}),principal=a.connectNode(alice,nodeId,1),agent=a.registerAgent(alice,nodeId,randomUUID(),'Alice');
  const policy:ParticipationPolicy={sectionIds:[p.sectionId],invocation:{mode:'owner'},scopes:['read','invoke'],localPolicyDigest:sha256('x'),payerBindingRef:'local',maxCostMicros:1};
  const join=a.propose(ctx,agent,policy); a.consent(ctx,join.participationId,join.revision,join.policyDigest,'project'); a.consent(ctx,join.participationId,join.revision,join.policyDigest,'owner',principal);
  const posted=r.post(ctx,{requestId:randomUUID(),sectionId:p.sectionId,text:'Persisted',mentions:[join.participationId]});
  const backup=resolve(dir,'backup.sqlite'); await backupHub(original.db,backup);
  assert.equal(statSync(backup).mode & 0o777, 0o600); await assert.rejects(backupHub(original.db,backup), /EEXIST/); original.close();
  const reopened=openHubDatabase(file); assert.equal(reopened.db.prepare('SELECT text FROM messages').get()!.text,'Persisted'); reopened.close();
  const restored=openHubDatabase(backup); handles.push(restored); initializeHubSchema(restored.db);
  const before=String(restored.db.prepare('SELECT authority_generation FROM hub_state').get()!.authority_generation),generation=fenceRestoredHub(restored.db); assert.notEqual(generation,before);
  const ra=createHubAuthority(restored.db,{domain:'briefsip.test',mailboxKey:key}),rr=createHubRouting(ra);
  code(()=>ra.resolveProject(p.host,alice),'authority_unavailable'); assert.throws(()=>activateRestoredHub(restored.db,before),/generation/); activateRestoredHub(restored.db,generation);
  assert.equal(rr.turn(ra.resolveProject(p.host,alice),posted.turnIds[0]).state,'unknown');
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n,0);
  code(()=>rr.pending(principal),'stale_revision');
  code(()=>ra.acceptInvite(ra.resolveProject(p.host,bob),invite.invitationId,invite.token,identity('bob')),'invitation_unavailable');
  assert.equal(restored.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

function guardImports(root: string, source?: string) {
  const hub=resolve(root,'hub'),allowed=new Set(['node:crypto','node:fs','node:path','node:sqlite','node:url']),seen=new Set<string>();
  function scan(path: string, contents=readFileSync(path,'utf8')) {
    if (seen.has(path)) return; seen.add(path);
    const tree=ts.createSourceFile(path,contents,ts.ScriptTarget.Latest,true);
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier) {
        assert(ts.isStringLiteral(node.moduleSpecifier)); const name=node.moduleSpecifier.text;
        if (allowed.has(name)) return;
        assert(name.startsWith('.'),`Forbidden hub import ${name}`);
        const target=resolve(dirname(path),name); assert(target.startsWith(`${hub}/`)||target===resolve(root,'protocol.ts'),`Execution boundary import: ${name}`); scan(target);
      }
      if(ts.isCallExpression(node)) assert(node.expression.kind!==ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(node.expression)&&['require','eval','Function'].includes(node.expression.text)),'Dynamic execution/import forbidden');
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  if(source!==undefined) scan(resolve(hub,'fixture.ts'),source);
  else for(const name of readdirSync(hub)) if(name.endsWith('.ts')&&!name.endsWith('.test.ts')) scan(resolve(hub,name));
}

test('hub production import graph cannot reach engine, provider, tools or canonical service (including transitive/dynamic imports)', () => {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'); guardImports(root);
  assert.throws(()=>guardImports(root,"import '../task-recovery.ts';"),/Execution boundary/);
  assert.throws(()=>guardImports(root,"export * from '../server.ts';"),/Execution boundary/);
  assert.throws(()=>guardImports(root,"import('node:child_process');"),/Dynamic/);
  assert.throws(()=>guardImports(root,"import {exec} from 'node:child_process';"),/Forbidden/);
});
