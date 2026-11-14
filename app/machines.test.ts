import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { machineOrigin } from './machines.ts';
import { fakePeerTokenIssuer } from './machines.fixture.ts';

type App = Awaited<ReturnType<typeof startApp>>;
async function call(app: { origin: string }, path: string, body?: unknown, status = 200, bearer?: string, browser = true): Promise<any> {
  const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(browser ? { Origin: app.origin } : {}), 'Content-Type': 'application/json', Connection: 'close', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
const command = () => ({ id: randomUUID() });
const environment = (app: App) => call(app, '/api/environment');
const list = async (app: App) => (await call(app, '/api/machines')).machines;
const pair = async (a: App, b: App) => { const code = await call(b, '/api/pairing-codes', command()); const request = { ...command(), origin: b.origin, code: code.code }; return { result: await call(a, '/api/machines', request), code, request }; };
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string'); return { origin: `http://127.0.0.1:${address.port}` }; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('peer transport accepts proxy host headers while owner machine routes retain the local host boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-peer-host-'));
  const app = await startApp({ database: join(dir, 'db.sqlite'), peerTokenIssuer: fakePeerTokenIssuer() });
  const send = (path: string, body?: unknown) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: 'workstation.example.ts.net:4317', 'Content-Type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
    req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal(await send('/api/environment'), 200);
    assert.equal(await send('/api/peer/agents'), 401);
    assert.equal(await send('/api/pairing/redeem', {}), 400);
    assert.equal(await send('/api/machines/reciprocal', {}), 401);
    assert.equal(await send('/api/peer/unpair', {}), 401);
    assert.equal(await send('/api/machines'), 403);
    assert.equal(await send('/api/pairing-codes', command()), 403);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two real instances pair mutually, expose scoped cached agents, survive restarts, recover offline, and revoke on unpair without leaking credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-machines-')), issuerA = fakePeerTokenIssuer(), issuerB = fakePeerTokenIssuer();
  const aOptions = { database: join(dir, 'a.sqlite'), peerTokenIssuer: issuerA }, bOptions = { database: join(dir, 'b.sqlite'), peerTokenIssuer: issuerB };
  let a = await startApp(aOptions), b = await startApp(bOptions); const logs: string[] = [];
  const original = [console.log, console.warn, console.error]; console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    const initialA = await environment(a), initialB = await environment(b);
    assert.notEqual(initialA.id, initialB.id);
    const rename = { ...command(), name: 'Machine B' }; await call(b, '/api/environment', rename); await call(b, '/api/environment', rename); await call(b, '/api/environment', { ...rename, name: 'Other' }, 409);
    const agentA = { id: randomUUID(), name: 'Alpha', model: 'fixture', instructions: 'Help.' }, agentB = { ...agentA, id: randomUUID(), name: 'Beta' };
    await call(a, '/api/agents', agentA, 201); await call(b, '/api/agents', agentB, 201);
    const { result, code, request } = await pair(a, b); assert.equal(result.id, initialB.id); assert.equal(result.pairingState, 'paired'); assert.equal(result.status, 'online'); assert.equal(result.agentCount, 1); assert.equal(result.agents[0].name, 'Beta');
    await call(a, '/api/machines', request); assert.equal(issuerA.issued.length, 1); assert.equal(issuerB.issued.length, 1);
    const back = (await list(b))[0]; assert.equal(back.id, initialA.id); assert.equal(back.agents[0].name, 'Alpha');
    assert.deepEqual((await call(b, '/api/peer/agents', undefined, 200, issuerB.issued[0], false)).agents, result.agents);
    await call(b, '/api/peer/agents', undefined, 401, undefined, false); await call(b, '/api/peer/agents', undefined, 401, 'wrong-peer-token', false);
    const auth = issuerB.tokens.get(issuerB.issued[0])!; issuerB.tokens.set(issuerB.issued[0], { ...auth, scopes: ['history:read'] });
    await call(b, '/api/peer/agents', undefined, 401, issuerB.issued[0], false); await a.refreshMachines(); assert.equal((await list(a))[0].status, 'unauthorized'); issuerB.tokens.set(issuerB.issued[0], auth);
    await call(b, '/api/pairing/redeem', { code: code.code, returnPairing: initialA }, 400, undefined, false);
    const bPort = Number(new URL(b.origin).port), aPort = Number(new URL(a.origin).port);
    await b.close(); await a.refreshMachines(); assert.equal((await list(a))[0].status, 'offline'); assert.equal((await list(a))[0].agents[0].name, 'Beta');
    b = await startApp({ ...bOptions, port: bPort }); assert.equal((await environment(b)).id, initialB.id); assert.equal((await environment(b)).name, 'Machine B'); await a.refreshMachines(); assert.equal((await list(a))[0].status, 'online');
    await a.close(); a = await startApp({ ...aOptions, port: aPort }); assert.equal((await environment(a)).id, initialA.id); await b.refreshMachines(); assert.equal((await list(b))[0].status, 'online'); await a.refreshMachines();
    const codeRequest = command(), once = await call(a, '/api/pairing-codes', codeRequest); await call(a, '/api/pairing-codes', codeRequest, 409);
    for (const app of [a, b]) for (const path of ['/api/environment', '/api/machines', '/api/agents']) { const response = JSON.stringify(await call(app, path)); for (const token of [...issuerA.issued, ...issuerB.issued]) assert(!response.includes(token)); }
    await a.close(); await b.close();
    for (const file of readdirSync(dir).filter(file => !file.endsWith('-key'))) { const bytes = readFileSync(join(dir, file)); for (const token of [...issuerA.issued, ...issuerB.issued, code.code, once.code]) assert(!bytes.includes(Buffer.from(token)), `Secret in ${file}`); }
    for (const file of ['a.sqlite.peer-key', 'b.sqlite.peer-key']) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    assert(!logs.join('\n').includes('peer-canary-'));
    a = await startApp({ ...aOptions, port: aPort }); b = await startApp({ ...bOptions, port: bPort });
    const removal = { ...command(), environmentId: initialB.id }; await call(a, '/api/machines/remove', removal); await call(a, '/api/machines/remove', removal); assert.deepEqual(await list(a), []); assert.deepEqual(await list(b), []); assert.equal(issuerA.tokens.size, 0); assert.equal(issuerB.tokens.size, 0);
    await call(b, '/api/peer/agents', undefined, 401, issuerB.issued[0], false);
  } finally { [console.log, console.warn, console.error] = original; await a.close().catch(() => {}); await b.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('pairing uses uniform invalid-code errors, strict bodies, one-time expiry, persisted rate limits, and browser-only owner writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-pairing-')); let clock = Date.now(); const issuer = fakePeerTokenIssuer(), options = { database: join(dir, 'db.sqlite'), peerTokenIssuer: issuer, machines: { now: () => clock } }; let app = await startApp(options);
  try {
    const remote = { id: randomUUID(), name: 'Remote', version: '0.1.0', origin: 'http://127.0.0.1:12345' };
    const redeem = (body: unknown, status = 400) => call(app, '/api/pairing/redeem', body, status, undefined, false);
    const made = await call(app, '/api/pairing-codes', command()); clock += 10 * 60_000 + 1;
    const wrong = await redeem({ code: '23456789ABCD', returnPairing: remote }); assert.deepEqual(await redeem({ code: made.code, returnPairing: remote }), wrong);
    for (const body of [null, [], {}, { code: 42 }, { code: '23456789ABCD', returnPairing: { ...remote, extra: true } }, { code: '23456789ABCD', returnPairing: remote, extra: true }]) assert.deepEqual(await redeem(body), wrong);
    for (let i = 8; i < 12; i++) await redeem({ code: '23456789ABCD', returnPairing: remote }); await redeem({}, 429);
    const port = Number(new URL(app.origin).port); await app.close(); app = await startApp({ ...options, port }); await redeem({}, 429); clock += 120_000;
    const valid = await call(app, '/api/pairing-codes', command()); const response = await redeem({ code: valid.code.toLowerCase(), returnPairing: remote }, 200); assert(response.token); await redeem({ code: valid.code, returnPairing: remote });
    await call(app, '/api/machines/reciprocal', { environment: { ...remote, id: randomUUID() }, token: 'return-canary-token-123456' }, 401, response.token, false);
    await call(app, '/api/pairing-codes', command(), 403, undefined, false);
    await call(app, '/api/pairing/redeem', { code: valid.code, returnPairing: remote }, 400);
    await call(app, '/api/peer/unpair', {}, 401, 'invalid-token-123456', false);
    await call(app, '/api/environment', { ...command(), name: '', extra: 'x' }, 400);
    await call(app, '/api/environment?x=1', undefined, 400);
    clock += 10 * 60_000 + 1; await app.refreshMachines(); assert.equal(issuer.tokens.size, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('origins reject unsafe forms; remote pairing rejects redirects, oversized bodies, and credential reflection', async () => {
  for (const origin of ['http://example.ts.net', 'https://user:pass@machine.ts.net', 'https://host/path', 'https://host?x=1', 'https://host#x', 'https://host\\evil', ' https://host', 'https://host?', 'https://host#']) assert.throws(() => machineOrigin(origin));
  assert.equal(machineOrigin('https://machine.ts.net:4317'), 'https://machine.ts.net:4317'); assert.equal(machineOrigin('http://[::1]:1234'), 'http://[::1]:1234');
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-pair-fetch-')); const issuer = fakePeerTokenIssuer(), app = await startApp({ database: join(dir, 'db.sqlite'), peerTokenIssuer: issuer }); let mode = 'redirect', targetCalls = 0;
  const destination = createServer((_req, res) => { targetCalls++; res.end('{}'); }), destinationAddress = await listen(destination);
  const fake = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); if (mode === 'redirect') { res.writeHead(307, { Location: destinationAddress.origin + '/steal' }); return res.end(); } if (mode === 'large') return res.end(JSON.stringify({ value: 'x'.repeat(129 * 1024) })); if (mode === 'declared') { res.writeHead(200, { 'Content-Length': '9999999' }); return res.end('{}'); } res.end('{}'); }); const address = await listen(fake);
  try {
    for (mode of ['redirect', 'large', 'declared', 'invalid']) await call(app, '/api/machines', { ...command(), origin: address.origin, code: '23456789ABCD' }, mode === 'invalid' ? 400 : 502);
    assert.equal(targetCalls, 0); assert.deepEqual(await list(app), []); assert.equal(issuer.tokens.size, 0);
  } finally { await app.close(); await close(fake); await close(destination); rmSync(dir, { recursive: true, force: true }); }
});

