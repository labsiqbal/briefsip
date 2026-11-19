import assert from 'node:assert/strict';
import test from 'node:test';
import { testDatabase } from '../test-support/database.ts';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { initializeHubSchema } from './schema.ts';
import { createHubAuthority } from './project-authority.ts';
import { createHubWebApi } from './web.ts';
import { parseDraft, parseJoin, parseGrant } from '../src/hub/client.ts';

test('pilot web adapters: no outsider reads, exact mailbox acceptance, owner node/agent binding, role and participation policies', () => {
  const db = testDatabase(':memory:'); initializeHubSchema(db);
  try {
    const authority = createHubAuthority(db, { domain: 'briefsip.test', mailboxKey: Buffer.alloc(32, 9) }), web = createHubWebApi(authority);
    const identity = (subject: string) => ({ issuer: 'https://identity.test', subject, verifiedMailboxes: [`${subject}@example.test`] });
    const alice = authority.provisionAccount(identity('alice'), true), bob = authority.provisionAccount(identity('bob'), true), eve = authority.provisionAccount(identity('eve'), true);
    const project = authority.createProject(alice, 'alpha', 'Alpha'), ctx = (account: string) => authority.resolveProject(project.host, account);
    assert.throws(() => web.members(ctx(eve))); assert.throws(() => web.invitations(ctx(eve))); assert.throws(() => web.participants(ctx(eve))); assert.throws(() => web.turns(ctx(eve), project.sectionId));
    const invite = web.invite(ctx(alice), { mailbox: 'bob@example.test', role: 'member' });
    const fragment = new URLSearchParams(new URL(invite.url).hash.slice(1)); const proof = { invitationId: fragment.get('invitationId'), token: fragment.get('token') };
    assert.throws(() => web.accept(ctx(eve), proof, identity('eve')));
    web.accept(ctx(bob), proof, identity('bob')); assert.equal(web.invitations(ctx(alice))[0].state, 'accepted'); assert.throws(() => web.accept(ctx(bob), proof, identity('bob')));
    assert(!JSON.stringify(web.invitations(ctx(alice))).includes(String(proof.token))); assert.equal(web.members(ctx(alice)).length, 2); assert.deepEqual(web.turns(ctx(alice), project.sectionId), []);
    const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519'), nodeId = randomUUID();
    const encode = (key: typeof signing.publicKey) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
    authority.registerNode(bob, { id: nodeId, installationId: randomUUID(), signingPublicKey: encode(signing.publicKey), encryptionPublicKey: encode(encryption.publicKey), capabilities: ['chat'] });
    const agentId = randomUUID(); assert.throws(() => web.registerAgent(alice, { agentId, nodeId, name: 'Bob agent' }));
    web.registerAgent(bob, { agentId, nodeId, name: 'Bob agent' }); web.registerAgent(bob, { agentId, nodeId, name: 'Bob agent' });
    assert.throws(() => web.registerAgent(bob, { agentId, nodeId, name: 'Changed' }));
    const proposal = web.propose(ctx(bob), { agentId, policy: { sectionIds: [project.sectionId], scopes: ['read', 'invoke'], invocation: { mode: 'all-members' }, payerBindingRef: 'local', localPolicyDigest: '1'.repeat(64), maxCostMicros: 100 } });
    const participant = web.participants(ctx(alice))[0]; assert.equal(participant.id, proposal.participationId); assert.equal(participant.ownerName, 'bob'); assert.equal(participant.nodeStatus, 'offline');
    assert.throws(() => authority.consent(ctx(bob), proposal.participationId, proposal.revision, proposal.policyDigest, 'project'));
    authority.consent(ctx(alice), proposal.participationId, proposal.revision, proposal.policyDigest, 'project'); assert.equal(web.participants(ctx(alice))[0].state, 'proposed');
    assert.throws(() => web.invite(ctx(bob), { mailbox: 'eve@example.test', role: 'admin' }));
  } finally { db.close(); }
});
test('pilot drafts retain exact command and requester selections through renewal, reject corrupt recovery', () => {
  const pending = { requestId: randomUUID(), sectionId: randomUUID(), text: 'Keep draft', mentions: [randomUUID()] };
  const value = { text: pending.text, mentions: pending.mentions, pending };
  assert.deepEqual(parseDraft(JSON.stringify(value)), value);
  const join = { nodeId: randomUUID(), agentId: randomUUID(), name: 'Agent', localPolicyDigest: 'a'.repeat(64), maxCostMicros: 100, providerMaxCostMicros: 10 };
  assert.deepEqual(parseJoin(JSON.stringify(join)), join);
  for (const bad of [{ ...join, name: {} }, { ...join, providerMaxCostMicros: 101 }, null]) assert.throws(() => parseJoin(JSON.stringify(bad)));
  const grant = { projectId: randomUUID(), participationId: randomUUID(), agentId: join.agentId, localAgentId: join.agentId, revision: 1, providerMaxCostMicros: 10, policy: { sectionIds: [randomUUID()], invocation: { mode: 'owner' }, scopes: ['read','invoke'], localPolicyDigest: join.localPolicyDigest, payerBindingRef: join.agentId, maxCostMicros: 100 } };
  assert.deepEqual(parseGrant(JSON.stringify(grant)), grant);
  assert.throws(() => parseGrant(JSON.stringify({ ...grant, policy: { ...grant.policy, invocation: { mode: 'members' } } })));
  assert.throws(() => parseGrant(JSON.stringify({ ...grant, providerMaxCostMicros: 101 })));

  assert.deepEqual(parseDraft(null), { text: '', mentions: [], pending: null });
  for (const raw of ['broken', '{}', '{"text":"x","mentions":[],"pending":{}}', JSON.stringify({ ...value, mentions: ['not-an-id'] })]) assert.throws(() => parseDraft(raw));
});
