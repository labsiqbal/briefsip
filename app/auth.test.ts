import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createClerkClient } from '@clerk/backend';
import { createAuth, type AuthConfig } from './auth.ts';
import { initializeCanonicalSchema } from './schema.ts';
import { startCanonicalApp } from './server.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const config: AuthConfig = { secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`, issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://briefsip.example' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwt(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey, kid = 'fixture') {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.issuer, sub: 'user_fixture', sid: 'sess_fixture', azp: config.origin, exp: now + 60, nbf: now - 1, iat: now - 1, ...overrides })).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const request = (token?: string, method = 'GET', origin = config.origin) => new Request(`${config.origin}/api/session`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin } });

test('Clerk SDK verifies signed human sessions before internal account mapping', async () => {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db);
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const auth = createAuth(db, config, clerk);
  try {
    const actor = await auth.authenticate(request(jwt()));
    assert.equal(actor.subject, 'user_fixture'); assert.equal((await auth.authenticate(request(jwt()))).accountId, actor.accountId);
    assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM record_scopes').get()!.n, 0);
    const other = await auth.authenticate(request(jwt({ sub: 'user_other' }))); assert.notEqual(other.accountId, actor.accountId);
    await assert.rejects(auth.authenticate(request()), /Sesi/);
    await assert.rejects(auth.authenticate(new Request(`${config.origin}/api/session`, { headers: { Cookie: `__session=${jwt()}` } })), /Sesi/);
    await assert.rejects(auth.authenticate(request(jwt(), 'POST', 'https://evil.example')), /Origin/);
    const now = Math.floor(Date.now() / 1000);
    const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const claims of [{ iss: 'https://wrong.example' }, { exp: now }, { nbf: now + 30 }, { azp: 'https://wrong.example' }, { sid: '' }, { sub: '' }, { sts: 'pending' }]) await assert.rejects(auth.authenticate(request(jwt(claims))), /Sesi/);
    await assert.rejects(auth.authenticate(request(jwt({}, wrongKey.privateKey))), /Sesi/);
    db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(actor.accountId);
    await assert.rejects(auth.authenticate(request(jwt())), /Sesi/);
    assert.throws(() => auth.requireCurrent(actor), /Sesi/);
  } finally { db.close(); }
});