test('unpair removes first while remote is offline; missing wrapping key fails closed and cached agents remain readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-peer-recovery-')), issuerA = fakePeerTokenIssuer(), issuerB = fakePeerTokenIssuer(); const aOptions = { database: join(dir, 'a.sqlite'), peerTokenIssuer: issuerA }, bOptions = { database: join(dir, 'b.sqlite'), peerTokenIssuer: issuerB };
  const a = await startApp(aOptions), b = await startApp(bOptions);
  try {
    await pair(a, b); chmodSync(aOptions.database + '.peer-key', 0o644); await a.refreshMachines(); assert.equal((await list(a))[0].status, 'unauthorized'); chmodSync(aOptions.database + '.peer-key', 0o600);
    await b.close(); const target = (await list(a))[0]; await call(a, '/api/machines/remove', { ...command(), environmentId: target.id }); assert.deepEqual(await list(a), []); assert.equal(issuerA.tokens.size, 0);
  } finally { await a.close(); await b.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('background health reports version mismatch and never sends bearer to a changed identity or redirected descriptor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-peer-health-')), issuer = fakePeerTokenIssuer(); const app = await startApp({ database: join(dir, 'db.sqlite'), peerTokenIssuer: issuer, machines: { healthIntervalMs: 50 } });
  const id = randomUUID(), remoteToken = 'remote-peer-canary-1234567890123456', agent = { id: randomUUID(), name: 'Remote agent', model: 'fixture', status: 'idle' }; let mode = 'normal', origin = '', authorizedCalls = 0, issuedBack = '';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json'); const send = (body: unknown) => res.end(JSON.stringify(body));
    const descriptor = { id: mode === 'identity' ? randomUUID() : id, name: 'Synthetic workstation', origin, version: mode === 'version' ? '99.0.0' : '0.1.0' };
    if (req.headers.authorization) authorizedCalls++;
    if (req.url === '/api/pairing/redeem') return send({ environment: descriptor, token: remoteToken });
    if (req.url === '/api/machines/reciprocal') { issuedBack = data.token; return send({ ok: true }); }
    if (req.url === '/api/environment') { if (mode === 'redirect') { res.writeHead(302, { Location: app.origin + '/api/environment' }); return res.end(); } return send(descriptor); }
    if (req.url === '/api/peer/agents') { if (mode === 'unauthorized') { res.writeHead(401); return send({ error: 'no' }); } return send({ agents: [{ ...agent, name: mode === 'reflection' ? issuedBack : agent.name }] }); }
    return send({ ok: true });
  }); origin = (await listen(server)).origin;
  try {
    const result = await call(app, '/api/machines', { ...command(), origin, code: '23456789ABCD' }); assert.equal(result.status, 'online');
    mode = 'version'; const deadline = Date.now() + 20_000;
    while ((await list(app))[0].status !== 'version-mismatch' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await list(app))[0].status, 'version-mismatch');
    mode = 'normal'; await app.refreshMachines(); assert.equal((await list(app))[0].status, 'online');
    mode = 'unauthorized'; await app.refreshMachines(); assert.equal((await list(app))[0].status, 'unauthorized');
    mode = 'identity'; await app.refreshMachines(); const before = authorizedCalls; await app.refreshMachines(); assert.equal((await list(app))[0].status, 'unauthorized'); assert.equal(authorizedCalls, before, 'Identity mismatch received bearer');
    mode = 'redirect'; await app.refreshMachines(); assert.equal((await list(app))[0].status, 'offline'); assert.equal(authorizedCalls, before);
    mode = 'reflection'; await app.refreshMachines(); assert.equal((await list(app))[0].status, 'offline'); assert.equal((await list(app))[0].agents[0].name, agent.name); assert(!JSON.stringify(await list(app)).includes(issuedBack));
  } finally { await app.close(); await close(server); rmSync(dir, { recursive: true, force: true }); }
});

