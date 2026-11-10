import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from './server.ts';

test('HTTP: persistence, idempotent FIFO turns, isolation, failure and interrupted recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-check-'));
  const calls: string[] = [];
  let releaseRouting: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); const text = data.messages.at(-1).content;
    calls.push(text);
    if (data.messages[0].content.startsWith('Choose exactly one channel member')) {
      const input = JSON.parse(text);
      if (input.request === 'route-hang') return;
      if (input.request === 'route-busy-lead') await new Promise<void>(resolve => { releaseRouting = resolve; });
      if (input.request === 'route-cancel') await new Promise(resolve => setTimeout(resolve, 200));
      if (input.request === 'route-malformed') { res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] })); return; }
      const decision = input.request === 'route-invalid' ? { action: 'assign', recipient: randomUUID() }
        : input.request === 'route-clarify' ? { action: 'clarify', message: 'Which topic?' }
        : input.request === 'route-none' ? { action: 'none', message: 'No work requested.' }
        : { action: 'assign', recipient: input.members.find((member: { name: string }) => member.name === 'Agent 0').id };
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }));
      return;
    }
    if (text === 'hang') return;
    await new Promise(resolve => setTimeout(resolve, 30));
    res.setHeader('Content-Type', 'application/json');
    if (text === 'fail') { res.writeHead(429); res.end('{"error":"private upstream detail"}'); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `reply:${text};history:${data.messages.length}` } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  const request = async (path: string, body?: unknown, origin = app.origin) => {
    const response = await fetch(app.origin + path, body ? { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, body: await response.json() };
  };
  async function until(path: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const response = await request(path);
      if (response.body.at(-1)?.status === status) return response.body;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Timed out waiting for ${status}`);
  }
  try {
    const profile = { id: randomUUID(), name: 'Research', model: 'test-model', instructions: 'Answer precisely.' };
    assert.equal((await request('/api/agents', profile, 'https://foreign.example')).status, 403);
    assert.equal((await request('/api/agents', { ...profile, name: '' })).status, 400);
    assert.equal((await request('/api/agents', profile)).status, 201);
    assert.equal((await request('/api/agents', profile)).status, 200);
    assert.equal((await request('/api/agents', { ...profile, name: 'changed' })).status, 409);
    for (let i = 0; i < 4; i++) assert.equal((await request('/api/agents', { ...profile, id: randomUUID(), name: `Agent ${i}` })).status, 201);
    assert.equal((await request('/api/agents')).body.agents.length, 5);
    const path = `/api/agents/${profile.id}/turns`;
    const first = { id: randomUUID(), text: 'first' };
    assert.equal((await request(path, first)).status, 202);
    assert.equal((await request(path, first)).status, 202);
    assert.equal((await request(path, { ...first, text: 'different' })).status, 409);
    const second = { id: randomUUID(), text: 'second' };
    assert.equal((await request(path, second)).status, 202);
    const turns = await until(path, 'done');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].reply, 'reply:first;history:2');
    assert.equal(turns[1].reply, 'reply:second;history:4');
    assert.deepEqual(calls, ['first', 'second']);
    const other = (await request('/api/agents')).body.agents[1];
    assert.deepEqual((await request(`/api/agents/${other.id}/turns`)).body, []);
    assert.equal((await request(`/api/agents/${other.id}/turns`, first)).status, 409);
    await request(path, { id: randomUUID(), text: 'fail' });
    const failed = (await until(path, 'failed')).at(-1);
    assert.match(failed.error, /HTTP 429/); assert(!failed.error.includes('private'));
    await request(path, { id: randomUUID(), text: 'hang' });
    await until(path, 'running');
    await app.close();
    app = await startApp(options);
    const recovered = (await request(path)).body;
    assert.equal(recovered.at(-1).status, 'interrupted');
    assert.equal(recovered[0].reply, 'reply:first;history:2');
    assert.equal((await request('/api/agents')).body.agents.length, 5);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls.filter(text => text === 'hang').length, 1);
    assert.equal((await request(path, first)).status, 202);
    assert.equal((await request(path)).body.length, 4);
    const forbiddenHost = await new Promise<number | undefined>((resolve, reject) => get(app.origin + '/api/agents', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(forbiddenHost, 403);
    const staticPage = await fetch(app.origin); assert.equal(staticPage.status, 200);
    assert.match(staticPage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const channel = { id: randomUUID(), name: 'Research room', instructions: 'Compare findings.', members: [profile.id, other.id], lead: profile.id };
    assert.equal((await request('/api/channels', { ...channel, lead: randomUUID() })).status, 400);
    assert.equal((await request('/api/channels', channel)).status, 201);
    assert.equal((await request('/api/channels', { ...channel, members: [...channel.members].reverse() })).status, 200);
    assert.equal((await request('/api/channels', { ...channel, name: 'changed' })).status, 409);
    const channelPath = `/api/channels/${channel.id}/turns`;
    const channelMessage = { id: randomUUID(), text: 'channel-first' };
    assert.equal((await request(channelPath, channelMessage)).status, 202);
    assert.equal((await request(channelPath, channelMessage)).status, 202);
    const channelTurns = await until(channelPath, 'done');
    assert.equal(channelTurns.length, 1);
    assert.equal(channelTurns[0].agent, profile.id);
    assert.equal(channelTurns[0].reply, 'reply:channel-first;history:2');
    assert.equal((await request(path)).body.length, 4);
    assert.equal((await request(channelPath, { ...channelMessage, recipient: other.id })).status, 409);
    assert.equal((await request(channelPath, { id: randomUUID(), text: 'reject', recipient: randomUUID() })).status, 400);
    await request(channelPath, { id: randomUUID(), text: 'channel-second', recipient: other.id });
    const channelSecond = (await until(channelPath, 'done')).at(-1);
    assert.equal(channelSecond.agent, other.id);
    assert.equal(channelSecond.reply, 'reply:channel-second;history:4');
    assert.deepEqual((await request(`/api/agents/${other.id}/turns`)).body, []);
    const noLead = { ...channel, id: randomUUID(), lead: null };
    await request('/api/channels', noLead);
    assert.equal((await request(`/api/channels/${noLead.id}/turns`, { id: randomUUID(), text: 'ambiguous' })).status, 409);
    assert.deepEqual((await request(`/api/channels/${noLead.id}/turns`)).body, []);
    const single = { ...channel, id: randomUUID(), lead: null, members: [other.id] };
    await request('/api/channels', single);
    const singlePath = `/api/channels/${single.id}/turns`;
    await request(singlePath, { id: randomUUID(), text: 'single' });
    assert.equal((await until(singlePath, 'done'))[0].agent, other.id);
    const hanging = { id: randomUUID(), text: 'hang' }, queued = { id: randomUUID(), text: 'never-sent' };
    await request(channelPath, hanging);
    await until(channelPath, 'running');
    await request(channelPath, queued);
    assert.equal((await request(`${path}/${hanging.id}/cancel`, { id: randomUUID() })).status, 404);
    assert.equal((await request(`${channelPath}/${queued.id}/cancel`, { id: randomUUID() })).body.status, 'cancelled');
    assert.equal((await request(`${channelPath}/${hanging.id}/cancel`, { id: randomUUID() })).body.status, 'cancelled');
    assert.equal((await request(`${channelPath}/${hanging.id}/cancel`, { id: randomUUID() })).body.status, 'cancelled');
    assert.equal((await request(`${channelPath}/${channelMessage.id}/cancel`, { id: randomUUID() })).status, 409);
    await request(channelPath, { id: randomUUID(), text: 'after-cancel' });
    assert.equal((await until(channelPath, 'done')).at(-1).reply, 'reply:after-cancel;history:6');
    assert(!calls.includes('never-sent'));
    const routingChannel = { ...channel, id: randomUUID() };
    await request('/api/channels', routingChannel);
    const routePath = `/api/channels/${routingChannel.id}/turns`;
    const routed = { id: randomUUID(), text: 'route-task', automatic: true };
    assert.equal((await request(routePath, routed)).status, 202);
    assert.equal((await request(routePath, routed)).status, 202);
    const routedTurns = await until(routePath, 'done');
    assert.equal(routedTurns.length, 1);
    assert.equal(routedTurns[0].agent, other.id);
    assert.equal(routedTurns[0].routing, 'assigned');
    assert.equal(routedTurns[0].reply, 'reply:route-task;history:2');
    assert.equal(calls.filter(text => text === 'route-task').length, 1);
    assert.equal(calls.filter(text => text.includes('"request":"route-task"')).length, 1);
    assert.equal((await request(routePath, { ...routed, automatic: false })).status, 409);
    for (const action of ['clarify', 'none']) {
      await request(routePath, { id: randomUUID(), text: `route-${action}`, automatic: true });
      const result = (await until(routePath, 'done')).at(-1);
      assert.equal(result.routing, action);
      assert(!calls.includes(`route-${action}`));
    }
    await request(routePath, { id: randomUUID(), text: 'route-invalid', automatic: true });
    assert.match((await until(routePath, 'failed')).at(-1).error, /routing/);
    assert(!calls.includes('route-invalid'));
    await request(routePath, { id: randomUUID(), text: 'explicit-wins', automatic: true, recipient: other.id });
    assert.equal((await until(routePath, 'done')).at(-1).agent, other.id);
    assert(!calls.some(text => text.includes('"request":"explicit-wins"')));
    await request(routePath, { id: randomUUID(), text: 'route-malformed', automatic: true });
    assert.match((await until(routePath, 'failed')).at(-1).error, /JSON/);
    const cancelRouting = { id: randomUUID(), text: 'route-cancel', automatic: true };
    await request(routePath, cancelRouting);
    await until(routePath, 'running');
    await request(`${routePath}/${cancelRouting.id}/cancel`, { id: randomUUID() });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await request(routePath)).body.at(-1).status, 'cancelled');
    assert(!calls.includes('route-cancel'));
    await request(routePath, { id: randomUUID(), text: 'route-busy-lead', automatic: true });
    await until(routePath, 'running');
    for (let i = 0; !releaseRouting && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(releaseRouting);
    const leadBlocked = { id: randomUUID(), text: 'hang' };
    await request(path, leadBlocked);
    releaseRouting();
    await until(path, 'running');
    assert.equal((await until(routePath, 'done')).at(-1).agent, other.id);
    assert.equal((await request(path)).body.at(-1).status, 'running');
    await request(`${path}/${leadBlocked.id}/cancel`, { id: randomUUID() });
    const otherPath = `/api/agents/${other.id}/turns`;
    await request(otherPath, { id: randomUUID(), text: 'hang' });
    await until(otherPath, 'running');
    const recovery = { id: randomUUID(), text: 'route-recovery', automatic: true };
    await request(routePath, recovery);
    for (let i = 0; i < 100; i++) {
      if ((await request(routePath)).body.at(-1).routing === 'assigned') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const savedDecision = (await request(routePath)).body.at(-1);
    assert.equal(savedDecision.routing, 'assigned');
    assert.equal(savedDecision.status, 'queued');
    assert(!calls.includes('route-recovery'));
    await app.close();
    app = await startApp(options);
    assert.equal((await until(routePath, 'done')).at(-1).id, recovery.id);
    assert.equal(calls.filter(text => text.includes('"request":"route-recovery"')).length, 1);
    assert.equal(calls.filter(text => text === 'route-recovery').length, 1);
    await request(routePath, { id: randomUUID(), text: 'route-hang', automatic: true });
    await until(routePath, 'running');
    await app.close();
    app = await startApp(options);
    assert.equal((await request(routePath)).body.at(-1).status, 'interrupted');
    assert.equal((await request(routePath)).body[0].routing, 'assigned');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls.filter(text => text.includes('"request":"route-hang"')).length, 1);
    await app.close();
    app = await startApp({ database: options.database });
    assert.equal((await request('/api/channels')).body.length, 4);
    assert.equal((await request(channelPath)).body.length, 5);
    assert.equal((await request(channelPath)).body[2].status, 'cancelled');
    assert.equal((await request('/api/agents')).body.configured, false);
    assert.equal((await request(path, { id: randomUUID(), text: 'no provider' })).status, 503);
    assert.equal((await request(path)).body.length, 5);
  } finally {
    await app.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic routing shares four workers with execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-concurrency-'));
  let active = 0, peak = 0, released = false;
  const waiting: (() => void)[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    active++; peak = Math.max(peak, active);
    const respond = () => {
      active--;
      const routing = data.messages[0].content.startsWith('Choose exactly one channel member');
      const input = routing ? JSON.parse(data.messages.at(-1).content) : null;
      const content = routing ? JSON.stringify({ action: 'assign', recipient: input.members.find((m: { name: string }) => m.name === 'Worker').id }) : 'finished';
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    };
    if (released) respond(); else waiting.push(respond);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function post(path: string, body: unknown) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok); return response.json();
  }
  try {
    const worker = await post('/api/agents', { id: randomUUID(), name: 'Worker', model: 'fixture', instructions: 'Execute.' });
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const lead = await post('/api/agents', { id: randomUUID(), name: `Lead ${i}`, model: 'fixture', instructions: 'Coordinate.' });
      const channel = await post('/api/channels', { id: randomUUID(), name: `Room ${i}`, instructions: 'Work.', members: [lead.id, worker.id], lead: lead.id });
      const path = `/api/channels/${channel.id}/turns`; paths.push(path);
      await post(path, { id: randomUUID(), text: `Work ${i}`, automatic: true });
    }
    for (let i = 0; waiting.length < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(waiting.length, 4);
    assert.equal((await (await fetch(app.origin + paths[4])).json())[0].status, 'queued');
    waiting.shift()!();
    for (let i = 0; waiting.length < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(waiting.length, 4);
    assert.equal(active, 4);
    released = true;
    waiting.splice(0).forEach(respond => respond());
    for (const path of paths) {
      let turn;
      for (let i = 0; i < 100; i++) {
        turn = (await (await fetch(app.origin + path)).json())[0];
        if (turn.status === 'done') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(turn.status, 'done'); assert.equal(turn.agent, worker.id);
    }
    assert.equal(peak, 4);
  } finally {
    await app.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
