import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { testDatabase } from '../test-support/database.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ProtocolError } from '../shared/protocol.ts';
import { initializeHubSchema, fenceRestoredHub, activateRestoredHub } from './schema.ts';
import { createHubAuthority } from './project-authority.ts';
import { createClerkVerifier, createStubVerifier, type SessionIdentity, type SessionVerifier } from './sessions.ts';
import { createHubServer, startHub } from './server.ts';

const accounts = 'accounts.briefsip.test', issuer = 'https://clerk.example.test';
const origin = (host: string) => `https://${host}`;
type Response = { status: number; headers: IncomingMessage['headers']; data: any; raw: string; cookies: string[] };
async function fixture(t: TestContext, settings: { verifier?: SessionVerifier; trusted?: string[]; dbPath?: string } = {}) {
  let clock = Date.now();
  const now = () => clock, db = testDatabase(settings.dbPath ?? ':memory:'); initializeHubSchema(db);
  const authority = createHubAuthority(db, { domain: 'briefsip.test', mailboxKey: Buffer.alloc(32, 8), now });
  const identities = Object.fromEntries(['alice', 'bob', 'eve', 'outside'].map(subject => [subject, { issuer, subject, sessionId: `${subject}-sid`, expiresAt: now() + 3600000, verifiedMailboxes: [`${subject}@example.test`] } satisfies SessionIdentity]));
  const ids = Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, authority.provisionAccount(identity, name !== 'outside')]));
  const alpha = authority.createProject(ids.alice, 'alpha', 'Alpha'), beta = authority.createProject(ids.bob, 'beta', 'Beta');
  const ctx = authority.resolveProject(alpha.host, ids.alice);
  const invitation = authority.invite(ctx, { mailbox: 'bob@example.test', role: 'member', expiresAt: now() + 100000 });
  authority.acceptInvite(authority.resolveProject(alpha.host, ids.bob), invitation.invitationId, invitation.token, identities.bob);
  const hub = createHubServer({ authority, verifier: settings.verifier ?? createStubVerifier(new Map(Object.entries(identities))), domain: 'briefsip.test', accountsHost: accounts, pollIntervalMs: 10, trustedGatewayAddresses: settings.trusted });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const address = hub.server.address(); assert(address && typeof address !== 'string'); const port = address.port;
  t.after(async () => { await hub.close(); if (db.isOpen) db.close(); });
  function request(host: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown; rawBody?: string; cookies?: string[]; csrf?: string; origin?: string | null } = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const method = options.method ?? (options.body !== undefined || options.rawBody !== undefined ? 'POST' : 'GET');
      const headers: Record<string, string> = { Host: host, ...options.headers };
      if (options.cookies) headers.Cookie = options.cookies.join('; ');
      if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
      if (options.origin !== null && (method !== 'GET' || options.origin)) headers.Origin = options.origin ?? origin(host);
      if (options.body !== undefined || options.rawBody !== undefined) headers['Content-Type'] ??= 'application/json';
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => raw += chunk); res.on('end', () => {
          let data: unknown; try { data = JSON.parse(raw); } catch { data = undefined; }
          resolve({ status: res.statusCode!, headers: res.headers, data, raw, cookies: (res.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]) });
        });
      });
      req.on('error', reject); req.end(options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined));
    });
  }
  async function central(subject = 'alice') {
    const bootstrap = await request(accounts, '/auth/bootstrap'); assert.equal(bootstrap.status, 200);
    const result = await request(accounts, '/auth/session', { body: {}, cookies: bootstrap.cookies, csrf: bootstrap.data.csrf, headers: { Authorization: `Bearer ${subject}` } });
    assert.equal(result.status, 200, result.raw); return result;
  }
  async function start(host = alpha.host) { const result = await request(host, '/auth/start'); assert.equal(result.status, 200); return result; }
  async function handoff(login: Response, started: Response) {
    const result = await request(accounts, '/auth/handoff', { body: { state: started.data.state }, cookies: login.cookies, csrf: login.data.csrf });
    assert.equal(result.status, 200, result.raw); const url = new URL(result.data.callback), fragment = new URLSearchParams(url.hash.slice(1));
    return { state: fragment.get('state'), code: fragment.get('code') };
  }
  async function redeem(host: string, started: Response, code: unknown, cookies = started.cookies) {
    return request(host, '/auth/redeem', { body: code, cookies, csrf: started.data.state });
  }
  async function login(subject = 'alice', host = alpha.host, parent?: Response) {
    const centralSession = parent ?? await central(subject), started = await start(host), code = await handoff(centralSession, started);
    const result = await redeem(host, started, code); assert.equal(result.status, 200, result.raw); return result;
  }
  async function stream(session: Response, host = alpha.host, sectionId = alpha.sectionId) {
    const req = httpRequest({ host: '127.0.0.1', port, path: `/api/events?sectionId=${sectionId}`, headers: { Host: host, Cookie: session.cookies.join('; ') } });
    const response = new Promise<IncomingMessage>((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
    req.end(); const res = await response; assert.equal(res.statusCode, 200); res.resume();
    const closed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('SSE did not close')), 2000); res.on('end', () => { clearTimeout(timer); resolve(); }); res.on('close', () => { clearTimeout(timer); resolve(); }); });
    t.after(() => req.destroy()); return { res, closed };
  }
  async function raw(headers: string, path = '/api/project') {
    const socket = connect(port, '127.0.0.1'); await once(socket, 'connect'); let result = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => result += chunk); socket.end(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`); await once(socket, 'close'); return result;
  }
  return { db, authority, hub, ids, identities, alpha, beta, ctx, request, central, start, handoff, redeem, login, stream, raw, advance(ms: number) { clock += ms; }, now };
}

test('gateway: raw Host allowlist, reserved names, duplicates, aliases, uniform missing and forwarded-host denial', async t => {
  const f = await fixture(t);
  const unknown = await f.request('missing.briefsip.test', '/api/project'); assert.equal(unknown.status, 404);
  for (const host of ['briefsip.test', 'www.briefsip.test', 'api.briefsip.test', 'ALPHA.briefsip.test', 'alpha.briefsip.test.', 'alpha.briefsip.test:443', 'alpha.briefsip.test.evil.test', 'xn--abc.briefsip.test', 'hub-origin.briefsip.test']) {
    const result = await f.request(host, '/api/project'); assert.equal(result.status, 404, host); assert.deepEqual(result.data, unknown.data);
  }
  for (const headers of [{ 'X-Forwarded-Host': f.beta.host }, { Forwarded: `host=${f.beta.host}` }, { 'X-Forwarded-Host': `${f.alpha.host},${f.beta.host}` }] as Record<string, string>[]) assert.equal((await f.request(f.alpha.host, '/auth/start', { headers })).status, 404);
  assert.match(await f.raw(`Host: ${f.alpha.host}\r\nHost: ${f.beta.host}`), /^HTTP\/1.1 404/);
  assert.match(await f.raw(''), /^HTTP\/1.1 400/);
  assert.equal(Object.isFrozen(f.hub.gateway.project(f.alpha.host, f.ids.alice)), true);
});

test('gateway: forwarded Host works only for configured exact gateway address; no forwarded chain', async t => {
  const f = await fixture(t, { trusted: ['127.0.0.1'] });
  assert.equal((await f.request('internal.example.test', '/auth/start', { headers: { 'X-Forwarded-Host': f.alpha.host } })).status, 200);
  assert.equal((await f.request('internal.example.test', '/auth/start', { headers: { 'X-Forwarded-Host': `${f.alpha.host}, ${f.beta.host}` } })).status, 404);
  assert.equal((await f.request('internal.example.test', '/auth/start', { headers: { Forwarded: `host=${f.alpha.host}` } })).status, 404);
});

test('handoff: browser-bound, wrong host does not consume, single use with one concurrent winner', async t => {
  const f = await fixture(t), parent = await f.central(), started = await f.start(), code = await f.handoff(parent, started);
  const foreignBrowser = await f.start();
  assert.equal((await f.redeem(f.alpha.host, started, code, foreignBrowser.cookies)).status, 401);
  assert.equal((await f.redeem(f.beta.host, started, code)).status, 401);
  const results = await Promise.all([f.redeem(f.alpha.host, started, code), f.redeem(f.alpha.host, started, code)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const session = results.find(result => result.status === 200)!;
  for (const header of session.headers['set-cookie']!) {
    assert.match(header, /^__Host-/); assert.match(header, /; Secure; HttpOnly; SameSite=Lax; Max-Age=/); assert(!header.includes('Domain='));
  }
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: session.cookies })).status, 200);
  assert.equal((await f.request(f.beta.host, '/api/session', { cookies: session.cookies })).status, 401);
  assert.equal((await f.request(accounts, '/api/session', { cookies: session.cookies })).status, 401);
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: parent.cookies })).status, 401);
});

test('handoff: 60-second code, five-minute state, replacement and token expiry bound every session', async t => {
  const f = await fixture(t), parent = await f.central(), started = await f.start(), first = await f.handoff(parent, started), second = await f.handoff(parent, started);
  assert.equal((await f.redeem(f.alpha.host, started, first)).status, 401);
  f.advance(60000); assert.equal((await f.redeem(f.alpha.host, started, second)).status, 401);
  f.advance(240000);
  assert.equal((await f.request(accounts, '/auth/handoff', { body: { state: started.data.state }, cookies: parent.cookies, csrf: parent.data.csrf })).status, 401);
  const shortIdentity = { ...f.identities.alice, expiresAt: Date.now() + 20000 };
  const short = await fixture(t, { verifier: { async verify() { return shortIdentity; } } });
  const central = await short.central(); assert(central.data.expiresAt <= Date.now() + 20000);
  const session = await short.login('alice', short.alpha.host, central); assert.equal(session.data.expiresAt, central.data.expiresAt);
  assert.match(session.headers['set-cookie']![0], /Max-Age=(?:19|20)$/);
  short.advance(21000); assert.equal((await short.request(short.alpha.host, '/api/session', { cookies: session.cookies })).status, 401);
});

test('session: central bootstrap proof, exact Origin, session CSRF and duplicate cookies/JSON rejected', async t => {
  const f = await fixture(t), bootstrap = await f.request(accounts, '/auth/bootstrap');
  assert.equal((await f.request(accounts, '/auth/session', { body: {}, headers: { Authorization: 'Bearer alice' }, cookies: bootstrap.cookies })).status, 403);
  assert.equal((await f.request(accounts, '/auth/session', { body: {}, headers: { Authorization: 'Bearer alice' }, cookies: bootstrap.cookies, csrf: bootstrap.data.csrf, origin: origin(f.alpha.host) })).status, 403);
  const session = await f.login();
  for (const originValue of [null, 'null', origin(f.beta.host), 'https://evil.test']) {
    assert.equal((await f.request(f.alpha.host, '/api/sections', { body: { name: 'Design' }, cookies: session.cookies, csrf: session.data.csrf, origin: originValue })).status, 403);
  }
  assert.equal((await f.request(f.alpha.host, '/api/sections', { body: { name: 'Design' }, cookies: session.cookies })).status, 403);
  assert.equal((await f.request(f.alpha.host, '/api/sections', { rawBody: '{"name":"A","name":"B"}', cookies: session.cookies, csrf: session.data.csrf })).status, 400);
  assert.equal((await f.request(f.alpha.host, '/api/sections', { body: { name: 'Design' }, cookies: session.cookies, csrf: session.data.csrf, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: [...session.cookies, session.cookies[0]] })).status, 401);
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: session.cookies, origin: origin(f.beta.host) })).status, 403);
  assert.equal((await f.request(f.alpha.host, '/api/sections', { body: { name: 'Design' }, cookies: session.cookies, csrf: session.data.csrf })).status, 200);
});

test('HTTP authority: Eve, foreign IDs and principal overrides denied; role checked on every request', async t => {
  const f = await fixture(t), eve = await f.login('eve'), alice = await f.login(), bob = await f.login('bob');
  assert.equal((await f.request(f.alpha.host, '/api/project', { cookies: eve.cookies })).status, 404);
  assert.equal((await f.request(f.alpha.host, `/api/history?sectionId=${f.beta.sectionId}`, { cookies: alice.cookies })).status, 404);
  assert.equal((await f.request(f.alpha.host, `/api/events?sectionId=${f.beta.sectionId}`, { cookies: alice.cookies })).status, 404);
  assert.equal((await f.request(f.alpha.host, `/api/turn?turnId=${randomUUID()}`, { cookies: alice.cookies })).status, 404);
  assert.equal((await f.request(f.alpha.host, '/api/messages', { body: { requestId: randomUUID(), sectionId: f.beta.sectionId, text: 'Foreign', mentions: [] }, cookies: alice.cookies, csrf: alice.data.csrf })).status, 404);
  assert.equal((await f.request(f.alpha.host, '/api/messages', { body: { requestId: randomUUID(), sectionId: f.alpha.sectionId, text: 'Forged', mentions: [], accountId: f.ids.bob }, cookies: alice.cookies, csrf: alice.data.csrf })).status, 400);
  assert.equal((await f.request(f.alpha.host, '/api/sections', { body: { name: 'Forbidden' }, cookies: bob.cookies, csrf: bob.data.csrf })).status, 403);
  f.authority.editMember(f.ctx, f.ids.bob, 1, 'viewer');
  assert.equal((await f.request(f.alpha.host, '/api/messages', { body: { requestId: randomUUID(), sectionId: f.alpha.sectionId, text: 'Denied', mentions: [] }, cookies: bob.cookies, csrf: bob.data.csrf })).status, 403);
  assert.equal((await f.request(f.alpha.host, '/api/history?sectionId=' + f.alpha.sectionId, { cookies: bob.cookies })).status, 200);
  f.authority.editMember(f.ctx, f.ids.bob, 2, 'revoked');
  assert.equal((await f.request(f.alpha.host, '/api/project', { cookies: bob.cookies })).status, 404);
});

test('SSE: removal closes affected stream, unrelated project stays open; account block closes every stream', async t => {
  const f = await fixture(t), parent = await f.central('bob'), alpha = await f.login('bob', f.alpha.host, parent), beta = await f.login('bob', f.beta.host, parent);
  const affected = await f.stream(alpha), unaffected = await f.stream(beta, f.beta.host, f.beta.sectionId);
  assert.equal(affected.res.headers['cache-control'], 'no-store'); assert.equal(affected.res.headers['access-control-allow-origin'], undefined);
  f.authority.editMember(f.ctx, f.ids.bob, 1, 'revoked'); await affected.closed;
  assert.equal(unaffected.res.readableEnded, false);
  f.authority.setAccountStatus(f.ids.bob, 'blocked'); await unaffected.closed;
});

test('SSE: verified expiry and restore generation close live streams and invalidate handoffs', async t => {
  const f = await fixture(t), parent = await f.central(), session = await f.login('alice', f.alpha.host, parent), stream = await f.stream(session);
  const started = await f.start(), code = await f.handoff(parent, started);
  const generation = fenceRestoredHub(f.db); activateRestoredHub(f.db, generation); await stream.closed;
  assert.equal((await f.redeem(f.alpha.host, started, code)).status, 401);
  const fresh = await f.login(), expires = await f.stream(fresh); f.advance(900001); await expires.closed;
});

test('logout: host-only versus global, browser sessions/codes/streams revoked, durable sid denial rejects fresh tokens', async t => {
  const f = await fixture(t), parent = await f.central('bob'), alpha = await f.login('bob', f.alpha.host, parent), beta = await f.login('bob', f.beta.host, parent);
  assert.equal((await f.request(f.alpha.host, '/auth/logout', { body: { global: false }, cookies: alpha.cookies, csrf: alpha.data.csrf })).data.state, 'host_revoked');
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: alpha.cookies })).status, 401);
  assert.equal((await f.request(f.beta.host, '/api/session', { cookies: beta.cookies })).status, 200);
  const stream = await f.stream(beta, f.beta.host, f.beta.sectionId), started = await f.start(), code = await f.handoff(parent, started);
  const logout = await f.request(accounts, '/auth/logout', { body: { global: true }, cookies: parent.cookies, csrf: parent.data.csrf });
  assert.equal(logout.data.state, 'upstream_pending'); await stream.closed;
  assert.equal((await f.redeem(f.alpha.host, started, code)).status, 401);
  assert.equal((await f.request(f.beta.host, '/api/session', { cookies: beta.cookies })).status, 401);
  const bootstrap = await f.request(accounts, '/auth/bootstrap');
  assert.equal((await f.request(accounts, '/auth/session', { body: {}, cookies: bootstrap.cookies, csrf: bootstrap.data.csrf, headers: { Authorization: 'Bearer bob' } })).status, 401);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_browser_denials').get()!.n, 1);
});

test('hub routes: local-owner APIs denied on all hosts, no CORS, cache isolation and callback fragment policy', async t => {
  const f = await fixture(t);
  for (const host of [accounts, f.alpha.host, f.beta.host]) for (const path of ['/mcp', '/api/agents', '/api/settings', '/api/files', '/api/computer', '/api/releases', '/api/providers', '/api/update', '/api/machines', '/node', '/']) {
    const response = await f.request(host, path); assert.equal(response.status, 404, `${host}${path}`); assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const host of [accounts, f.alpha.host, f.beta.host]) assert.equal((await f.request(host, `/api/agents/${randomUUID()}/delete`, { body: { id: randomUUID() } })).status, 404);
  assert.equal((await f.request(f.alpha.host, '/api/project', { method: 'OPTIONS', origin: origin(f.beta.host) })).status, 404);
  const callback = await f.request(f.alpha.host, '/auth/callback');
  assert.equal(callback.headers['referrer-policy'], 'no-referrer'); assert.equal(callback.headers['cache-control'], 'no-store');
  assert.match(String(callback.headers['content-security-policy']), /script-src 'sha256-/); assert.match(callback.raw, /history.replaceState/); assert(!callback.raw.includes('<script src='));
  assert.equal((await f.request(f.alpha.host, '/auth/redeem?code=leak', { body: {}, csrf: 'x' })).status, 401);
});

test('P1-C mount hook: only exact central /node upgrades, no browser credentials; unmounted fails closed', async t => {
  const f = await fixture(t); let calls = 0;
  async function upgrade(host: string, path = '/node', extra = '') {
    return f.raw(`Host: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade${extra}`, path);
  }
  assert.match(await upgrade(accounts), /^HTTP\/1.1 404/);
  const unmount = f.hub.mountNodeUpgrade((_request, socket, _head, context) => { calls++; assert.equal(context.host, accounts); assert.equal(context.authority, f.authority); assert(Object.isFrozen(context)); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  assert.throws(() => f.hub.mountNodeUpgrade(() => {}), /already/);
  assert.match(await upgrade(f.alpha.host), /^HTTP\/1.1 404/);
  assert.match(await upgrade(accounts, '/node?token=leak'), /^HTTP\/1.1 404/);
  assert.match(await upgrade(accounts, '/node', '\r\nOrigin: https://accounts.briefsip.test'), /^HTTP\/1.1 404/);
  assert.match(await upgrade(accounts, '/node', '\r\nCookie: __Host-session=leak'), /^HTTP\/1.1 404/);
  assert.match(await upgrade(accounts), /^HTTP\/1.1 401/); assert.equal(calls, 1);
  unmount(); assert.match(await upgrade(accounts), /^HTTP\/1.1 404/);
});

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: jwk.kid }, privateKey = rsa.privateKey) {
  const body = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
const jwtNow = 1800000000000;
const claims = { iss: issuer, sub: 'alice', sid: 'session-alice', azp: origin(accounts), iat: jwtNow / 1000 - 5, nbf: jwtNow / 1000 - 5, exp: jwtNow / 1000 + 60, aud: 'briefsip-hub', email: 'alice@example.test', email_verified: true };
function clerk() { return createClerkVerifier({ issuer, accountsOrigin: origin(accounts), audience: 'briefsip-hub', jwks: { keys: [jwk] }, now: () => jwtNow }); }

test('offline Clerk fixtures: valid RS256/JWKS, verified mailbox evidence and audience array', async () => {
  const verifier = clerk(), result = await verifier.verify(jwt(claims));
  assert.deepEqual(result, { issuer, subject: 'alice', sessionId: 'session-alice', expiresAt: jwtNow + 60000, verifiedMailboxes: ['alice@example.test'] });
  assert.equal((await verifier.verify(jwt({ ...claims, aud: ['other', 'briefsip-hub'] }))).subject, 'alice');
  assert.deepEqual((await verifier.verify(jwt({ ...claims, email_verified: false }))).verifiedMailboxes, []);
});

test('offline Clerk fixtures: expiry, issuer, azp, audience, time, sid, pending session and signature failures', async () => {
  const verifier = clerk();
  for (const changed of [{ exp: jwtNow / 1000 }, { iss: 'https://other.example.test' }, { azp: origin('alpha.briefsip.test') }, { aud: 'wrong' }, { aud: undefined }, { nbf: jwtNow / 1000 + 1 }, { iat: jwtNow / 1000 + 1 }, { sid: '' }, { sub: '' }, { sts: 'pending' }, { exp: '1800000060' }, { nbf: undefined }]) {
    await assert.rejects(verifier.verify(jwt({ ...claims, ...changed })), error => error instanceof ProtocolError && error.status === 401, JSON.stringify(changed));
  }
  await assert.rejects(verifier.verify(jwt(claims, { alg: 'HS256', kid: jwk.kid })), /invalid/);
  await assert.rejects(verifier.verify(jwt(claims, { alg: 'RS256', kid: 'unknown' })), /invalid/);
  await assert.rejects(verifier.verify(jwt(claims, { alg: 'RS256', kid: jwk.kid, crit: ['foo'] })), /invalid/);
  await assert.rejects(verifier.verify(jwt(claims, undefined, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)), /invalid/);
  await assert.rejects(verifier.verify('not-a-jwt'), /invalid/);
  const duplicate = Buffer.from('{"iss":"https://clerk.example.test","iss":"other"}').toString('base64url');
  await assert.rejects(verifier.verify(`${jwt(claims).split('.')[0]}.${duplicate}.eA`), /invalid/);
});

test('offline Clerk config: HTTPS, key type, modulus, key IDs and no private JWKS', () => {
  assert.throws(() => createClerkVerifier({ issuer, accountsOrigin: 'http://accounts.briefsip.test', jwks: { keys: [jwk] } }));
  assert.throws(() => createClerkVerifier({ issuer, accountsOrigin: origin(accounts), jwks: { keys: [jwk, jwk] } }));
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  assert.throws(() => createClerkVerifier({ issuer, accountsOrigin: origin(accounts), jwks: { keys: [{ ...weak, kid: 'weak' }] } }));
  assert.throws(() => createClerkVerifier({ issuer, accountsOrigin: origin(accounts), jwks: { keys: [{ ...jwk, d: 'private' }] } }));
});

test('real HTTP Clerk adapter: only central verified bearer admitted; token expiry bounds project cookie', async t => {
  const actual = Math.floor(Date.now() / 1000), verifier = createClerkVerifier({ issuer, accountsOrigin: origin(accounts), audience: 'briefsip-hub', jwks: { keys: [jwk] } });
  const f = await fixture(t, { verifier }), token = jwt({ ...claims, sid: 'alice-sid', iat: actual - 1, nbf: actual - 1, exp: actual + 60 });
  const central = await f.central(token), session = await f.login('alice', f.alpha.host, central);
  assert.equal(session.data.expiresAt, (actual + 60) * 1000);
  assert.equal((await f.request(f.alpha.host, '/api/project', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const boot = await f.request(accounts, '/auth/bootstrap');
  assert.equal((await f.request(accounts, '/auth/session', { body: {}, cookies: boot.cookies, csrf: boot.data.csrf, headers: { Authorization: `Bearer ${jwt({ ...claims, sub: 'outside', iat: actual, nbf: actual, exp: actual + 60 })}` } })).status, 401);
});

test('documented starter: explicit isolated config, loopback binding, no automatic account provisioning', async t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'briefsip-hub-start-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = resolve(dir, 'mailbox.key'), tokens = resolve(dir, 'tokens.json'), db = resolve(dir, 'pilot.sqlite');
  writeFileSync(key, randomBytes(32), { mode: 0o600 }); writeFileSync(tokens, '{}', { mode: 0o600 });
  const hub = startHub({ domain: 'briefsip.test', accountsHost: accounts, dataPath: db, mailboxKeyPath: key, port: 0, identity: { mode: 'stub', tokensPath: tokens } });
  await once(hub.server, 'listening'); const address = hub.server.address(); assert(address && typeof address !== 'string'); assert.equal(address.address, '127.0.0.1');
  assert.equal(hub.authority.one('SELECT count(*) AS n FROM accounts')!.n, 0);
  await hub.close(); assert(readFileSync(db).length > 0);
});

test('session rotation and SQLite reopen preserve sessions/denials without replaying handoffs', async t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'briefsip-hub-reopen-')), file = resolve(dir, 'hub.sqlite');
  const f = await fixture(t, { dbPath: file }), parent = await f.central(), first = await f.login('alice', f.alpha.host, parent);
  const started = await f.start(), code = await f.handoff(parent, started);
  const rotated = await f.request(f.alpha.host, '/auth/redeem', { body: code, cookies: [...started.cookies, first.cookies[0]], csrf: started.data.state });
  assert.equal(rotated.status, 200);
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: first.cookies })).status, 401);
  assert(!f.authority.all('SELECT digest FROM hub_browser_sessions').some(row => rotated.cookies[0].endsWith(String(row.digest))));
  const address = f.hub.server.address(); assert(address && typeof address !== 'string'); await f.hub.close(); f.db.close();
  let database = testDatabase(file);
  let authority = createHubAuthority(database, { domain: 'briefsip.test', mailboxKey: Buffer.alloc(32, 8), now: f.now });
  let reopened = createHubServer({ authority, verifier: createStubVerifier(new Map(Object.entries(f.identities))), accountsHost: accounts, domain: 'briefsip.test' });
  t.after(async () => { await reopened.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });
  reopened.server.listen(address.port, '127.0.0.1'); await once(reopened.server, 'listening');
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: rotated.cookies })).status, 200);
  assert.equal((await f.redeem(f.alpha.host, started, code)).status, 401);
  assert.equal((await f.request(accounts, '/auth/logout', { body: { global: true }, cookies: parent.cookies, csrf: parent.data.csrf })).status, 200);
  await reopened.close(); database.close(); database = testDatabase(file);
  authority = createHubAuthority(database, { domain: 'briefsip.test', mailboxKey: Buffer.alloc(32, 8), now: f.now });
  reopened = createHubServer({ authority, verifier: createStubVerifier(new Map(Object.entries(f.identities))), accountsHost: accounts, domain: 'briefsip.test' });
  reopened.server.listen(address.port, '127.0.0.1'); await once(reopened.server, 'listening');
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: rotated.cookies })).status, 401);
  const bootstrap = await f.request(accounts, '/auth/bootstrap');
  assert.equal((await f.request(accounts, '/auth/session', { body: {}, cookies: bootstrap.cookies, csrf: bootstrap.data.csrf, headers: { Authorization: 'Bearer alice' } })).status, 401);
  assert.equal(authority.one('SELECT count(*) AS n FROM hub_browser_denials')!.n, 1);
});

test('async JSON mutation rechecks current membership after slow request body', async t => {
  const f = await fixture(t), session = await f.login('bob');
  const address = f.hub.server.address(); assert(address && typeof address !== 'string');
  const data = JSON.stringify({ requestId: randomUUID(), sectionId: f.alpha.sectionId, text: 'Must not commit', mentions: [] });
  const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/messages', method: 'POST', headers: { Host: f.alpha.host, Origin: origin(f.alpha.host), Cookie: session.cookies.join('; '), 'X-CSRF-Token': session.data.csrf, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
  const received = once(f.hub.server, 'request'); req.flushHeaders(); req.write(data.slice(0, 10)); await received;
  f.authority.editMember(f.ctx, f.ids.bob, 1, 'revoked');
  const response = once(req, 'response'); req.end(data.slice(10)); const [result] = await response as [IncomingMessage]; result.resume(); await once(result, 'end');
  assert.equal(result.statusCode, 404); assert.equal(f.authority.one('SELECT count(*) AS n FROM messages')!.n, 0);
});

test('bounded HTTP JSON returns 413 for declared/chunked overflow and rejects normalized route aliases', async t => {
  const f = await fixture(t), session = await f.login();
  const result = await f.request(f.alpha.host, '/api/messages', { rawBody: JSON.stringify({ text: 'x'.repeat(65536) }), cookies: session.cookies, csrf: session.data.csrf });
  assert.equal(result.status, 413); assert.equal(result.headers['cache-control'], 'no-store');
  const address = f.hub.server.address(); assert(address && typeof address !== 'string');
  const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/messages', method: 'POST', headers: { Host: f.alpha.host, Origin: origin(f.alpha.host), Cookie: session.cookies.join('; '), 'X-CSRF-Token': session.data.csrf, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
  const response = once(req, 'response'); req.end(' '.repeat(65537)); const [chunked] = await response as [IncomingMessage]; chunked.resume(); await once(chunked, 'end');
  assert.equal(chunked.statusCode, 413);
  assert.equal((await f.request(f.alpha.host, '/api/../auth/start')).status, 404);
  assert.equal(f.authority.one('SELECT count(*) AS n FROM messages')!.n, 0);
});

test('central renewal requires fresh exact-origin verification, rotates parent and fences old project sessions', async t => {
  const expiry = Date.now() + 30000;
  const f = await fixture(t, { verifier: { async verify(token) {
    return { issuer, subject: 'alice', sessionId: 'renewal-sid', verifiedMailboxes: [], expiresAt: token === 'fresh' ? expiry + 30000 : expiry };
  } } });
  const parent = await f.central('initial'), child = await f.login('alice', f.alpha.host, parent), bootstrap = await f.request(accounts, '/auth/bootstrap');
  const options = { body: {}, cookies: [...bootstrap.cookies, parent.cookies[0]], csrf: bootstrap.data.csrf, headers: { Authorization: 'Bearer fresh' } };
  assert.equal((await f.request(accounts, '/auth/session', { ...options, origin: origin(f.alpha.host) })).status, 403);
  const renewed = await f.request(accounts, '/auth/session', options); assert.equal(renewed.status, 200); assert.equal(renewed.data.expiresAt, expiry + 30000);
  assert.equal((await f.request(f.alpha.host, '/api/session', { cookies: child.cookies })).status, 401);
  const next = await f.login('alice', f.alpha.host, renewed); assert.equal(next.data.expiresAt, expiry + 30000);
});
