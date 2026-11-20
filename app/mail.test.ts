import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { testDatabase } from './test-support/database.ts';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { installCanonicalFixture } from './test-support/canonical-schema.ts';
import { encryptMail, mailLookupDigest, serializeMailEnvelope } from './test-support/mail-fixture.ts';
import { waitFor } from './test-support/rust-connector-fixture.ts';

test('Rust mail retries an exact envelope once and fences missing keys, old authority and the idempotency horizon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'minarbot-rust-mail-retry-'));
  const database = join(root, 'app.sqlite');
  const db = testDatabase(database);
  installCanonicalFixture(db);
  const account = randomUUID(), project = randomUUID(), keyId = randomUUID(), key = randomBytes(32);
  const now = Date.now();
  const generation = String(db.prepare('SELECT generation FROM authority_state').get()!.generation);
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, 'https://fixture.example', 'owner', now);
  db.prepare("INSERT INTO projects VALUES (?,?,'Fixture',0,0,1)").run(project, account);
  db.prepare("INSERT INTO project_members VALUES (?,?,'owner',1,0)").run(project, account);

  function pending(envelopeKey = keyId) {
    const id = randomUUID(), hash = mailLookupDigest('member@example.test', randomBytes(32));
    const { envelope, payloadDigest } = encryptMail(id, 1, generation, hash, {
      to: 'member@example.test', from: 'noreply@example.test', subject: 'Invite', text: 'Fixture link',
    }, envelopeKey, key);
    db.prepare("INSERT INTO invitations VALUES (?,?,?,?,NULL,'pending_delivery',?,?,?,NULL,1)").run(id, project, generation, hash, randomBytes(32).toString('hex'), '{"v":1,"projectRevision":1,"agents":[]}', now + 86400000);
    db.prepare("INSERT INTO mail_outbox VALUES (?,1,?,'queued',NULL,NULL,0,NULL,?)").run(id, serializeMailEnvelope(envelope), payloadDigest);
    return id;
  }

  let loseResponse = true;
  const requests: { key: string; bytes: Buffer }[] = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ key: String(request.headers['idempotency-key']), bytes: Buffer.concat(chunks) });
    if (loseResponse) request.socket.destroy();
    else response.end(JSON.stringify({ id: 'fixture-mail' }));
  });
  await new Promise<void>((resolve, reject) => provider.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const options = {
    database, fixedClock: now,
    auth: { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer: 'https://fixture.clerk.accounts.dev',
      origin: 'https://minarbot.example', development: true, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    mailApiKey: 'synthetic-mail-key', mailEndpoint: `http://127.0.0.1:${address.port}/emails`,
    testKeyring: { [`mail-aead/${keyId}`]: key.toString('base64url'), 'sync-hmac/v1': randomBytes(32).toString('base64url') },
  };
  const state = (id: string) => db.prepare('SELECT o.state,o.attempts,length(o.ciphertext) AS bytes,i.state AS invitation,i.revision FROM mail_outbox o JOIN invitations i ON i.id=o.id WHERE o.id=?').get(id)!;
  const first = pending();
  const locked = pending(randomUUID());
  let app;
  try {
    app = await startApp(options);
    await waitFor(() => state(first).state === 'unknown', 'First attempt did not become uncertain');
    assert.equal(requests.length, 1);
    assert.equal(state(locked).attempts, 0);
    await app.close();

    loseResponse = false;
    db.prepare('UPDATE mail_outbox SET next_attempt=0 WHERE id=?').run(first);
    app = await startApp(options);
    await waitFor(() => state(first).state === 'sent', 'Mail retry did not settle');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].key, `minarbot-invite/${first}/1`);
    assert.equal(state(first).bytes, 0);
    assert.equal(state(first).revision, 2);
    assert.equal(state(locked).attempts, 0);

    loseResponse = true;
    const oldAttempt = pending();
    await waitFor(() => state(oldAttempt).state === 'unknown', 'Second lost response did not become uncertain');
    db.prepare('UPDATE mail_outbox SET first_attempt=?,next_attempt=0 WHERE id=?').run(now - 23 * 3600000, oldAttempt);
    await waitFor(() => state(oldAttempt).invitation === 'delivery_unknown', 'Expired retry horizon did not fence mail');
    assert.equal(state(oldAttempt).bytes, 0);
    assert.equal(requests.length, 3);

    await app.close();
    const oldAuthority = pending();
    db.prepare('UPDATE authority_state SET generation=?').run(randomUUID());
    app = await startApp(options);
    await waitFor(() => state(oldAuthority).state === 'revoked', 'Old authority did not revoke mail');
    assert.equal(state(oldAuthority).bytes, 0);
    assert.equal(requests.length, 3);
  } finally {
    await app?.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
