import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createClerkClient } from '@clerk/backend';
import type { AuthConfig } from './auth.ts';
import { startRustServer } from './rust-test-server.ts';
import { startCanonicalApp } from './test-bridge.ts';
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
const rustAuth = {
  ...config,
  jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  development: true,
};

async function session(origin: string, token?: string, options: { method?: string; origin?: string; cookie?: string; path?: string } = {}) {
  const requestId = randomUUID();
  const response = await fetch(origin + (options.path ?? '/api/session'), {
    method: options.method ?? 'GET',
    ...(options.method === 'POST' ? { body: JSON.stringify({ requestId }) } : {}),
    headers: {
      'Content-Type': 'application/json',
      'X-Briefsip-Protocol': '1',
      'X-Briefsip-Request-Id': requestId,
      Origin: options.origin ?? config.origin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

test('Rust verifies signed human sessions before internal account mapping', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-rust-auth-')), database = join(dir, 'db.sqlite');
  let app: Awaited<ReturnType<typeof startRustServer>> | undefined;
  let db: DatabaseSync | undefined;
  t.after(async () => {
    db?.close();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app = await startRustServer({ database, auth: rustAuth });
  db = new DatabaseSync(database);

  const first = await session(app.origin, jwt());
  assert.equal(first.status, 200);
  const { accountId } = first.body.data;
  assert.equal(db.prepare('SELECT clerk_sub FROM accounts WHERE id=?').get(accountId)?.clerk_sub, 'user_fixture');
  assert.equal((await session(app.origin, jwt())).body.data.accountId, accountId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM record_scopes').get()!.n, 0);
  const other = await session(app.origin, jwt({ sub: 'user_other' }));
  assert.equal(other.status, 200);
  assert.notEqual(other.body.data.accountId, accountId);
  assert.equal((await session(app.origin)).status, 401);
  assert.equal((await session(app.origin, undefined, { cookie: `__session=${jwt()}` })).status, 401);
  assert.equal((await session(app.origin, jwt(), { method: 'POST', origin: 'https://evil.example', path: '/api/session/logout' })).status, 403);

  const now = Math.floor(Date.now() / 1000);
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const claims of [{ iss: 'https://wrong.example' }, { exp: now }, { nbf: now + 30 }, { azp: 'https://wrong.example' }, { sid: '' }, { sub: '' }, { sts: 'pending' }]) {
    assert.equal((await session(app.origin, jwt(claims))).status, 401, JSON.stringify(claims));
  }
  assert.equal((await session(app.origin, jwt({}, wrongKey.privateKey))).status, 401);
  db.prepare('UPDATE accounts SET blocked=1 WHERE id=?').run(accountId);
  assert.equal((await session(app.origin, jwt())).status, 401);
});

test('Rust logout denial survives disk reopen, old JWT expiry and upstream recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-rust-logout-')), database = join(dir, 'db.sqlite');
  let upstream = false, observedDenial: string | undefined;
  const api = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/sessions/sess_fixture/revoke') {
      res.writeHead(404).end();
      return;
    }
    const db = new DatabaseSync(database, { readOnly: true });
    try { observedDenial = String(db.prepare('SELECT reason FROM session_denials').get()?.reason); }
    finally { db.close(); }
    res.writeHead(upstream ? 200 : 503).end('{}');
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert(address && typeof address !== 'string');
  const auth = { ...rustAuth, apiUrl: `http://127.0.0.1:${address.port}` };
  let app: Awaited<ReturnType<typeof startRustServer>> | undefined;
  try {
    app = await startRustServer({ database, auth });
    assert.equal((await session(app.origin, jwt())).status, 200);
    const logout = await session(app.origin, jwt(), { method: 'POST', path: '/api/session/logout' });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.body.data, { state: 'upstream_pending' });
    assert.equal(observedDenial, 'logout_pending');
    await app.close();
    const db = new DatabaseSync(database);
    try { db.prepare('UPDATE session_denials SET expires_at=?').run(Date.now() - 60000); }
    finally { db.close(); }
    app = await startRustServer({ database, auth });
    assert.equal((await session(app.origin, jwt())).status, 401);
    await app.close();
    upstream = true;
    app = await startRustServer({ database, auth });
    const reopened = new DatabaseSync(database, { readOnly: true });
    try {
      for (let n = 0; n < 100 && reopened.prepare('SELECT reason FROM session_denials').get()?.reason !== 'logout_complete'; n++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(reopened.prepare('SELECT reason FROM session_denials').get()?.reason, 'logout_complete');
    } finally { reopened.close(); }
    assert.equal((await session(app.origin, jwt())).status, 401);
  } finally {
    await app?.close();
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical listen failure leaves no maintenance running on a closed database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-listen-failure-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert(address && typeof address !== 'string');
  try {
    await assert.rejects(startCanonicalApp({ database: join(dir, 'db.sqlite'), auth: { ...config, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), development: true }, port: address.port }), { code: 'EADDRINUSE' });
    const restarted = await startRustServer({ database: join(dir, 'db.sqlite'), auth: rustAuth });
    await restarted.close();
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical HTTP verifies identity, isolates projects and cannot dispatch legacy routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-canonical-'));
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const app = await startCanonicalApp({ database: join(dir, 'db.sqlite'), auth: { ...config, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), development: true }, clerk });
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
    const legacy = await send('/api/agents', 'POST', { requestId: randomUUID(), id: randomUUID(), text: 'Never execute' }); assert.equal(legacy.status, 400); assert.equal(legacy.body.error.code, 'invalid_agent');
    assert.equal((await send(`/api/agents/${randomUUID()}/turns`)).status, 404);
    const invalid = await send('/api/projects', 'GET', undefined, 'invalid'); assert.equal(invalid.status, 401); assert.equal(invalid.body.ok, false);
    const duplicateId = randomUUID();
    const duplicate = await fetch(app.origin + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt()}`, Origin: config.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': duplicateId }, body: `{"requestId":"${duplicateId}","id":"${randomUUID()}","name":"First","name":"Second"}` });
    assert.equal(duplicate.status, 400); assert.equal((await duplicate.json()).error.code, 'duplicate_key');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical invitation creates durable outbox and worker delivers through configured provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-canonical-mail-')); let delivered = 0; const bodies: string[] = [];
  const provider = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; bodies.push(body); delivered++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'remote-mail-1' })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const mailKey = Buffer.alloc(32, 7), lookupKey = Buffer.alloc(32, 9), oldKeyId = randomUUID();
  let mail = { from: 'noreply@example.com', origin: config.origin, keyId: oldKeyId, key: mailKey, lookupKey, keyFor: (keyId: string) => { assert.equal(keyId, oldKeyId); return mailKey; } };
  const clerk = createClerkClient({ secretKey: config.secretKey, publishableKey: config.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const options = { mailFrom: 'noreply@example.com', mailOrigin: config.origin, mailApiKey: 'resend_fixture', installationId: randomUUID(), testKeyring: { 'mail-aead/active': oldKeyId, ['mail-aead/' + oldKeyId]: mailKey.toString('base64url'), 'mail-lookup/v1': lookupKey.toString('base64url') }, database: join(dir, 'db.sqlite'), auth: { ...config, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), development: true }, clerk, mail: () => mail, mailEndpoint: `http://127.0.0.1:${address.port}/emails` };
  let app = await startCanonicalApp(options);
  const send = async (path: string, body: Record<string, unknown>) => fetch(app.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${jwt()}`, Origin: config.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': String(body.requestId) }, body: JSON.stringify(body) });
  try {
    const projectId = randomUUID(); const project = await send('/api/projects', { requestId: randomUUID(), id: projectId, name: 'Mail fixture' }); assert.equal(project.status, 201);
    const invitationId = randomUUID(); const response = await send(`/api/projects/${projectId}/invitations`, { requestId: invitationId, email: 'member@example.com', agentAssignments: [], expiresAt: Date.now() + 60000, expectedProjectRevision: 1 }); assert.equal(response.status, 201, await response.clone().text());
    await app.close();
    const db = new DatabaseSync(options.database);
    db.prepare("UPDATE mail_outbox SET state='sending',next_attempt=? WHERE id=?").run(Date.now() - 1, invitationId); db.close();
    mail = { ...mail, keyId: randomUUID(), key: Buffer.alloc(32, 11) };
    app = await startCanonicalApp({ ...options, mailApiKey: 'resend_fixture' });
    for (let n = 0; n < 100 && !delivered; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(delivered, 1); assert.match(bodies[0], /member@example.com/); assert.match(bodies[0], /Briefsip/);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
