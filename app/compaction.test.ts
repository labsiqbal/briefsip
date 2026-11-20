import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { testDatabase } from './test-support/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('incremental compaction keeps source scopes, originals, provenance and failure fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-compaction-'));
  let fail = false, hold = false, held = false, channelRecipient = '';
  const summaries: any[] = [], prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    if (data.messages[0].content.startsWith('Summarize conversation history')) {
      assert.equal(data.tools, undefined); const input = JSON.parse(data.messages[1].content); summaries.push(input);
      if (hold) { held = true; return; }
      if (fail) { res.writeHead(503); return res.end('{}'); }
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: (input.previous ?? '') + input.messages.map((m: any) => `${m.text}:${m.id}`).join('\n') } }] }));
    }
    prompts.push(JSON.stringify(data.messages));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { timeout: 1000, database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  async function until(read: () => Promise<any>, predicate: (value: any) => boolean) {
    for (let n = 0; n < 200; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Compaction task did not settle');
  }
  async function run(path: string) {
    const id = randomUUID(); await request(path + '/turns', { id, text: 'Continue', ...(path.includes('/channels/') ? { recipient: channelRecipient } : {}) });
    const rows = await until(() => request(path + '/turns'), rows => ['done', 'failed'].includes(rows.find((r: any) => r.id === id)?.status));
    assert.equal(rows.find((r: any) => r.id === id).status, 'done'); return id;
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    channelRecipient = a.id;
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const c = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', lead: a.id, members: [a.id, b.id] });
    const thread = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const scopes = [
      { path: `/api/agents/${a.id}`, agent: a.id, channel: null, thread: null, marker: 'DIRECT_A' },
      { path: `/api/agents/${b.id}`, agent: b.id, channel: null, thread: null, marker: 'DIRECT_B' },
      { path: `/api/channels/${c.id}`, agent: a.id, channel: c.id, thread: null, marker: 'SHARED_C' },
      { path: `/api/threads/${thread.id}`, agent: a.id, channel: null, thread: thread.id, marker: 'SIDE_A' },
    ];
    await app.close(); const db = testDatabase(options.database);
    for (const scope of scopes) for (let n = 0; n < 65; n++) db.prepare("INSERT INTO turns(id,agent,channel,thread,text,reply,status,created) VALUES (?,?,?,?,?,?,'done',?)").run(randomUUID(), scope.agent, scope.channel, scope.thread, `${scope.marker}_${n}`, `Reply ${n}`, new Date().toISOString());
    const firstSource = db.prepare('SELECT id FROM turns ORDER BY seq LIMIT 1').get()!.id;
    db.prepare('INSERT INTO questions VALUES (?,?,?,?,?,?,?,0,0)').run(randomUUID(), firstSource, 'question', '{}', 'Decision?', '[]', 'IMPORTANT_DECISION');
    db.close(); app = await startApp(options);
    for (const scope of scopes) {
      await run(scope.path); const first = await request(scope.path + '/compaction');
      assert.equal(first.source_count, 20); assert.equal(first.sources.length, 20); assert.equal(first.next_after, null);
      assert.equal(summaries.at(-1).messages.length, 20); if (scope === scopes[0]) assert.match(JSON.stringify(summaries.at(-1)), /IMPORTANT_DECISION/); assert.match(prompts.at(-1)!, /Earlier conversation summary/);
      for (const other of scopes.filter(s => s !== scope)) { assert(!JSON.stringify(summaries.at(-1)).includes(other.marker)); assert(!prompts.at(-1)!.includes(other.marker)); }
      await run(scope.path); const second = await request(scope.path + '/compaction');
      assert.equal(second.source_count, 26); assert.equal((await request(scope.path + '/compaction?after=' + second.next_after)).sources.length, 6);
      assert.equal((await request(scope.path + '/turns')).length, 67); assert((await request(scope.path + '/turns')).some((r: any) => r.text === scope.marker + '_0'));
    }
    const usage = await request('/api/usage'); assert.equal(usage.calls.filter((r: any) => r.phase === 'compaction').length, 8);
    fail = true; const before = await request(scopes[0].path + '/compaction'); await run(scopes[0].path);
    assert.deepEqual(await request(scopes[0].path + '/compaction'), before); assert.match(prompts.at(-1)!, /DIRECT_A_0/); fail = false;
    hold = true; await run(scopes[0].path); assert.match(prompts.at(-1)!, /DIRECT_A_0/); held = false;
    hold = true; const id = randomUUID(), path = scopes[1].path + '/turns'; await request(path, { id, text: 'Interrupted summary' });
    await until(async () => held, Boolean); await app.close(); hold = false; app = await startApp(options);
    const stopped = (await request(path)).find((r: any) => r.id === id), calls = summaries.length;
    await request(`${path}/${id}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true });
    await until(() => request(path), rows => rows.find((r: any) => r.id === id)?.status === 'done'); assert.equal(summaries.length, calls);
    await app.close(); const changed = testDatabase(options.database);
    changed.prepare("UPDATE turns SET revision=revision+1 WHERE id=?").run(before.sources[0].id); changed.close(); app = await startApp(options);
    assert.equal(await request(scopes[0].path + '/compaction'), null); await run(scopes[0].path); assert.equal((await request(scopes[0].path + '/compaction')).source_count, 20);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('Rust compaction fences stale responses, changed sources, cancelled turns and future watermarks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-compaction-fences-'));
  const database = join(directory, 'state.sqlite');
  let held: ServerResponse | undefined, summaryCalls = 0, deferSummary = false;
  let lastPrompt = '';
  const finish = (res: ServerResponse, content: string) => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { messages } = JSON.parse(raw);
    if (messages[0].content.startsWith('Summarize conversation history')) {
      summaryCalls++;
      if (deferSummary) { held = res; return; }
      return finish(res, 'Original summary');
    }
    lastPrompt = messages[0].content;
    finish(res, 'Done');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const options = { database, baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory, servers: [provider] });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, {
      method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    assert(response.ok, JSON.stringify(value));
    return value;
  }
  async function until(check: () => Promise<boolean> | boolean) {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Compaction fence did not settle');
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), runtime: 'api', name: 'Compaction', model: 'fixture', instructions: 'Help.' });
    const path = `/api/agents/${agent.id}`, scope = `agents:${agent.id}`;
    const db = testDatabase(database);
    try {
      const seed = db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES (?,?,?,?,'2026-01-01')");
      db.exec('BEGIN IMMEDIATE');
      for (let index = 1; index <= 70; index++) seed.run(randomUUID(), agent.id, `Message ${index}`, 'done');
      db.exec('COMMIT');
      const settled = async (id: string, state = 'done') => until(async () => (await request(path + '/turns')).some((turn: { id: string; status: string }) => turn.id === id && turn.status === state));
      const submit = async () => {
        const id = randomUUID();
        await request(path + '/turns', { id, text: 'Continue' });
        return id;
      };
      const waitForSummary = async () => {
        deferSummary = true;
        held = undefined;
        const id = await submit();
        await until(() => !!held);
        assert(held);
        return { id, response: held as ServerResponse };
      };
      const attempt = (id: string) => db.prepare('SELECT status FROM compaction_attempts WHERE turn=?').get(id)?.status;

      await settled(await submit());
      const first = await request(path + '/compaction');
      assert.equal(first.summary, 'Original summary');
      const stale = await waitForSummary();
      db.prepare("UPDATE compactions SET version=?,summary='Newer summary' WHERE scope=?").run(randomUUID(), scope);
      finish(stale.response, 'Stale summary');
      await settled(stale.id);
      assert.equal(attempt(stale.id), 'superseded');
      assert.equal((await request(path + '/compaction')).summary, 'Newer summary');

      const changed = await waitForSummary();
      db.prepare('UPDATE turns SET revision=revision+1 WHERE seq=?').run(first.through + 1);
      finish(changed.response, 'Invalid source summary');
      await settled(changed.id);
      assert.equal(attempt(changed.id), 'superseded');

      const oversized = await waitForSummary();
      finish(oversized.response, 'x'.repeat(6001));
      await settled(oversized.id);
      assert.equal(attempt(oversized.id), 'failed');

      const cancelled = await waitForSummary();
      await request(`${path}/turns/${cancelled.id}/cancel`, { id: randomUUID() });
      finish(cancelled.response, 'Cancelled summary');
      await settled(cancelled.id, 'cancelled');
      assert.equal((await request(path + '/compaction')).summary, 'Newer summary');

      await app.close();
      const future = randomUUID();
      seed.run(future, agent.id, 'Position before the snapshot', 'queued');
      db.prepare('INSERT INTO queue_positions VALUES (?,10)').run(future);
      const before = summaryCalls;
      app = await startApp(options);
      await settled(future);
      assert.equal(summaryCalls, before);
      assert.equal(attempt(future), undefined);
      assert(!lastPrompt.includes('Newer summary'));

      db.prepare('UPDATE turns SET revision=revision+1 WHERE seq=1').run();
      assert.equal(await request(path + '/compaction'), null);
    } finally { db.close(); }
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