test('lost reciprocal acknowledgement retries encrypted pending credentials after restart without minting another token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-peer-retry-')), issuer = fakePeerTokenIssuer(), options = { database: join(dir, 'db.sqlite'), peerTokenIssuer: issuer };
  let app = await startApp(options), origin = '', attempts = 0, saved = '';
  const peerId = randomUUID(), token = 'retry-peer-canary-12345678901234567890';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const data = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json'); const send = (body: unknown) => res.end(JSON.stringify(body));
    const environment = { id: peerId, name: 'Retry workstation', version: '0.1.0', origin };
    if (req.url === '/api/pairing/redeem') return send({ environment, token });
    if (req.url === '/api/machines/reciprocal') { attempts++; if (!saved) { saved = data.token; return req.socket.destroy(); } assert.equal(data.token, saved); return send({ ok: true }); }
    if (req.url === '/api/environment') return send(environment);
    if (req.url === '/api/peer/agents') return send({ agents: [] }); return send({ ok: true });
  }); origin = (await listen(server)).origin;
  try {
    const request = { ...command(), origin, code: '23456789ABCD' }; await call(app, '/api/machines', request, 409); assert.equal((await list(app))[0].pairingState, 'pending');
    const port = Number(new URL(app.origin).port); await app.close(); app = await startApp({ ...options, port });
    assert.equal((await call(app, '/api/machines', request)).pairingState, 'paired'); assert.equal(attempts, 2); assert.equal(issuer.issued.length, 1);
    const mismatch = { ...request, code: '23456789ABCE' }; await call(app, '/api/machines', mismatch, 409);
    await app.close(); const db = new DatabaseSync(options.database); try { const row = db.prepare('SELECT token,return_token FROM paired_machines').get()!; assert(!String(row.token).includes(token)); assert(!String(row.return_token).includes(saved)); } finally { db.close(); }
  } finally { await app.close().catch(() => {}); await close(server); rmSync(dir, { recursive: true, force: true }); }
});
