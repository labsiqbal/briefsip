import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDevices } from './devices.ts';
import { descriptorBody, deviceLinkBody, deviceProofBody, parseLinkChallenge, type DeviceDescriptor, type DeviceProof } from './test-support/device-protocol.ts';
import { initializeCanonicalSchema } from './schema.ts';
import { sha256, digestCommand, ProtocolError } from './shared/protocol.ts';
import type { HumanActor } from './test-support/auth.ts';
import type { WaitRevealRequest } from './wait-connection.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db); let clock = Date.now();
  const owner: HumanActor = { accountId: randomUUID(), subject: 'user_owner', issuer: 'https://fixture.example', sessionId: 'sess_owner', expiresAt: clock + 60000 };
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(owner.accountId, owner.issuer, owner.subject, clock);
  const auth = { requireCurrent(actor: HumanActor) { assert.equal(actor.accountId, owner.accountId); return actor; } };
  const devices = createDevices(db, auth, () => clock), installation = generateKeyPairSync('ed25519');
  let signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const encode = (key: typeof installation.publicKey) => key.export({ type: 'spki', format: 'der' }).toString('base64url');
  const command = { requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(), mode: 'new' as 'new' | 'reenroll' | 'rotate', installationPublicKey: encode(installation.publicKey), deviceSigningKey: encode(signing.publicKey), deviceEncryptionKey: encode(encryption.publicKey), deviceLabel: 'Home A', requestedCapabilities: ['execution'], zone: 'Asia/Jakarta', zoneRevision: 1 };
  function enrollment(change = {}) {
    const input = parseLinkChallenge({ ...command, ...change, requestId: randomUUID() });
    const response = devices.createChallenge(owner, input, 'fixture');
    const desc: Omit<DeviceDescriptor, 'signature'> = { v: 1, accountId: owner.accountId, installationId: input.installationId, deviceId: input.deviceId, authorityGeneration: response.authorityGeneration, deviceGeneration: response.deviceGeneration, keyRevision: response.keyRevision, zone: input.zone, zoneRevision: input.zoneRevision, signingPublicKey: input.deviceSigningKey, encryptionPublicKey: input.deviceEncryptionKey };
    const body = deviceLinkBody(input, response), bodyBytes = Buffer.from(JSON.stringify(body));
    return { input, response, body, request: { requestId: randomUUID(), challengeId: response.challengeId, nonce: response.nonce, installationSignature: sign(null, bodyBytes, installation.privateKey).toString('base64url'), deviceSignature: sign(null, bodyBytes, signing.privateKey).toString('base64url'), descriptor: { ...desc, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(desc))), signing.privateKey).toString('base64url') } } };
  }
  function proof(token: string | undefined, generation: number, method: string, path: string, body = Buffer.alloc(0), change = {}) {
    const requestId = body.length ? JSON.parse(body.toString()).requestId : randomUUID();
    const p: Omit<DeviceProof, 'signature'> = { deviceId: command.deviceId, deviceGeneration: generation, authorityGeneration: String(db.prepare('SELECT generation FROM authority_state').get()!.generation), requestId, nonce: randomBytes(32).toString('base64url'), iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 60, method, path, bodyDigest: sha256(body), ...change };
    return { requestId, headers: new Headers({ ...(token ? { Authorization: `Device ${token}` } : {}), 'X-Briefsip-Proof': JSON.stringify({ ...p, signature: sign(null, Buffer.from(JSON.stringify(deviceProofBody(p))), signing.privateKey).toString('base64url') }) }) };
  }
  return { db, owner, devices, command, enrollment, proof, encode, setSigning(key: { publicKey: KeyObject; privateKey: KeyObject }) { signing = key; command.deviceSigningKey = encode(key.publicKey); }, signing: () => signing, clock: () => clock, advance(ms: number) { clock += ms; } };
}

