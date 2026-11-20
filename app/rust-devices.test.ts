import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testDatabase } from './test-support/database.ts';
import { installCanonicalFixture } from './test-support/canonical-schema.ts';
import { descriptorBody, deviceLinkBody, deviceProofBody } from './test-support/device-protocol.ts';
import { digestCommand, sha256 } from './shared/protocol.ts';
import { startRustServer } from './rust-test-server.ts';

test('Rust signed device enrollment, stream fencing, sessions, receipts and sync match Node contracts', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-rust-devices-')), database = join(dir, 'db.sqlite'), now = Date.now();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://minarbot.example', development: true, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const account = randomUUID(), project = randomUUID(), actor = { accountId: account, subject: 'user_fixture', issuer: auth.issuer, sessionId: 'sess_fixture', expiresAt: now + 60000 };
  const db = testDatabase(database); installCanonicalFixture(db);
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(account, auth.issuer, actor.subject, now);
  db.prepare("INSERT INTO projects(id,account,name,private) VALUES(?,?,'Fixture',0)").run(project, account);
  db.prepare("INSERT INTO project_members VALUES(?,?,'owner',1,0)").run(project, account);
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: auth.issuer, sub: actor.subject, sid: actor.sessionId, azp: auth.origin, exp: Math.floor(now / 1000) + 60, nbf: Math.floor(now / 1000) - 1 })).toString('base64url')}`;
  const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  const app = await startRustServer({ database, auth, fixedClock: now }), controller = new AbortController();
  t.after(async () => { controller.abort(); await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = (requestId: string) => ({ Authorization: `Bearer ${token}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Minarbot-Protocol': '1', 'X-Minarbot-Request-Id': requestId });
  const human = async (path: string, value?: Record<string, unknown>, extra: Record<string, string> = {}) => { const response = await fetch(app.origin + path, { method: value ? 'POST' : 'GET', headers: { ...headers(String(value?.requestId ?? randomUUID())), ...extra }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: response.status, body: await response.json() }; };
  const installation = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  let signing = generateKeyPairSync('ed25519'), generation = 1;
  const encode = (key: typeof installation.publicKey) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
  const candidate = { requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(), mode: 'new' as const, installationPublicKey: encode(installation.publicKey), deviceSigningKey: encode(signing.publicKey), deviceEncryptionKey: encode(encryption.publicKey), deviceLabel: 'Home', requestedCapabilities: ['execution'], zone: 'Asia/Jakarta', zoneRevision: 1 };
  assert.equal((await human('/api/devices/link-challenges', candidate, { 'X-Forwarded-Host': 'foreign.test' })).status, 403);
  assert.equal((await human('/api/devices/link-challenges', { ...candidate, extra: true })).body.error.code, 'unknown_field');
  assert.equal((await human('/api/devices/link-challenges', { ...candidate, deviceSigningKey: candidate.installationPublicKey })).body.error.code, 'invalid_key');
  const challenged = await human('/api/devices/link-challenges', candidate); assert.equal(challenged.status, 201, JSON.stringify(challenged.body));
  const challenge = challenged.body.data;
  assert.equal(challenge.accountId, account); assert.equal(challenge.clerkSub, actor.subject);
  assert.equal(challenge.expiresAt, now + 120000); assert.equal(challenge.deviceGeneration, 1); assert.equal(challenge.keyRevision, 1);
  assert.equal(challenge.installationThumbprint, sha256(installation.publicKey.export({ type: 'spki', format: 'der' })));
  assert.equal(challenge.signingThumbprint, sha256(signing.publicKey.export({ type: 'spki', format: 'der' })));
  assert.equal(challenge.encryptionThumbprint, sha256(encryption.publicKey.export({ type: 'spki', format: 'der' })));
  const descriptor = { v: 1 as const, accountId: account, installationId: candidate.installationId, deviceId: candidate.deviceId, authorityGeneration: challenge.authorityGeneration, deviceGeneration: challenge.deviceGeneration, keyRevision: challenge.keyRevision, zone: candidate.zone, zoneRevision: 1, signingPublicKey: candidate.deviceSigningKey, encryptionPublicKey: candidate.deviceEncryptionKey };
  const body = Buffer.from(JSON.stringify(deviceLinkBody(candidate, challenge)));
  const request = { requestId: randomUUID(), challengeId: challenge.challengeId, nonce: challenge.nonce, installationSignature: sign(null, body, installation.privateKey).toString('base64url'), deviceSignature: sign(null, body, signing.privateKey).toString('base64url'), descriptor: { ...descriptor, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(descriptor))), signing.privateKey).toString('base64url') } };
  assert.equal((await human('/api/devices/link', { ...request, descriptor: { ...request.descriptor, zone: 'UTC' } })).status, 401);
  const linked = await human('/api/devices/link', request); assert.equal(linked.status, 201, JSON.stringify(linked.body));
  const session = linked.body.data.deviceSession; assert.equal(typeof session, 'string');
  const replay = await human('/api/devices/link', request);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, {
    ok: true,
    data: { deviceId: candidate.deviceId, generation: 1, keyRevision: 1, descriptor: request.descriptor },
    revision: 1,
    receipt: linked.body.receipt,
  });
  assert.deepEqual((await human('/api/devices')).body.data.map(({ descriptor_json, ...row }: Record<string, unknown>) =>
    ({ ...row, descriptor: JSON.parse(String(descriptor_json)) })), [{
    id: candidate.deviceId,
    installation: candidate.installationId,
    generation: 1,
    connection_generation: 0,
    status: 'offline',
    zone: candidate.zone,
    zone_revision: 1,
    last_seen: null,
    capabilities_json: '["execution"]',
    revision: 1,
    descriptor: request.descriptor,
  }]);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_events WHERE record_kind='device'").get()!.n, 1);
  assert(!String(db.prepare('SELECT result_json FROM receipts WHERE request_id=?').get(request.requestId)!.result_json).includes(session));
  function proof(path: string, session: string | undefined, value?: Record<string, unknown>) {
    const requestId = String(value?.requestId ?? randomUUID()).toLowerCase(), body = value ? JSON.stringify(value) : '';
    const p = { deviceId: candidate.deviceId, deviceGeneration: generation, authorityGeneration: challenge.authorityGeneration, requestId, nonce: randomBytes(32).toString('base64url'), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, method: value ? 'POST' : 'GET', path, bodyDigest: sha256(body) };
    return { method: p.method, headers: { ...headers(requestId), Authorization: session ? `Device ${session}` : '', 'X-Minarbot-Proof': JSON.stringify({ ...p, signature: sign(null, Buffer.from(JSON.stringify(deviceProofBody(p))), signing.privateKey).toString('base64url') }) }, ...(value ? { body } : {}) };
  }
  const streamPath = `/api/devices/${candidate.deviceId}/stream`, signed = proof(streamPath, session);
  const response = await fetch(app.origin + streamPath, { ...signed, signal: controller.signal }); assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
  const reader = response.body!.getReader(), connected = JSON.parse(new TextDecoder().decode((await reader.read()).value)); assert.equal(connected.kind, 'connected');
  const duplicate = await fetch(app.origin + streamPath, signed); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'proof_replayed');
  const path = `/api/devices/${candidate.deviceId}/heartbeat`, command = { requestId: randomUUID().toUpperCase(), connectionGeneration: connected.connectionGeneration, zone: 'Asia/Jakarta', zoneRevision: 1, journalWatermark: 0 };
  const heartbeat = await fetch(app.origin + path, proof(path, session, command)); assert.equal(heartbeat.status, 200, await (heartbeat.status === 200 ? Promise.resolve('') : heartbeat.text()));
  const accepted = await heartbeat.json();
  assert.equal(accepted.receipt.payloadDigest, digestCommand(['minarbot-device-heartbeat-v1', candidate.deviceId, { ...command, requestId: command.requestId.toLowerCase() }]));
  const retry = await fetch(app.origin + path, proof(path, session, { ...command, requestId: command.requestId.toLowerCase() }));
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), accepted);
  assert.equal((await human('/api/devices')).body.data[0].status, 'ready');
  const stale = await fetch(app.origin + path, proof(path, session, { ...command, requestId: randomUUID(), connectionGeneration: connected.connectionGeneration + 1 })); assert.equal(stale.status, 409); await stale.json();
  const replacement = await fetch(app.origin + streamPath, { ...proof(streamPath, session), signal: controller.signal }); assert.equal(replacement.status, 200);
  const replacementReader = replacement.body!.getReader(), next = JSON.parse(new TextDecoder().decode((await replacementReader.read()).value));
  assert.equal(next.connectionGeneration, connected.connectionGeneration + 1);
  await reader.cancel().catch(() => {});
  command.requestId = randomUUID(); command.connectionGeneration = next.connectionGeneration;
  const current = await fetch(app.origin + path, proof(path, session, command)); assert.equal(current.status, 200); await current.json();
  assert.equal((await human('/api/devices')).body.data[0].status, 'ready');
  const refreshPath = `/api/devices/${candidate.deviceId}/session`, refresh = await fetch(app.origin + refreshPath, proof(refreshPath, undefined, { requestId: randomUUID(), expectedGeneration: 1 })); assert.equal(refresh.status, 200); const fresh = (await refresh.json()).data.deviceSession; assert.notEqual(fresh, session);
  const old = await fetch(app.origin + path, proof(path, session, { ...command, requestId: randomUUID() })); assert.equal(old.status, 401); await old.json();
  for (const operation of ['wait-reveal-results', 'wait-event-results']) {
    const path = `/api/devices/${candidate.deviceId}/${operation}`, value = { requestId: randomUUID(), payloadDigest: '0'.repeat(64), errorCode: 'wait_invalid' };
    const response = await fetch(app.origin + path, proof(path, fresh, value)); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'wait_invalid');
  }
  let activeSession = fresh;
  for (const mode of ['reenroll', 'rotate'] as const) {
    const previous = signing;
    if (mode === 'rotate') signing = generateKeyPairSync('ed25519');
    const input = { ...candidate, requestId: randomUUID(), mode, expectedGeneration: generation, expectedKeyRevision: 1, deviceSigningKey: encode(signing.publicKey) };
    const response = await human('/api/devices/link-challenges', input); assert.equal(response.status, 201, JSON.stringify(response.body));
    const challenge = response.body.data, desc = { ...descriptor, deviceGeneration: generation + 1, keyRevision: mode === 'rotate' ? 2 : 1, signingPublicKey: input.deviceSigningKey };
    const body = deviceLinkBody(input, challenge), bytes = Buffer.from(JSON.stringify(body));
    const value = { requestId: randomUUID(), challengeId: challenge.challengeId, nonce: challenge.nonce, installationSignature: sign(null, bytes, installation.privateKey).toString('base64url'), deviceSignature: sign(null, bytes, signing.privateKey).toString('base64url'), descriptor: { ...desc, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(desc))), signing.privateKey).toString('base64url') }, ...(mode === 'rotate' ? { rotationSignature: sign(null, Buffer.from(JSON.stringify(['minarbot-device-key-transition-v1', sha256(previous.publicKey.export({ type: 'spki', format: 'der' })), body])), previous.privateKey).toString('base64url') } : {}) };
    const linked = await human('/api/devices/link', value); assert.equal(linked.status, 201, JSON.stringify(linked.body)); generation++;
    assert.equal(linked.body.data.generation, generation); activeSession = linked.body.data.deviceSession;
    const initial = db.prepare('SELECT result_json FROM receipts WHERE request_id=?').get(request.requestId);
    assert.deepEqual(JSON.parse(String(initial?.result_json)).data.descriptor, request.descriptor);
    const stale = await fetch(app.origin + path, proof(path, fresh, { ...command, requestId: randomUUID() })); assert.equal(stale.status, 401); await stale.json();
  }
  const row = (await human('/api/devices')).body.data[0]; assert.equal((await human(`/api/devices/${row.id}/revoke`, { requestId: randomUUID(), expectedRevision: row.revision })).status, 200);
  const revoked = await fetch(app.origin + path, proof(path, activeSession, { ...command, requestId: randomUUID() })); assert.equal(revoked.status, 401); await revoked.json();
  controller.abort(); await replacementReader.cancel().catch(() => {});
});
