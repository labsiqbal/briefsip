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
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); const text = data.messages.at(-1).content;
    calls.push(text);
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
    await app.close();
    app = await startApp({ database: options.database });
    assert.equal((await request('/api/agents')).body.configured, false);
    assert.equal((await request(path, { id: randomUUID(), text: 'no provider' })).status, 503);
    assert.equal((await request(path)).body.length, 4);
  } finally {
    await app.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
