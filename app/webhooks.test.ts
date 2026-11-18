import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyEvent, validateFilters, matchesEvent, WebhookError } from './webhooks.ts';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';

test('webhook receipts isolate, deduplicate, rotate and persist ignored events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-webhooks-')), prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const prompt = JSON.parse(raw).messages.at(-1).content; prompts.push(prompt);
    if (prompt.includes('HOLD')) return;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Webhook complete' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  async function send(hook: { route: string; secret: string }, id: string, event: string, payload: unknown, status = 202) {
    const body = JSON.stringify({ event, payload }), time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', hook.secret).update(`${time}\n${id}\n${body}`).digest('hex');
    const response = await fetch(`${app.origin}/api/webhooks/${hook.route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': signature }, body });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  function beginEvent(hook: { route: string; secret: string }) {
    const body = JSON.stringify({ event: 'report.ready', payload: { count: 4 } }), time = String(Math.floor(Date.now() / 1000)), id = randomUUID();
    const signature = createHmac('sha256', hook.secret).update(`${time}\n${id}\n${body}`).digest('hex');
    let finish!: () => void;
    const response = new Promise<{ status: number | undefined; data: { outcome?: string } }>((resolve, reject) => {
      const req = httpRequest(`${app.origin}/api/webhooks/${hook.route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': signature } }, async res => {
        try { let raw = ''; for await (const chunk of res) raw += chunk; resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch (error) { reject(error); }
      });
      req.on('error', reject); req.write(body.slice(0, -1)); finish = () => req.end(body.slice(-1));
    });
    return { finish, response };
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Webhook', model: 'fixture', instructions: 'Help.' }, 201);
    const list = `/api/agents/${agent.id}/routines`;
    const create = { id: randomUUID(), name: 'Event handler', prompt: 'Saved task', nextAt: Date.now() - 1, intervalSeconds: null, enabled: true, trigger: 'webhook' };
    const routine = await request(list, create), settings = `/api/routines/${routine.id}/webhook`, events = `/api/routines/${routine.id}/webhook-events`, runs = `/api/routines/${routine.id}/runs`;
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal((await request(runs)).length, 0);
    const calendar = await (await fetch(`${app.origin}${list}/calendar.ics`)).text(); assert(!calendar.includes(routine.id));
    const command = { id: randomUUID(), revision: 0, rotate: true, eventName: 'report.ready', filters: [{ pointer: '/count', equals: 4 }] };
    const hook = await request(settings, command); assert(hook.secret); assert.deepEqual(await request(settings, command), hook);
    assert(!JSON.stringify(await request(settings)).includes(hook.secret));
    await request(`/api/webhooks/${hook.route}`, { event: 'report.ready', payload: { count: 4 } }, 403);
    const id = randomUUID(), accepted = await send(hook, id, 'report.ready', { count: 4 });
    assert.equal(accepted.outcome, 'queued'); assert.deepEqual(await send(hook, id, 'report.ready', { count: 4 }, 200), accepted);
    await send(hook, id, 'report.ready', { count: 5 }, 409);
    let rows;
    for (let n = 0; n < 100; n++) { rows = await request(runs); if (rows[0]?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].status, 'done'); assert.equal(rows[0].source, 'webhook'); assert.equal(prompts.length, 1); assert(prompts[0].includes('"count":4')); assert(prompts[0].startsWith('Saved task'));
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
    const ignoredId = randomUUID(); assert.equal((await send(hook, ignoredId, 'other', { count: 4 })).outcome, 'ignored');
    const updated = await request(settings, { ...command, id: randomUUID(), revision: 1, rotate: false, eventName: '' }); assert(!updated.secret);
    assert.equal((await send(hook, ignoredId, 'other', { count: 4 }, 200)).outcome, 'ignored');
    const rotated = await request(settings, { ...command, id: randomUUID(), revision: 2, rotate: true });
    await send(hook, randomUUID(), 'report.ready', { count: 4 }, 401);
    await request(settings, command, 409);
    assert.deepEqual(await send(rotated, id, 'report.ready', { count: 4 }, 200), accepted);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await send(rotated, id, 'report.ready', { count: 4 }, 200), accepted); assert.equal(prompts.length, 1);
    assert.equal((await request(events)).length, 2);
    const held = await send(rotated, randomUUID(), 'report.ready', { count: 4, text: 'HOLD' });
    const busyId = randomUUID(); await send(rotated, busyId, 'report.ready', { count: 4 }, 503);
    assert.equal((await request(events)).length, 3);
    await request(`/api/threads/${held.thread}/turns/${held.turn}/cancel`, { id: randomUUID() });
    assert.equal((await send(rotated, busyId, 'report.ready', { count: 4 })).outcome, 'queued');
    await request(`/api/routines/${routine.id}/edit`, { ...create, id: randomUUID(), revision: routine.revision, enabled: false });
    assert.equal((await send(rotated, randomUUID(), 'report.ready', { count: 4 })).outcome, 'ignored');
    const latest = (await request(list))[0];
    await request(`/api/routines/${routine.id}/edit`, { ...create, id: randomUUID(), revision: latest.revision, trigger: 'schedule', enabled: false });
    await send(rotated, id, 'report.ready', { count: 4 }, 404);
    assert.equal((await request(events)).length, 5); assert.equal(await request(settings), null);
    const schedule = (await request(list))[0];
    await request(`/api/routines/${routine.id}/edit`, { ...create, id: randomUUID(), revision: schedule.revision });
    const replacement = await request(settings, { ...command, id: randomUUID() });
    assert.notEqual(replacement.route, hook.route); assert.notEqual(replacement.secret, hook.secret);
    await request(settings, command, 409);
    await send(rotated, id, 'report.ready', { count: 4 }, 404);
    assert(!JSON.stringify(await request(events)).includes(replacement.secret));
    const other = await request(list, { ...create, id: randomUUID() });
    const otherHook = await request(`/api/routines/${other.id}/webhook`, { ...command, id: randomUUID() });
    await send({ ...otherHook, secret: replacement.secret }, randomUUID(), 'report.ready', { count: 4 }, 401);
    const filtering = beginEvent(otherHook);
    await request(`/api/routines/${other.id}/webhook`, { ...command, id: randomUUID(), revision: 1, rotate: false, filters: [{ pointer: '/count', equals: 5 }] });
    filtering.finish(); const filtered = await filtering.response;
    assert.equal(filtered.status, 202); assert.equal(filtered.data.outcome, 'ignored');
    const rotating = beginEvent(otherHook);
    await request(`/api/routines/${other.id}/webhook`, { ...command, id: randomUUID(), revision: 2, rotate: true });
    rotating.finish(); assert.equal((await rotating.response).status, 401);
    assert.equal((await request(`/api/routines/${other.id}/webhook-events`)).length, 1);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('webhook authentication binds exact bytes, event ID and time before parsing', () => {
  const now = 1794320000000, secret = 'synthetic-webhook-secret';
  const body = Buffer.from(JSON.stringify({ event: 'report.ready', payload: { count: 4 } }));
  function headers(bytes = body, time = String(now / 1000), id = 'event:123') {
    return { 'x-briefsip-time': time, 'x-briefsip-id': id, 'x-briefsip-signature': createHmac('sha256', secret).update(`${time}\n${id}\n`).update(bytes).digest('hex') };
  }
  const rejects = (fn: () => unknown, status: number) => assert.throws(fn, error => error instanceof WebhookError && error.status === status);
  const event = verifyEvent(body, headers(), secret, now);
  assert.equal(event.id, 'event:123'); assert.equal(event.eventTime, now); assert.deepEqual(event.payload, { count: 4 });
  assert.equal(verifyEvent(body, headers(body, String(now / 1000 + 300)), secret, now).digest, event.digest);
  assert.equal(verifyEvent(body, headers(body, String(now / 1000 - 300)), secret, now).digest, event.digest);
  for (const offset of [-301, 301]) rejects(() => verifyEvent(body, headers(body, String(now / 1000 + offset)), secret, now), 401);
  rejects(() => verifyEvent(body, headers(), 'other-secret', now), 401);
  rejects(() => verifyEvent(Buffer.concat([body, Buffer.from(' ')]), headers(), secret, now), 401);
  rejects(() => verifyEvent(body, { ...headers(), 'x-briefsip-id': 'different' }, secret, now), 401);
  rejects(() => verifyEvent(body, { ...headers(), 'x-briefsip-time': ['1', '2'] }, secret, now), 401);
  rejects(() => verifyEvent(body, headers(body, String(now / 1000), 'bad/id'), secret, now), 401);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('[]'), Buffer.from('{"event":""}'), Buffer.from('{"event":"x","eventTime":0}'), Buffer.from('{"event":"x","unexpected":1}')]) rejects(() => verifyEvent(bytes, headers(bytes), secret, now), 400);
  const large = Buffer.alloc(64 * 1024 + 1, 32); rejects(() => verifyEvent(large, headers(large), secret, now), 413);
  const overflow = Buffer.from('{"event":"x","payload":1e999}'); rejects(() => verifyEvent(overflow, headers(overflow), secret, now), 400);
});

