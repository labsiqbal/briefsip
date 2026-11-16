import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('history pages preserve order and conversation boundaries across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-history-'));
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function post(path: string, data: unknown) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert(response.ok, await response.clone().text()); return response.json();
  }
  async function get(path: string) { const response = await fetch(app.origin + path); assert.equal(response.status, 200); return response.json(); }
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Reader', model: 'fixture', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'History', instructions: 'Help.', lead: agent.id, members: [agent.id] });
    const side = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' });
    const paths = [`/api/agents/${agent.id}/turns`, `/api/channels/${channel.id}/turns`, `/api/threads/${side.id}/turns`];
    for (const path of paths) {
      for (let n = 0; n < 205; n++) {
        const id = randomUUID(); await post(path, { id, text: `${path} message ${n}` });
        let done = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await get(path)).at(-1)?.status === 'done') { done = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert(done);
      }
    }
    await app.close(); app = await startApp(options);
    for (const path of paths) {
      const recent = await get(path); assert.equal(recent.length, 100);
      assert.equal(recent[0].text, `${path} message 105`);
      const older = await get(`${path}?before=${recent[0].seq}`);
      assert.equal(older.length, 100);
      const oldest = await get(`${path}?before=${older[0].seq}`);
      const all = [...oldest, ...older, ...recent];
      assert.deepEqual(all.map(row => row.text), Array.from({ length: 205 }, (_, n) => `${path} message ${n}`));
      assert.equal((await get(`${path}?before=${oldest[0].seq}`)).length, 0);
      assert.equal(new Set(all.map(row => row.id)).size, 205);
      const search = await get(`${path}?q=message%201`);
      assert.equal(search.length, 100);
      const searchOlder = await get(`${path}?q=message%201&before=${search[0].seq}`);
      assert.deepEqual([...searchOlder, ...search].map(row => row.id), all.filter(row => row.text.includes('message 1')).map(row => row.id));
      assert.equal((await get(`${path}?q=Done.`)).length, 100);
      assert.deepEqual((await get(`${path}?q=${encodeURIComponent(' message 1')}`)).map((row: { id: string }) => row.id), search.map((row: { id: string }) => row.id));
      assert.deepEqual(await get(`${path}?q=${encodeURIComponent(' message 1 ')}`), []);
      assert.equal((await get(`${path}?q=MESSAGE`)).length, 100);
      const selected = await get(`${path}?focus=${oldest[0].id}`);
      assert.deepEqual(selected.map((row: { id: string }) => row.id), [oldest[0].id]);
      for (const foreign of paths.filter(other => other !== path)) assert.equal((await fetch(`${app.origin}${foreign}?focus=${oldest[0].id}`)).status, 404);
      for (const query of ['', ' ', 'a'.repeat(201)]) assert.equal((await fetch(`${app.origin}${path}?q=${encodeURIComponent(query)}`)).status, 400);
      assert.equal((await fetch(`${app.origin}${path}?q=message&focus=${oldest[0].id}`)).status, 400);
      assert.equal((await fetch(`${app.origin}${path}?focus=invalid`)).status, 404);
      const literal = "100%_ ' OR 1=1 -- 日本語";
      const literalId = randomUUID();
      await post(path, { id: literalId, text: literal });
      assert.deepEqual((await get(`${path}?q=${encodeURIComponent(literal)}`)).map((row: { id: string }) => row.id), [literalId]);
      await post(path, { id: randomUUID(), text: 'New arrival' });
      assert.deepEqual((await get(`${path}?before=${recent[0].seq}`)).map((row: { id: string }) => row.id), older.map((row: { id: string }) => row.id));
      for (const cursor of ['0', '-1', '1.5', 'NaN', '9007199254740992', '']) assert.equal((await fetch(`${app.origin}${path}?before=${cursor}`)).status, 400);
    }
    assert.equal((await fetch(`${app.origin}${paths[1]}?before=2&focus=${randomUUID()}`)).status, 400);
  } finally {
    await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