test('local logout denial survives disk reopen, old JWT expiry and upstream recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-logout-'));
  let db = new DatabaseSync(join(dir, 'db.sqlite')); initializeCanonicalSchema(db);
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  let upstream = false;
  const authClient = { ...clerk, sessions: { revokeSession: async () => { assert.equal(db.prepare('SELECT count(*) AS n FROM session_denials').get()!.n, 1); if (!upstream) throw new Error('synthetic upstream unavailable'); } } };
  const auth = createAuth(db, config, authClient);
  try {
    const actor = await auth.authenticate(request(jwt())); assert.deepEqual(await auth.logout(actor), { state: 'upstream_pending' });
    db.prepare('UPDATE session_denials SET expires_at=?').run(Date.now() - 60000);
    db.close(); db = new DatabaseSync(join(dir, 'db.sqlite')); initializeCanonicalSchema(db);
    await assert.rejects(createAuth(db, config, authClient).authenticate(request(jwt())), /Sesi/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_denials').get()!.n, 1);
    upstream = true; assert.deepEqual(await createAuth(db, config, authClient).retryPendingLogouts(), { attempted: 1, completed: 1 });
    assert.equal(db.prepare('SELECT reason FROM session_denials').get()!.reason, 'logout_complete');
    await assert.rejects(createAuth(db, config, authClient).authenticate(request(jwt())), /Sesi/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical listen failure leaves no maintenance running on a closed database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-listen-failure-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert(address && typeof address !== 'string');
  try {
    await assert.rejects(startCanonicalApp({ database: join(dir, 'db.sqlite'), auth: { ...config, development: true }, port: address.port, mailApiKey: 'resend_fixture', mail: () => ({ from: 'noreply@example.com', origin: config.origin, keyId: randomUUID(), key: Buffer.alloc(32), lookupKey: Buffer.alloc(32) }) }), { code: 'EADDRINUSE' });
    await new Promise(resolve => setTimeout(resolve, 1100));
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical HTTP verifies identity, isolates projects and cannot dispatch legacy routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-canonical-'));
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const app = await startCanonicalApp({ database: join(dir, 'db.sqlite'), auth: { ...config, development: true }, clerk });
  const send = async (path: string, method = 'GET', body?: { requestId: string; [key: string]: unknown }, token = jwt()) => {
    const response = await fetch(app.origin + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: config.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': body?.requestId ?? randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const before = await send('/api/session'); assert.equal(before.status, 200); assert.deepEqual(before.body.data.projects, []);
    const create = { requestId: randomUUID(), id: randomUUID(), name: 'Collaboration' };
    const made = await send('/api/projects', 'POST', create); assert.equal(made.status, 201); assert.equal(made.body.receipt.actorId, before.body.data.accountId);
    assert.equal((await send('/api/projects', 'POST', create)).status, 200);
    assert.equal((await send('/api/projects', 'POST', { ...create, name: 'Changed' })).status, 409);
    assert.equal((await send('/api/projects', 'POST', { ...create, requestId: randomUUID(), id: randomUUID(), private: true })).status, 400);
    const other = jwt({ sub: 'user_other' }); assert.deepEqual((await send('/api/projects', 'GET', undefined, other)).body.data, []);
    const hidden = await send(`/api/projects/${create.id}`, 'GET', undefined, other); assert.equal(hidden.status, 404); assert.equal(hidden.body.error.code, 'resource_not_found');
    const legacy = await send('/api/agents', 'POST', { requestId: randomUUID(), id: randomUUID(), text: 'Never execute' }); assert.equal(legacy.status, 404);
    const invalid = await send('/api/projects', 'GET', undefined, 'invalid'); assert.equal(invalid.status, 401); assert.equal(invalid.body.ok, false);
    const duplicateId = randomUUID();
    const duplicate = await fetch(app.origin + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt()}`, Origin: config.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': duplicateId }, body: `{"requestId":"${duplicateId}","id":"${randomUUID()}","name":"First","name":"Second"}` });
    assert.equal(duplicate.status, 400); assert.equal((await duplicate.json()).error.code, 'duplicate_key');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Clerk rotating JWKS and server-side mailbox verification fail closed', async () => {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db);
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 }); let includeRotated = false, verified = true, jwksCalls = 0;
  const api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/jwks')) {
      jwksCalls++;
      res.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }, ...(includeRotated ? [{ ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated', use: 'sig', alg: 'RS256' }] : [])] }));
    } else if (req.url?.includes('/users/')) res.end(JSON.stringify({ object: 'user', id: 'user_fixture', banned: false, locked: false, external_accounts: [], saml_accounts: [], phone_numbers: [], web3_wallets: [], enterprise_accounts: [], email_addresses: [{ id: 'email_fixture', object: 'email_address', linked_to: [], email_address: 'Member@Example.COM', verification: { status: verified ? 'verified' : 'unverified', strategy: 'admin' } }] }));
    else { res.statusCode = 404; res.end(JSON.stringify({ errors: [{ message: req.url }] })); }
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve)); const address = api.address(); assert(address && typeof address !== 'string');
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, apiUrl: `http://127.0.0.1:${address.port}`, telemetry: { disabled: true } });
  const auth = createAuth(db, config, clerk);
  try {
    const actor = await auth.authenticate(request(jwt())); assert(jwksCalls > 0);
    assert.equal((await clerk.users.getUser(actor.subject).catch(error => assert.fail(JSON.stringify({ status: error.status, errors: error.errors })))).id, actor.subject);
    assert.deepEqual(await auth.verifiedMailboxes(actor), ['member@example.com']); verified = false; assert.deepEqual(await auth.verifiedMailboxes(actor), []);
    includeRotated = true; const before = jwksCalls; assert.equal((await auth.authenticate(request(jwt({}, rotated.privateKey, 'rotated')))).accountId, actor.accountId); assert(jwksCalls > before);
    await assert.rejects(auth.authenticate(request(jwt({}, keys.privateKey, 'unknown'))), /Sesi/);
    const audience = createAuth(db, { ...config, audience: 'briefsip' }, clerk);
    await assert.rejects(audience.authenticate(request(jwt())), /Sesi/); await assert.rejects(audience.authenticate(request(jwt({ aud: 'other' }))), /Sesi/);
    assert.equal((await audience.authenticate(request(jwt({ aud: 'briefsip' })))).accountId, actor.accountId);
  } finally { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); db.close(); }
});

test('canonical invitation creates durable outbox and worker delivers through configured provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-canonical-mail-')); let delivered = 0; const bodies: string[] = [];
  const provider = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; bodies.push(body); delivered++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'remote-mail-1' })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const mailKey = Buffer.alloc(32, 7), lookupKey = Buffer.alloc(32, 9), oldKeyId = randomUUID();
  let mail = { from: 'noreply@example.com', origin: config.origin, keyId: oldKeyId, key: mailKey, lookupKey, keyFor: (keyId: string) => { assert.equal(keyId, oldKeyId); return mailKey; } };
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const options = { database: join(dir, 'db.sqlite'), auth: { ...config, development: true }, clerk, mail: () => mail, mailEndpoint: `http://127.0.0.1:${address.port}/emails` };
  let app = await startCanonicalApp(options);
  const send = async (path: string, body: Record<string, unknown>) => fetch(app.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${jwt()}`, Origin: config.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': String(body.requestId) }, body: JSON.stringify(body) });
  try {
    const projectId = randomUUID(); const project = await send('/api/projects', { requestId: randomUUID(), id: projectId, name: 'Mail fixture' }); assert.equal(project.status, 201);
    const invitationId = randomUUID(); const response = await send(`/api/projects/${projectId}/invitations`, { requestId: invitationId, email: 'member@example.com', agentAssignments: [], expiresAt: Date.now() + 60000, expectedProjectRevision: 1 }); assert.equal(response.status, 201);
    await app.close();
    const db = new DatabaseSync(options.database);
    db.prepare("UPDATE mail_outbox SET state='sending',next_attempt=? WHERE id=?").run(Date.now() - 1, invitationId); db.close();
    mail = { ...mail, keyId: randomUUID(), key: Buffer.alloc(32, 11) };
    app = await startCanonicalApp({ ...options, mailApiKey: 'resend_fixture' });
    for (let n = 0; n < 100 && !delivered; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(delivered, 1); assert.match(bodies[0], /member@example.com/); assert.match(bodies[0], /Briefsip/);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
