import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createMailWorker, decryptMail, encryptMail, mailLookupDigest, mailKeyring, serializeMailEnvelope } from './mail.ts';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { initializeCanonicalSchema } from './schema.ts';

test('mail envelope round trip uses fresh nonce, exact AAD and digest', () => {
  const id = randomUUID(), generation = randomUUID(), keyId = randomUUID(), key = randomBytes(32), lookup = randomBytes(32), hash = mailLookupDigest('owner@example.com', lookup);
  const first = encryptMail(id, 1, generation, hash, { to: 'owner@example.com', from: 'noreply@example.com', subject: 'Invite', text: 'Join' }, keyId, key);
  const second = encryptMail(id, 1, generation, hash, { to: 'owner@example.com', from: 'noreply@example.com', subject: 'Invite', text: 'Join' }, keyId, key);
  assert.notEqual(first.envelope.nonce, second.envelope.nonce);
  const restored = decryptMail(id, 1, generation, hash, serializeMailEnvelope(first.envelope), key);
  assert.equal(restored.payload.text, 'Join'); assert.equal(restored.payloadDigest, first.payloadDigest); assert.equal(restored.keyId, keyId);
  const tampered = { ...first.envelope, tag: first.envelope.tag.slice(0, -1) + (first.envelope.tag.endsWith('A') ? 'B' : 'A') };
  assert.throws(() => decryptMail(id, 1, generation, hash, serializeMailEnvelope(tampered), key));
  assert.throws(() => decryptMail(id, 2, generation, hash, serializeMailEnvelope(first.envelope), key), /Envelope mail gagal/);
});

test('keyring rotation preserves old envelope key and failed pointer write keeps active key', () => {
  const entries = new Map<string, string>(); let interrupt = false;
  const ring = mailKeyring(randomUUID(), (service, name) => ({ getPassword: () => entries.get(`${service}/${name}`) ?? null, setPassword(value) { if (interrupt && name === 'mail-aead/active') { interrupt = false; throw new Error('synthetic pointer fault'); } entries.set(`${service}/${name}`, value); } }));
  assert.throws(() => ring.active(), /Kunci mail/);
  const first = ring.provision(); assert.equal(first.key.length, 32); assert.notDeepEqual(first.key, first.lookupKey);
  const secondId = ring.rotate(); assert.notEqual(secondId, first.keyId); assert.deepEqual(ring.key(first.keyId), first.key);
  assert.deepEqual(ring.active().lookupKey, first.lookupKey);
  interrupt = true; assert.throws(() => ring.rotate(), /Kunci mail/); assert.equal(ring.active().keyId, secondId);
});

test('lost mail reply retries exact bytes/key once and fences old authority or expired idempotency', async () => {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db);
  const account = randomUUID(), project = randomUUID(), keyId = randomUUID(), key = randomBytes(32); let now = Date.now();
  const generation = String(db.prepare('SELECT generation FROM authority_state').get()!.generation);
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, 'https://fixture.example', 'owner', now);
  db.prepare("INSERT INTO projects VALUES (?,?,'Fixture',0,0,1)").run(project, account);
  db.prepare("INSERT INTO project_members VALUES (?,?,'owner',1,0)").run(project, account);
  function pending() {
    const invitation = randomUUID(), hash = mailLookupDigest('member@example.com', randomBytes(32));
    const encrypted = encryptMail(invitation, 1, generation, hash, { to: 'member@example.com', from: 'noreply@example.com', subject: 'Invite', text: 'Fixture link' }, keyId, key);
    db.prepare("INSERT INTO invitations VALUES (?,?,?,?,NULL,'pending_delivery',?,?,?,NULL,1)").run(invitation, project, generation, hash, randomBytes(32).toString('hex'), '{"v":1,"projectRevision":1,"agents":[]}', now + 86400000);
    db.prepare("INSERT INTO mail_outbox VALUES (?,1,?,'queued',NULL,NULL,0,NULL,?)").run(invitation, serializeMailEnvelope(encrypted.envelope), encrypted.payloadDigest);
    return invitation;
  }
  let lose = true, calls = 0; const effects = new Map<string, string>(); const bodies: string[] = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; calls++; bodies.push(body);
    const token = String(req.headers['idempotency-key']);
    if (effects.has(token)) assert.equal(effects.get(token), body); else effects.set(token, body);
    if (lose) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'mail_fixture' }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const config = { apiKey: 'synthetic-key', key: () => key, endpoint: `http://127.0.0.1:${address.port}/emails`, development: true, now: () => now };
  try {
    const first = pending(); const worker = createMailWorker(db, config);
    assert.deepEqual(await worker.deliver(first), { state: 'unknown' });
    now = Number(db.prepare('SELECT next_attempt FROM mail_outbox WHERE id=?').get(first)!.next_attempt) + 1; lose = false;
    assert.deepEqual(await createMailWorker(db, config).deliver(first), { state: 'sent' });
    assert.equal(calls, 2); assert.equal(effects.size, 1); assert.equal(bodies[0], bodies[1]);
    assert.equal(db.prepare('SELECT length(ciphertext) AS n FROM mail_outbox WHERE id=?').get(first)!.n, 0);
    assert.equal(db.prepare('SELECT revision FROM invitations WHERE id=?').get(first)!.revision, 2);
    const missing = pending(); const noKey = createMailWorker(db, { ...config, key: () => { throw new Error('synthetic unreadable key'); } });
    await assert.rejects(noKey.deliver(missing)); assert.equal(db.prepare('SELECT attempts FROM mail_outbox WHERE id=?').get(missing)!.attempts, 0); assert.equal(calls, 2);
    const horizon = pending(); lose = true; await worker.deliver(horizon); now += 23 * 3600000;
    assert.deepEqual(await worker.deliver(horizon), { state: 'deferred' }); assert.equal(db.prepare('SELECT state FROM invitations WHERE id=?').get(horizon)!.state, 'delivery_unknown');
    const old = pending(); db.prepare('UPDATE authority_state SET generation=?').run(randomUUID());
    const count = calls; await worker.deliver(old); assert.equal(calls, count); assert.equal(db.prepare('SELECT length(ciphertext) AS n FROM mail_outbox WHERE id=?').get(old)!.n, 0);
  } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); db.close(); }
});
