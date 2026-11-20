import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './test-support/database.ts';
import { sha256, digestCommand } from './shared/protocol.ts';
import { installFrozenNodeSchema } from './test-support/canonical-schema.ts';
import { descriptorBody, deviceLinkBody, deviceProofBody } from './test-support/device-protocol.ts';
import { startApp } from './test-bridge.ts';

test('signed device enrollment and heartbeat preserve challenge, key and session evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-device-evidence-'));
  const database = join(dir, 'canonical.sqlite'), now = Date.now();
  const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = {
    secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture',
    issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://minarbot.example',
    development: true, jwtKey: jwt.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const accountId = randomUUID(), sub = 'user_device_evidence', sid = 'sess_device_evidence';
  const stream = new AbortController();
  let clock = now, app: Awaited<ReturnType<typeof startApp>>;
  const db = testDatabase(database);
  t.after(async () => {
    stream.abort();
    await app?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  installFrozenNodeSchema(db);
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(accountId, auth.issuer, sub, now);

  app = await startApp({ database, auth, fixedClock: clock });
  async function restart(at: number) {
    await app.close();
    clock = at;
    app = await startApp({ database, auth, fixedClock: clock });
  }
  function headers(requestId: string) {
    return { Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': requestId };
  }
  async function human<T extends { requestId: string }>(path: string, value: T, status: number) {
    const claims = { iss: auth.issuer, sub, sid, azp: auth.origin, exp: Math.floor(clock / 1000) + 60, nbf: Math.floor(clock / 1000) - 1 };
    const unsigned = [JSON.stringify({ alg: 'RS256' }), JSON.stringify(claims)].map(part => Buffer.from(part).toString('base64url')).join('.');
    const token = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), jwt.privateKey).toString('base64url');
    const response = await fetch(app.origin + path, {
      method: 'POST', headers: { ...headers(value.requestId), Authorization: 'Bearer ' + token }, body: JSON.stringify(value),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  const installation = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const originalKey = generateKeyPairSync('ed25519');
  const der = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });
  const newCandidate = {
    requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(), mode: 'new' as const,
    installationPublicKey: der(installation.publicKey).toString('base64url'),
    deviceSigningKey: der(originalKey.publicKey).toString('base64url'),
    deviceEncryptionKey: der(encryption.publicKey).toString('base64url'),
    deviceLabel: 'Home', requestedCapabilities: ['execution'], zone: 'Asia/Jakarta', zoneRevision: 1,
  };
  const devicePath = `/api/devices/${newCandidate.deviceId}`;
  const challengePath = '/api/devices/link-challenges', linkPath = '/api/devices/link';

  async function enrollment(mode: 'new' | 'reenroll' | 'rotate', key = originalKey, expectedGeneration = 0) {
    const candidate = {
      ...newCandidate, requestId: randomUUID(), mode, deviceSigningKey: der(key.publicKey).toString('base64url'),
      ...(mode === 'new' ? {} : { expectedGeneration, expectedKeyRevision: 1, zone: 'UTC', zoneRevision: 2 }),
    };
    const challenge = (await human(challengePath, candidate, 201)).data;
    const body = deviceLinkBody(candidate, challenge), bytes = Buffer.from(JSON.stringify(body));
    const descriptor = {
      v: 1 as const, accountId, installationId: candidate.installationId, deviceId: candidate.deviceId,
      authorityGeneration: challenge.authorityGeneration, deviceGeneration: challenge.deviceGeneration,
      keyRevision: challenge.keyRevision, zone: candidate.zone, zoneRevision: candidate.zoneRevision,
      signingPublicKey: candidate.deviceSigningKey, encryptionPublicKey: candidate.deviceEncryptionKey,
    };
    const request = {
      requestId: randomUUID(), challengeId: challenge.challengeId, nonce: challenge.nonce,
      installationSignature: sign(null, bytes, installation.privateKey).toString('base64url'),
      deviceSignature: sign(null, bytes, key.privateKey).toString('base64url'),
      descriptor: { ...descriptor, signature: sign(null, Buffer.from(JSON.stringify(descriptorBody(descriptor))), key.privateKey).toString('base64url') },
    };
    return { body, bytes, request, challenge };
  }

  const invalidCandidates = [
    [{ zone: '+07:00' }, 400], [{ zone: 'Etc/Unknown' }, 400], [{ zoneRevision: 0 }, 400],
    [{ requestedCapabilities: ['root'] }, 422], [{ installationPublicKey: newCandidate.deviceSigningKey }, 400],
    [{ deviceEncryptionKey: newCandidate.deviceSigningKey }, 400],
    [{ deviceSigningKey: newCandidate.deviceSigningKey + '=' }, 400], [{ extra: true }, 400],
  ] as const;
  for (const [index, [change, status]] of invalidCandidates.entries()) {
    if (index === 5) await restart(clock + 60001);
    await human(challengePath, { ...newCandidate, ...change, requestId: randomUUID() }, status);
  }
  await restart(clock + 60001);
  const first = await enrollment('new');
  assert.equal(first.body[10], digestCommand(['briefsip-device-capabilities-v1', ['execution']]));
  const savedChallenge = db.prepare('SELECT nonce_digest,candidate_json FROM link_challenges WHERE id=?').get(first.request.challengeId)!;
  assert.equal(savedChallenge.nonce_digest, sha256(Buffer.from(first.request.nonce, 'base64url')));
  assert(!String(savedChallenge.candidate_json).includes(first.request.nonce));

  const alien = generateKeyPairSync('ed25519');
  const invalidProofs = [
    [{ nonce: randomBytes(32).toString('base64url') }, 401],
    [{ deviceSignature: sign(null, first.bytes, alien.privateKey).toString('base64url') }, 401],
    [{ descriptor: { ...first.request.descriptor, zone: 'UTC' } }, 401],
    [{ rotationSignature: first.request.deviceSignature }, 400],
  ] as const;
  for (const [change, status] of invalidProofs) await human(linkPath, { ...first.request, ...change }, status);
  assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get()!.n, 0);
  await restart(first.challenge.expiresAt);
  assert.equal((await human(linkPath, first.request, 410)).error.code, 'challenge_expired');
  const capped = await enrollment('new');
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<3)
    INSERT INTO link_challenges SELECT printf('00000000-0000-4000-8000-%012d',i),
    account,sid,installation,device,installation_thumbprint,signing_thumbprint,encryption_thumbprint,
    candidate_json,printf('%064d',i),expires_at,0 FROM n CROSS JOIN link_challenges WHERE id=?`).run(capped.request.challengeId);
  const liveChallenges = () => db.prepare('SELECT count(*) n FROM link_challenges WHERE expires_at>?').get(clock)!.n;
  assert.equal(liveChallenges(), 4);
  const limited = await human(challengePath, { ...newCandidate, requestId: randomUUID() }, 429);
  assert.equal(limited.error.code, 'rate_limited');
  assert(limited.error.details.retryAfterMs > 0);
  assert.equal(liveChallenges(), 4);
  await restart(capped.challenge.expiresAt + 1);
  const valid = await enrollment('new');
  assert.equal(liveChallenges(), 1);
  const linked = await human(linkPath, valid.request, 201), session = linked.data.deviceSession;
  assert.equal(typeof session, 'string');
  const replay = await human(linkPath, valid.request, 200);
  assert.deepEqual(replay.data, {
    deviceId: newCandidate.deviceId, generation: 1, keyRevision: 1, descriptor: valid.request.descriptor,
  });
  assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get()!.n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_sessions').get()!.n, 1);
  const evidence = () => String(db.prepare('SELECT result_json FROM receipts WHERE request_id=?').get(valid.request.requestId)!.result_json);
  assert(!evidence().includes(session));
  assert.equal((await human(linkPath, { ...valid.request, requestId: randomUUID() }, 409)).error.code, 'challenge_used');
  for (let n = 0; n < 4; n++) {
    await human(challengePath, {
      ...newCandidate, requestId: randomUUID(), installationId: randomUUID(), deviceId: randomUUID(),
    }, 201);
  }
  assert.equal((await human(challengePath, { ...newCandidate, requestId: randomUUID() }, 429)).error.code, 'rate_limited');

  function proof<T extends { requestId: string }>(path: string, token?: string, value?: T, times: { iat?: number; exp?: number } = {}) {
    const body = value && JSON.stringify(value), requestId = value?.requestId ?? randomUUID();
    const p = {
      deviceId: newCandidate.deviceId, deviceGeneration: 1, authorityGeneration: valid.challenge.authorityGeneration,
      requestId, nonce: randomBytes(32).toString('base64url'), iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 60,
      method: body ? 'POST' : 'GET', path, bodyDigest: sha256(body ?? ''), ...times,
    };
    return {
      method: p.method, body,
      headers: {
        ...headers(requestId), ...(token ? { Authorization: 'Device ' + token } : {}),
        'X-Briefsip-Proof': JSON.stringify({ ...p, signature: sign(null, Buffer.from(JSON.stringify(deviceProofBody(p))), originalKey.privateKey).toString('base64url') }),
      },
    };
  }
  async function signed(path: string, init: RequestInit, status: number) {
    const response = await fetch(app.origin + path, init);
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }
  const streamPath = devicePath + '/stream', opened = proof(streamPath, session);
  const response = await fetch(app.origin + streamPath, { ...opened, signal: stream.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const connected = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(connected.kind, 'connected');
  assert.equal((await signed(streamPath, opened, 409)).error.code, 'proof_replayed');

  const row = () => db.prepare('SELECT status,zone,zone_revision,descriptor_json FROM devices WHERE id=?').get(newCandidate.deviceId)!;
  assert.equal(row().zone, 'Asia/Jakarta');
  assert.equal(row().zone_revision, 1);
  const path = devicePath + '/heartbeat';
  const heartbeat = { requestId: randomUUID(), connectionGeneration: connected.connectionGeneration, zone: 'Asia/Jakarta', zoneRevision: 1, journalWatermark: 0 };
  const beat = proof(path, session, heartbeat);
  await signed(path, { ...beat, body: JSON.stringify({ ...heartbeat, journalWatermark: 1 }) }, 401);
  const firstBeat = await signed(path, beat, 200);
  assert.equal(row().status, 'ready');
  assert.deepEqual(await signed(path, proof(path, session, heartbeat), 200), firstBeat);
  await signed(path, proof(path, session, { ...heartbeat, requestId: randomUUID(), zone: 'UTC' }), 409);
  await signed(path, proof(path, session, { ...heartbeat, requestId: randomUUID(), zone: 'UTC', zoneRevision: 2 }), 200);
  assert.equal(row().zone, 'UTC');
  assert.equal(JSON.parse(String(row().descriptor_json)).zone, 'Asia/Jakarta');
  const seconds = Math.floor(clock / 1000);
  await signed(streamPath, proof(streamPath, session, undefined, { iat: seconds - 120, exp: seconds - 61 }), 401);

  const refreshPath = devicePath + '/session';
  const refresh = { requestId: randomUUID(), expectedGeneration: 1 };
  const fresh = (await signed(refreshPath, proof(refreshPath, undefined, refresh), 200)).data;
  assert.equal(fresh.generation, 1);
  await signed(streamPath, proof(streamPath, session), 401);
  stream.abort();
  await reader.cancel().catch(() => {});

  const freshProof = proof(streamPath, fresh.deviceSession);
  const openedFresh = await fetch(app.origin + streamPath, freshProof);
  assert.equal(openedFresh.status, 200);
  await openedFresh.body!.cancel();
  const firstSeen = clock;
  await restart(firstSeen + 61000);
  assert.equal((await signed(streamPath, freshProof, 409)).error.code, 'proof_replayed');
  await restart(firstSeen + 122000);
  assert.equal((await signed(streamPath, freshProof, 401)).error.code, 'device_session_invalid');
  const nonceCount = () => db.prepare('SELECT count(*) n FROM proof_replays').get()!.n;
  assert.equal(nonceCount(), 0);
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4096)
    INSERT INTO proof_replays SELECT ?,printf('%064d',i),? FROM n`).run(newCandidate.deviceId, clock + 60000);
  assert.equal((await signed(streamPath, proof(streamPath, fresh.deviceSession), 429)).error.code, 'rate_limited');
  assert.equal(nonceCount(), 4096);
  await restart(clock + 60001);
  const recovered = await fetch(app.origin + streamPath, proof(streamPath, fresh.deviceSession));
  assert.equal(recovered.status, 200);
  await recovered.body!.cancel();

  const reenroll = await enrollment('reenroll', originalKey, 1);
  assert.equal((await human(linkPath, reenroll.request, 201)).data.generation, 2);
  await signed(streamPath, proof(streamPath, fresh.deviceSession), 401);
  const newKey = generateKeyPairSync('ed25519'), rotation = await enrollment('rotate', newKey, 2);
  assert.equal((await human(linkPath, rotation.request, 409)).error.code, 'old_key_unavailable');
  const transition = ['briefsip-device-key-transition-v1', sha256(der(originalKey.publicKey)), rotation.body];
  const rotated = await human(linkPath, {
    ...rotation.request, rotationSignature: sign(null, Buffer.from(JSON.stringify(transition)), originalKey.privateKey).toString('base64url'),
  }, 201);
  assert.equal(rotated.data.generation, 3);
  assert.equal(rotated.data.keyRevision, 2);
  assert.deepEqual(JSON.parse(evidence()).data.descriptor, valid.request.descriptor);
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_sessions WHERE revoked=0').get()!.n, 1);
});