test('webhook filters use strict scalar equality and own JSON pointer paths', () => {
  const event = { id: 'fixture', digest: 'fixture', event: 'report.ready', eventTime: 1, payload: JSON.parse('{"a/b":{"~key":[4,false,null]},"__proto__":"own value"}') };
  const filters = validateFilters([{ pointer: '/a~1b/~0key/0', equals: 4 }, { pointer: '/a~1b/~0key/1', equals: false }, { pointer: '/a~1b/~0key/2', equals: null }]);
  assert(matchesEvent(event, 'report.ready', filters)); assert(matchesEvent(event, '', filters));
  assert(!matchesEvent(event, 'other', filters));
  assert(!matchesEvent(event, '', validateFilters([{ pointer: '/a~1b/~0key/0', equals: '4' }])));
  assert(!matchesEvent(event, '', validateFilters([{ pointer: '/missing', equals: null }])));
  assert(!matchesEvent(event, '', validateFilters([{ pointer: '/a~1b/~0key/00', equals: 4 }])));
  assert(!matchesEvent(event, '', validateFilters([{ pointer: '/a~1b/~0key/length', equals: 3 }])));
  assert(!matchesEvent(event, '', validateFilters([{ pointer: '/toString', equals: null }])));
  assert(matchesEvent(event, '', validateFilters([{ pointer: '/__proto__', equals: 'own value' }])));
  assert(matchesEvent({ ...event, payload: false }, '', validateFilters([{ pointer: '', equals: false }])));
  for (const filters of [null, Array(129).fill({ pointer: '', equals: null }), [{ pointer: '/bad~2', equals: 1 }], [{ pointer: 'bad', equals: 1 }], [{ pointer: '', equals: {} }], [{ pointer: '', equals: Infinity }], [{ pointer: '' }]]) assert.throws(() => validateFilters(filters), WebhookError);
});