test('enrollment consumes decoded nonce once, binds signed timezone and never replays session secret', () => {
  const f = fixture(); const { db, devices, owner } = f;
  try {
    const e = f.enrollment();
    assert.equal(db.prepare('SELECT nonce_digest FROM link_challenges').get()!.nonce_digest, sha256(Buffer.from(e.response.nonce, 'base64url')));
    assert(!String(db.prepare('SELECT candidate_json FROM link_challenges').get()!.candidate_json).includes(e.response.nonce));
    assert.throws(() => devices.link(owner, { ...e.request, nonce: randomBytes(32).toString('base64url') }, 'fixture'), /session|proof/);
    const linked = devices.link(owner, e.request, 'fixture'); assert.equal(linked.status, 201); assert.equal(typeof linked.data.deviceSession, 'string');
    const row = db.prepare('SELECT * FROM devices').get()!; assert.equal(row.zone, 'Asia/Jakarta'); assert.equal(row.zone_revision, 1);
    const replay = devices.link(owner, e.request, 'fixture'); assert.equal(replay.status, 200); assert.equal(replay.data.deviceSession, undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get()!.n, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM device_sessions').get()!.n, 1);
    const saved = db.prepare('SELECT result_json FROM receipts WHERE request_id=?').get(e.request.requestId)!; assert(!String(saved.result_json).includes(String(linked.data.deviceSession)));
    assert.throws(() => devices.link(owner, { ...e.request, requestId: randomUUID() }, 'fixture'), /Challenge/);
  } finally { devices.close(); db.close(); }
});

test('device proof nonce, body, expiry and current generation gate heartbeat and session refresh', () => {
  const f = fixture(), { db, devices, owner } = f;
  try {
    const linked = devices.link(owner, f.enrollment().request, 'fixture'), token = String(linked.data.deviceSession), path = `/api/devices/${f.command.deviceId}/heartbeat`;
    const p = f.proof(token, 1, 'GET', '/stream'); const principal = devices.authenticate(p.headers, 'GET', '/stream', Buffer.alloc(0), p.requestId, 'fixture');
    assert.throws(() => devices.authenticate(p.headers, 'GET', '/stream', Buffer.alloc(0), p.requestId, 'fixture'), /Nonce/);
    const stream = devices.openStream(principal, () => {});
    const command = { requestId: randomUUID(), connectionGeneration: stream.connectionGeneration, zone: 'Asia/Jakarta', zoneRevision: 1, journalWatermark: 0 };
    const bytes = Buffer.from(JSON.stringify(command)), signed = f.proof(token, 1, 'POST', path, bytes);
    assert.throws(() => devices.authenticate(signed.headers, 'POST', path, Buffer.from('{}'), signed.requestId, 'fixture'), /session/);
    const current = devices.authenticate(signed.headers, 'POST', path, bytes, signed.requestId, 'fixture');
    const heartbeat = devices.heartbeat(current, command); assert.equal(heartbeat.status, 200); assert.equal(db.prepare('SELECT status FROM devices').get()!.status, 'ready');
    assert.equal(devices.heartbeat(current, command).status, 200);
    assert.throws(() => devices.heartbeat(current, { ...command, requestId: randomUUID(), zone: 'UTC' }), /Time zone/);
    devices.heartbeat(current, { ...command, requestId: randomUUID(), zone: 'UTC', zoneRevision: 2 });
    const oldZone = JSON.parse(String(db.prepare('SELECT descriptor_json FROM devices').get()!.descriptor_json)); assert.equal(oldZone.zone, 'Asia/Jakarta');
    const stale = f.proof(token, 1, 'GET', '/stream', Buffer.alloc(0), { exp: Math.floor(f.clock() / 1000) - 61, iat: Math.floor(f.clock() / 1000) - 120 });
    assert.throws(() => devices.authenticate(stale.headers, 'GET', '/stream', Buffer.alloc(0), stale.requestId, 'fixture'), /session/);
    const refreshBody = Buffer.from(JSON.stringify({ requestId: randomUUID(), expectedGeneration: 1 })), refresh = f.proof(undefined, 1, 'POST', '/session', refreshBody);
    const refreshPrincipal = devices.authenticate(refresh.headers, 'POST', '/session', refreshBody, refresh.requestId, 'fixture', true);
    assert.equal(devices.refreshSession(refreshPrincipal, JSON.parse(refreshBody.toString())).generation, 1);
    assert.throws(() => devices.requireCurrent(principal), /session/);
  } finally { devices.close(); db.close(); }
});

test('reenroll and key rotation fence old sessions while preserving original descriptor evidence', () => {
  const f = fixture(), { db, devices, owner } = f;
  try {
    const first = devices.link(owner, f.enrollment().request, 'fixture');
    const oldKey = f.signing(), e = f.enrollment({ mode: 'reenroll', expectedGeneration: 1, expectedKeyRevision: 1 });
    const reenrolled = devices.link(owner, e.request, 'fixture'); assert.equal(reenrolled.data.generation, 2);
    const old = f.proof(String(first.data.deviceSession), 1, 'GET', '/stream'); assert.throws(() => devices.authenticate(old.headers, 'GET', '/stream', Buffer.alloc(0), old.requestId, 'fixture'), /session/);
    f.setSigning(generateKeyPairSync('ed25519'));
    const rotate = f.enrollment({ mode: 'rotate', expectedGeneration: 2, expectedKeyRevision: 1 });
    assert.throws(() => devices.link(owner, rotate.request, 'fixture'), /Old key/);
    const oldThumb = publicThumb(oldKey.publicKey);
    const rotated = devices.link(owner, { ...rotate.request, rotationSignature: sign(null, Buffer.from(JSON.stringify(['briefsip-device-key-transition-v1', oldThumb, rotate.body])), oldKey.privateKey).toString('base64url') }, 'fixture');
    assert.equal(rotated.data.generation, 3); assert.equal(rotated.data.keyRevision, 2);
    assert.equal(devices.enrollmentDescriptor(owner, f.command.deviceId, 1).signingPublicKey, f.encode(oldKey.publicKey));
    assert.equal(db.prepare('SELECT count(*) AS n FROM device_sessions WHERE revoked=0').get()!.n, 1);
  } finally { devices.close(); db.close(); }
});
function publicThumb(key: KeyObject) { return sha256(key.export({ type: 'spki', format: 'der' })); }

test('wait reveal transport binds signed results, bounds pending jobs and clears them on connection changes', async () => {
  const f = fixture(), { db, devices, owner } = f;
  try {
    const linked = devices.link(owner, f.enrollment().request, 'fixture'), proof = f.proof(String(linked.data.deviceSession), 1, 'GET', '/stream');
    const principal = devices.authenticate(proof.headers, 'GET', '/stream', Buffer.alloc(0), proof.requestId, 'fixture');
    let frame: { body: { jobId: string; request: WaitRevealRequest; payloadDigest: string } }, blocked = false;
    let stream = devices.openStream(principal, () => {}, value => { frame = JSON.parse(value); return !blocked; });
    const ready = () => devices.heartbeat(principal, { requestId: randomUUID(), connectionGeneration: stream.connectionGeneration, zone: 'Asia/Jakarta', zoneRevision: 1, journalWatermark: 0 }); ready();
    const request = (): WaitRevealRequest => ({ requestId: randomUUID(), waitKey: randomUUID(), sourceDeviceId: principal.deviceId, deviceGeneration: principal.generation, authorityGeneration: principal.authorityGeneration, secretGeneration: 1, ownerAccountId: owner.accountId, expiresAt: f.clock() + 60000, ephemeralPublicKey: f.encode(generateKeyPairSync('x25519').publicKey), connectionGeneration: stream.connectionGeneration });
    const complete = () => ({ requestId: frame!.body.jobId, payloadDigest: frame!.body.payloadDigest, result: { requestId: frame!.body.request.requestId, waitKey: frame!.body.request.waitKey, sourceDeviceId: principal.deviceId, deviceGeneration: principal.generation, secretGeneration: 1, expiresAt: frame!.body.request.expiresAt, iv: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.alloc(64).toString('base64url'), tag: Buffer.alloc(16).toString('base64url') } });
    const pending = devices.requestWaitReveal(request()), result = complete();
    assert.throws(() => devices.requestWaitReveal(request()), { code: 'server_capacity' });
    assert.throws(() => devices.resolveWaitReveal(principal, { ...result, payloadDigest: '0'.repeat(64) }), { code: 'wait_invalid' });
    assert.throws(() => devices.resolveWaitReveal(principal, { ...result, result: { ...result.result, requestId: randomUUID() } }), { code: 'wait_invalid' });
    devices.resolveWaitReveal(principal, result); assert.deepEqual(await pending, result.result);
    assert.throws(() => devices.resolveWaitReveal(principal, result), { code: 'wait_invalid' });
    const disconnected = assert.rejects(devices.requestWaitReveal(request()), { code: 'device_offline' });
    const delayed = complete(); stream.disconnect(); await disconnected;
    assert.throws(() => devices.resolveWaitReveal(principal, delayed), { code: 'wait_invalid' });
    assert.throws(() => devices.requestWaitReveal(request()), { code: 'device_offline' });
    stream = devices.openStream(principal, () => {}, value => { frame = JSON.parse(value); return !blocked; }); ready();
    blocked = true; await assert.rejects(devices.requestWaitReveal(request()), { code: 'device_offline' }); blocked = false;
    const failure = assert.rejects(devices.requestWaitReveal(request()), { code: 'keystore_unavailable' });
    devices.resolveWaitReveal(principal, { requestId: frame!.body.jobId, payloadDigest: frame!.body.payloadDigest, errorCode: 'keystore_unavailable' }); await failure;
    const revoked = assert.rejects(devices.requestWaitReveal(request()), { code: 'device_offline' });
    devices.revoke(owner, principal.deviceId, { requestId: randomUUID(), expectedRevision: db.prepare('SELECT revision FROM devices WHERE id=?').get(principal.deviceId)!.revision }); await revoked;
  } finally { devices.close(); db.close(); }
});

test('closed device keys, zones and signatures reject malformed or substituted enrollment', () => {
  const f = fixture(), { devices, owner, db } = f;
  try {
    for (const change of [{ zone: '+07:00' }, { zone: 'Etc/Unknown' }, { zoneRevision: 0 }, { requestedCapabilities: ['root'] }, { installationPublicKey: f.command.deviceSigningKey }, { deviceEncryptionKey: f.command.deviceSigningKey }, { deviceSigningKey: f.command.deviceSigningKey + '=' }, { extra: true }]) assert.throws(() => devices.createChallenge(owner, { ...f.command, ...change }, 'fixture'));
    f.advance(60001);
    const e = f.enrollment();
    assert.equal(e.body[10], digestCommand(['briefsip-device-capabilities-v1', ['execution']]));
    const alien = generateKeyPairSync('ed25519');
    for (const change of [{ deviceSignature: sign(null, Buffer.from(JSON.stringify(e.body)), alien.privateKey).toString('base64url') }, { descriptor: { ...e.request.descriptor, zone: 'UTC' } }, { rotationSignature: e.request.deviceSignature }]) assert.throws(() => devices.link(owner, { ...e.request, ...change }, 'fixture'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get()!.n, 0);
    f.advance(120001); assert.throws(() => devices.link(owner, e.request, 'fixture'), /Challenge/);
  } finally { devices.close(); db.close(); }
});

test('challenge hard cap, bounded cleanup and transient admission recover after expiry', () => {
  const f = fixture(), { devices, owner, db } = f;
  try {
    f.enrollment();
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<3)
      INSERT INTO link_challenges SELECT printf('00000000-0000-4000-8000-%012d',i),account,sid,installation,device,installation_thumbprint,signing_thumbprint,encryption_thumbprint,candidate_json,printf('%064d',i),expires_at,0 FROM n CROSS JOIN (SELECT * FROM link_challenges LIMIT 1)`);
    const count = () => db.prepare('SELECT count(*) AS n FROM link_challenges').get()!.n;
    assert.equal(count(), 4); assert.throws(() => devices.createChallenge(owner, { ...f.command, requestId: randomUUID() }, 'fixture'), error => error instanceof ProtocolError && error.status === 429 && Number(error.details?.retryAfterMs) > 0); assert.equal(count(), 4);
    f.advance(120001); f.enrollment(); assert.equal(count(), 1);
    for (let n = 0; n < 4; n++) { try { devices.createChallenge(owner, { ...f.command, requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID() }, 'fixture'); } catch {} }
    assert.throws(() => devices.createChallenge(owner, f.command, 'fixture'), error => error instanceof ProtocolError && error.status === 429);
    f.advance(60001);
    db.exec('DELETE FROM link_challenges');
    db.prepare('INSERT INTO link_challenges VALUES (?,?,?,?,?,?,?,?,?,?,?,0)').run(randomUUID(), owner.accountId, owner.sessionId, f.command.installationId, f.command.deviceId, 'i', 's', 'e', '{}', 'root', f.clock() - 1);
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1500)
      INSERT INTO link_challenges SELECT printf('00000000-0000-4000-8000-%012d',i),account,sid,installation,device,installation_thumbprint,signing_thumbprint,encryption_thumbprint,candidate_json,printf('%064d',i),expires_at,0 FROM n CROSS JOIN (SELECT * FROM link_challenges LIMIT 1)`);
    devices.maintain(); assert.equal(count(), 501); devices.maintain(); assert.equal(count(), 0);
    f.enrollment(); assert.equal(count(), 1);
  } finally { devices.close(); db.close(); }
});

