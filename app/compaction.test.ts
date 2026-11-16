import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('incremental compaction keeps source scopes, originals, provenance and failure fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-compaction-'));
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
  let app = await startApp(options);
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
    await app.close(); const db = new DatabaseSync(options.database);
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
    await app.close(); const changed = new DatabaseSync(options.database);
    changed.prepare("UPDATE turns SET revision=revision+1 WHERE id=?").run(before.sources[0].id); changed.close(); app = await startApp(options);
    assert.equal(await request(scopes[0].path + '/compaction'), null); await run(scopes[0].path); assert.equal((await request(scopes[0].path + '/compaction')).source_count, 20);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('compaction CAS rejects stale provider responses, changed sources and future snapshots', async () => {
  const { initializeCompaction, compactHistory, readCompaction } = await import('./compaction.ts');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE turns(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,agent TEXT,channel TEXT,thread TEXT,text TEXT,reply TEXT,error TEXT,status TEXT,revision INTEGER,attachments TEXT)');
  initializeCompaction(db);
  const { initializeQuestions } = await import('./questions.ts'); initializeQuestions(db);
  for (let seq = 1; seq <= 70; seq++) db.prepare("INSERT INTO turns VALUES (?,?,?,NULL,NULL,?,'reply',NULL,'done',1,'[]')").run(seq, randomUUID(), 'a', `Message ${seq}`);
  const turn = (seq: number) => { const id = randomUUID(); db.prepare("INSERT INTO turns VALUES (?,?,?,NULL,NULL,'now',NULL,NULL,'running',1,'[]')").run(seq, id, 'a'); return { id, seq, agent: 'a', channel: null, thread: null }; };
  const signal = new AbortController().signal;
  try {
    let release!: (value: string) => void;
    const older = turn(80), newer = turn(81);
    const late = compactHistory(db, older, signal, () => new Promise(resolve => { release = resolve; }));
    await compactHistory(db, newer, signal, async () => 'Newer summary'); release('Stale summary'); await late;
    assert.equal(readCompaction(db, 'agents:a')!.summary, 'Newer summary');
    assert.equal(db.prepare('SELECT status FROM compaction_attempts WHERE turn=?').get(older.id)!.status, 'superseded');
    assert.equal(readCompaction(db, 'agents:a', 10), null);
    let called = false; await compactHistory(db, { ...older, seq: 10 }, signal, async () => { called = true; return 'Bad'; }); assert.equal(called, false);
    const changed = turn(82), pending = compactHistory(db, changed, signal, () => new Promise(resolve => { release = resolve; }));
    db.prepare('UPDATE turns SET revision=2 WHERE seq=21').run(); release('Invalid source'); await pending;
    assert.equal(readCompaction(db, 'agents:a')!.summary, 'Newer summary');
    assert.equal(db.prepare('SELECT status FROM compaction_attempts WHERE turn=?').get(changed.id)!.status, 'superseded');
    const invalid = turn(83); await compactHistory(db, invalid, signal, async () => 'x'.repeat(6001));
    assert.equal(db.prepare('SELECT status FROM compaction_attempts WHERE turn=?').get(invalid.id)!.status, 'failed');
    const cancelled = turn(84), controller = new AbortController();
    const stop = compactHistory(db, cancelled, controller.signal, () => new Promise(resolve => { release = resolve; }));
    controller.abort(); release('Cancelled summary'); await stop; assert.equal(readCompaction(db, 'agents:a')!.summary, 'Newer summary');
    db.prepare('UPDATE turns SET revision=2 WHERE seq=1').run(); assert.equal(readCompaction(db, 'agents:a'), null);
  } finally { db.close(); }
});
