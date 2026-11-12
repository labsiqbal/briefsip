import test from 'node:test';
import assert from 'node:assert/strict';
import { createClerkClient } from '@clerk/backend';
import { generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startCanonicalApp } from './server.ts';
import { openDeviceRuntime } from './device-runtime.ts';
import type { AuthConfig } from './auth.ts';
import { ProtocolError } from './protocol.ts';
import sharp from 'sharp';

function memoryKeys() {
  const values = new Map<string, string>();
  return { values, entry(service: string, name: string) { const key = `${service}/${name}`; return { getPassword: () => values.get(key) ?? null, setPassword: (value: string) => { values.set(key, value); } }; } };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-device-http-')), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth: AuthConfig = { secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`, issuer: 'https://fixture.clerk.accounts.dev', origin: 'http://127.0.0.1', development: true };
  const clerk = createClerkClient({ secretKey: auth.secretKey, publishableKey: auth.publishableKey, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), telemetry: { disabled: true } });
  const options = { database: join(dir, 'canonical.sqlite'), auth, clerk };
  let app = await startCanonicalApp(options); auth.origin = app.origin;
  const jwt = (subject = 'user_owner') => {
    const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url'), claims = Buffer.from(JSON.stringify({ iss: auth.issuer, sub: subject, sid: `sess_${subject}`, azp: auth.origin, exp: now + 300, nbf: now - 1, iat: now - 1 })).toString('base64url');
    return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url')}`;
  };
  const send = async (path: string, body?: { requestId: string; [key: string]: unknown }, subject = 'user_owner', method = body ? 'POST' : 'GET') => {
    const response = await fetch(app.origin + path, { method, headers: { Authorization: `Bearer ${jwt(subject)}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': body?.requestId ?? randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { dir, jwt, send, origin: () => app.origin, async restart() { const port = new URL(app.origin).port; await app.close(); app = await startCanonicalApp({ ...options, port: Number(port) }); }, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Device state did not settle');
}

test('local possession gate enrolls only configured server and retains identity across reconnect/revoke', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  try {
    const link = await runtime.bootstrap(), token = readFileSync(link.tokenFile, 'utf8');
    assert.equal(statSync(link.tokenFile).mode & 0o777, 0o600);
    const local = async (headers = {}, path = '/local/link-proof', body: unknown = { requestId: randomUUID(), clerkToken: f.jwt() }) => {
      const response = await fetch(link.origin + path, { method: 'POST', headers: { Origin: link.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() };
    };
    assert.equal((await local({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await local({ Authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await local({ 'X-Forwarded-Host': 'evil.example' })).status, 403);
    assert.equal((await local({}, '/local/sign-arbitrary')).status, 403);
    const linked = await local(); assert.equal(linked.status, 200, JSON.stringify(linked.body));
    await link.close(); assert(!existsSync(link.tokenFile));
    const deviceId = runtime.deviceId(), connection = runtime.connect();
    await until(() => connection.state().phase === 'connected');
    const devices = (await f.send('/api/devices')).body.data; assert.equal(devices.length, 1); assert.equal(devices[0].id, deviceId); assert.equal(devices[0].status, 'ready');
    assert.equal((await f.send('/api/devices', undefined, 'user_foreign')).body.data.length, 0);
    const project = randomUUID(), createProject = { requestId: randomUUID(), id: project, name: 'A' };
    assert.equal((await f.send('/api/projects', createProject)).status, 201);
    const id = randomUUID(), createAgent = { requestId: id, id, name: 'Remote', model: 'fixture', backupModel: '', instructions: 'Help with research', threadLimit: 2, projectId: project, homeDeviceId: deviceId, expectedProjectRevision: 1, expectedHomeDeviceRevision: devices[0].revision, providerBinding: null, setup: false };
    assert.equal((await f.send('/api/agents', createAgent)).status, 201);
    assert.equal((await f.send('/api/agents', createAgent)).status, 200);
    const avatar = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const avatarId = randomUUID(), avatarCommand = { ...createAgent, requestId: avatarId, id: avatarId, avatar: avatar.toString('base64') };
    assert(Buffer.byteLength(JSON.stringify(avatarCommand)) > 65536);
    assert.equal((await f.send('/api/agents', avatarCommand)).status, 201);
    assert.equal((await f.send('/api/agents', { ...avatarCommand, avatar: 'a'.repeat(750000) })).status, 413);

    assert.equal((await f.send(`/api/projects/${project}/agents/${id}/rules`, { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'A only' }, 'user_owner', 'PUT')).status, 200);
    assert.equal((await f.send(`/api/projects/${project}/agents/${id}/capabilities`, { requestId: randomUUID(), expectedRevision: 2, capabilities: { v: 1, tools: [], resources: [] } }, 'user_owner', 'PUT')).status, 200);
    await connection.stop(); await runtime.close();
    await f.restart(); runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    assert.equal(runtime.deviceId(), deviceId);
    const resumed = runtime.connect(); await until(() => resumed.state().phase === 'connected');
    const current = (await f.send('/api/devices')).body.data[0];
    assert.equal((await f.send(`/api/devices/${deviceId}/revoke`, { requestId: randomUUID(), expectedRevision: current.revision })).status, 200);
    await until(() => resumed.state().phase === 'blocked'); assert.equal(resumed.state().lastFailure?._tag, 'ConnectionBlockedError');
    const canonical = new DatabaseSync(join(f.dir, 'canonical.sqlite')), device = new DatabaseSync(database);
    try {
      assert.equal(device.prepare("SELECT name FROM sqlite_schema WHERE name='accounts'").get(), undefined);
      assert.equal(canonical.prepare("SELECT name FROM sqlite_schema WHERE name='device_state'").get(), undefined);
      assert.equal(canonical.prepare('SELECT count(*) AS n FROM device_sessions WHERE revoked=0').get()!.n, 0);
      const publicMetadata = readFileSync(`${database}.host/identity.json`, 'utf8');
      for (const secret of store.values.values()) assert(!publicMetadata.includes(secret));
    } finally { canonical.close(); device.close(); }
  } finally { await runtime.close(); await f.close(); }
});

test('device key loss fails closed and concurrent stream replacement fences old heartbeat', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  try {
    await runtime.enroll(f.jwt());
    await runtime.close();
    assert.throws(() => openDeviceRuntime({ database, server: f.origin(), development: true, entry: () => ({ getPassword() { return null; }, setPassword() { assert.fail('Must not replace missing identity key'); } }) }), error => error instanceof ProtocolError && error.code === 'device_key_unavailable');
    runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    const first = runtime.connect(); await until(() => first.state().phase === 'connected');
    const secondRuntime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    try {
      const second = secondRuntime.connect(); await until(() => second.state().phase === 'connected');
      await until(() => first.state().phase !== 'connected'); await first.stop();
      const current = (await f.send('/api/devices')).body.data[0]; assert.equal(current.status, 'ready'); assert(current.connection_generation >= 2);
      await second.stop();
    } finally { await secondRuntime.close(); }
  } finally { await runtime.close(); await f.close(); }
});

test('lost enrollment ACK resumes same request and explicit reenroll/rotation preserve home identity', async () => {
  const f = await fixture(), store = memoryKeys(), database = join(f.dir, 'device.sqlite');
  let runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
  const originalFetch = globalThis.fetch; let drop = true;
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (drop && String(input) === f.origin() + '/api/devices/link') { drop = false; await response.body?.cancel(); throw new Error('Synthetic lost enrollment ACK'); }
      return response;
    };
    await assert.rejects(runtime.enroll(f.jwt()), /lost enrollment ACK/);
    const pending = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8')).pending;
    const linked = await runtime.enroll(f.jwt()); assert.equal(linked.generation, 1);
    const canonical = new DatabaseSync(join(f.dir, 'canonical.sqlite'));
    try {
      assert.equal(canonical.prepare('SELECT count(*) AS n FROM devices').get()!.n, 1);
      assert.equal(canonical.prepare("SELECT count(*) AS n FROM receipts WHERE scope='device_enrollment'").get()!.n, 1);
      assert.equal(canonical.prepare('SELECT request_id FROM receipts WHERE request_id=?').get(pending.request.requestId)!.request_id, pending.request.requestId);
    } finally { canonical.close(); }
    const home = runtime.deviceId();
    const reenrolled = await runtime.enroll(f.jwt(), 'reenroll'); assert.equal(reenrolled.deviceId, home); assert.equal(reenrolled.generation, 2);
    const before = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8'));
    const rotated = await runtime.enroll(f.jwt(), 'rotate'); assert.equal(rotated.deviceId, home); assert.equal(rotated.generation, 3);
    const after = JSON.parse(readFileSync(`${database}.host/identity.json`, 'utf8')); assert.notEqual(after.signingRef, before.signingRef); assert.equal(after.descriptor.keyRevision, 2);
    assert([...store.values.keys()].some(key => key.endsWith('/' + before.signingRef)));
    await runtime.close(); runtime = openDeviceRuntime({ database, server: f.origin(), development: true, entry: store.entry });
    const connection = runtime.connect(); await until(() => connection.state().phase === 'connected');
  } finally { globalThis.fetch = originalFetch; await runtime.close(); await f.close(); }
});