test('proof replay guard survives skew and full nonce table refuses without mutation', () => {
  const f = fixture(), { devices, owner, db } = f;
  try {
    const linked = devices.link(owner, f.enrollment().request, 'fixture'), token = String(linked.data.deviceSession);
    const proof = f.proof(token, 1, 'GET', '/stream');
    devices.authenticate(proof.headers, 'GET', '/stream', Buffer.alloc(0), proof.requestId, 'fixture');
    f.advance(61000);
    assert.throws(() => devices.authenticate(proof.headers, 'GET', '/stream', Buffer.alloc(0), proof.requestId, 'fixture'), /Nonce/);
    f.advance(61000);
    assert.throws(() => devices.authenticate(proof.headers, 'GET', '/stream', Buffer.alloc(0), proof.requestId, 'fixture'), /session/);
    devices.maintain(); assert.equal(db.prepare('SELECT count(*) AS n FROM proof_replays').get()!.n, 0);
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4096)
      INSERT INTO proof_replays SELECT id,printf('%064d',i),${f.clock() + 60000} FROM n CROSS JOIN devices`);
    const full = f.proof(token, 1, 'GET', '/stream');
    assert.throws(() => devices.authenticate(full.headers, 'GET', '/stream', Buffer.alloc(0), full.requestId, 'fixture'), error => error instanceof ProtocolError && error.status === 429);
    assert.equal(db.prepare('SELECT count(*) AS n FROM proof_replays').get()!.n, 4096);
    f.advance(60001); devices.maintain();
    const renewed = f.proof(token, 1, 'GET', '/stream'); devices.authenticate(renewed.headers, 'GET', '/stream', Buffer.alloc(0), renewed.requestId, 'fixture');
  } finally { devices.close(); db.close(); }
});
