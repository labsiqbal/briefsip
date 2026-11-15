import { DatabaseSync } from 'node:sqlite';
import { initializeConversations, maintainConversations, listConversations, conversationSettings, recordDeliveryConversation, deliveryName } from './conversations.ts';
import { restoreThreadCommand } from './thread-command.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('side threads isolate queues, history, controls and archive recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-threads-'));
  const calls: { text: string; history: string[] }[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), text = data.messages.at(-1).content;
    calls.push({ text, history: data.messages.map((message: { content: string }) => message.content) });
    if (text.startsWith('hold')) return;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `reply:${text}` } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function post(path: string, data: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  }
  async function get(path: string) { return (await fetch(app.origin + path)).json(); }
  async function wait(path: string, id: string, status: string) {
    for (let i = 0; i < 150; i++) {
      const row = (await get(path)).find((turn: { id: string }) => turn.id === id);
      if (row?.status === status) return row;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${status}`);
  }
  try {
    const agent = await post('/api/agents', { id: randomUUID(), name: 'Same agent', threadLimit: 4, model: 'fixture', instructions: 'Help.' }, 201);
    const list = `/api/agents/${agent.id}/threads`, main = `/api/agents/${agent.id}/turns`;
    const create = { id: randomUUID(), name: 'Side work' };
    const side = await post(list, create), path = `/api/threads/${side.id}/turns`;
    assert.deepEqual(await post(list, create), side);
    await post(list, { ...create, name: 'Other name' }, 409);
    const mainHold = randomUUID();
    await post(main, { id: mainHold, text: 'hold-main' }, 202); await wait(main, mainHold, 'running');
    const first = randomUUID(); await post(path, { id: first, text: 'side-one' }, 202); await wait(path, first, 'done');
    assert.equal((await get(main)).length, 1);
    assert.equal((await get(path)).length, 1);
    assert.equal((await get(main))[0].status, 'running');
    await post(`${main}/${first}/cancel`, { id: randomUUID() }, 404);
    await post(main, { id: first, text: 'side-one' }, 409);
    const second = randomUUID(); await post(path, { id: second, text: 'side-two' }, 202); await wait(path, second, 'done');
    assert(calls.find(call => call.text === 'side-two')!.history.includes('reply:side-one'));
    assert(!calls.find(call => call.text === 'side-two')!.history.includes('hold-main'));
    await post(`/api/threads/${side.id}/delete`, { id: randomUUID(), revision: 0 }, 400);
    const held = randomUUID(); await post(path, { id: held, text: 'hold-side' }, 202); await wait(path, held, 'running');
    await post(`/api/threads/${side.id}/delete`, { id: randomUUID(), revision: 1 }, 409);
    const queued = randomUUID(); await post(path, { id: queued, text: 'queued-side' }, 202);
    await post(`${path}/${queued}/pause`, { id: randomUUID(), revision: 1 });
    await post(`${path}/${held}/cancel`, { id: randomUUID() }); await wait(path, held, 'cancelled');
    assert.equal((await get(main))[0].status, 'running');
    await app.close(); app = await startApp(options);
    assert.equal((await wait(path, queued, 'queued')).paused, 1);
    assert(!calls.some(call => call.text === 'queued-side'));
    await post(`${path}/${queued}/resume`, { id: randomUUID(), revision: 2 }); await wait(path, queued, 'done');
    assert.equal(calls.filter(call => call.text === 'queued-side').length, 1);
    const archivedWork = randomUUID(); await post(path, { id: archivedWork, text: 'hold-archive' }, 202); await wait(path, archivedWork, 'running');
    const archive = { id: randomUUID(), revision: 1, name: 'Archived side', archived: true };
    const archived = await post(`/api/threads/${side.id}/edit`, archive);
    assert.equal(archived.archived, 1); await wait(path, archivedWork, 'cancelled');
    await post(path, { id: randomUUID(), text: 'blocked' }, 409);
    await post(`/api/threads/${side.id}/edit`, { ...archive, id: randomUUID(), revision: 2, archived: false });
    assert.deepEqual(await post(`/api/threads/${side.id}/edit`, archive), archived);
    assert.equal((await get(list))[0].archived, 0);
    assert.equal(calls.filter(call => call.text === 'hold-archive').length, 1);
    await post(`/api/threads/${side.id}/edit`, { ...archive, id: randomUUID(), revision: 3 });
    const deletion = { id: randomUUID(), revision: 4 };
    const deleted = await post(`/api/threads/${side.id}/delete`, deletion);
    assert.equal(deleted.deleted, 1); assert.deepEqual(await post(`/api/threads/${side.id}/delete`, deletion), deleted);
    assert.deepEqual(await get(list), []);
    assert.equal((await fetch(app.origin + path)).status, 404);
    await post(list, create);
    assert.deepEqual(await get(list), []);
    const mainReply = randomUUID();
    await post(main, { id: mainReply, text: 'main-after-side' }, 202); await wait(main, mainReply, 'done');
    assert(!calls.find(call => call.text === 'main-after-side')!.history.some(text => text.includes('side-one')));
    const workers: { path: string; id: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const thread = await post(list, { id: randomUUID(), name: `Worker ${i}` });
      const worker = { path: `/api/threads/${thread.id}/turns`, id: randomUUID() };
      workers.push(worker);
      await post(worker.path, { id: worker.id, text: `hold-worker-${i}` }, 202);
      await wait(worker.path, worker.id, i < 4 ? 'running' : 'queued');
    }
    assert(!calls.some(call => call.text === 'hold-worker-4'));
    const fifo = [randomUUID(), randomUUID()];
    for (let i = 0; i < fifo.length; i++) await post(workers[0].path, { id: fifo[i], text: `fifo-${i}` }, 202);
    assert(!calls.some(call => call.text.startsWith('fifo-')));
    await app.close(); app = await startApp(options);
    for (let i = 0; i < 4; i++) {
      await wait(workers[i].path, workers[i].id, 'interrupted');
      assert.equal(calls.filter(call => call.text === `hold-worker-${i}`).length, 1);
    }
    await wait(workers[4].path, workers[4].id, 'running');
    await wait(workers[0].path, fifo[1], 'done');
    assert.deepEqual(calls.filter(call => call.text.startsWith('fifo-')).map(call => call.text), ['fifo-0', 'fifo-1']);
    assert(calls.find(call => call.text === 'fifo-1')!.history.includes('reply:fifo-0'));
    await post(`${workers[4].path}/${workers[4].id}/cancel`, { id: randomUUID() });
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('configured concurrency limits side threads and validates before opening storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-concurrency-'));
  const calls: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const text = JSON.parse(raw).messages.at(-1).content;
    calls.push(text);
    if (text === 'hold') return;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const database = join(dir, 'state.sqlite');
  for (const concurrency of [0, -1, 1.5, 33, NaN, Infinity]) await assert.rejects(startApp({ database, concurrency }), /CONCURRENCY/);
  assert.equal(existsSync(database), false);
  let app = await startApp({ database, concurrency: 1, baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function post(path: string, body: unknown) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok); return response.json();
  }
  try {
    const agent = await post('/api/agents', { id: randomUUID(), name: 'One worker', model: 'fixture', instructions: 'Help.' });
    const main = `/api/agents/${agent.id}/turns`, hold = randomUUID();
    await post(main, { id: hold, text: 'hold' });
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls, ['hold']);
    const thread = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Waiting side' });
    const path = `/api/threads/${thread.id}/turns`;
    await post(path, { id: randomUUID(), text: 'side' });
    assert.equal((await (await fetch(app.origin + path)).json())[0].status, 'queued');
    assert.deepEqual(calls, ['hold']);
    await post(`${main}/${hold}/cancel`, { id: randomUUID() });
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await (await fetch(app.origin + path)).json())[0];
      if (row.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(row.status, 'done'); assert.deepEqual(calls, ['hold', 'side']);
    assert.equal(agent.thread_limit, 2);
    const edit = { ...agent, id: randomUUID(), threadLimit: 1 };
    assert.equal((await post(`/api/agents/${agent.id}/edit`, edit)).thread_limit, 1);
    await app.close(); app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1` });
    assert.equal((await post(`/api/agents/${agent.id}/edit`, edit)).thread_limit, 1);
    const second = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Second side' });
    const otherPath = `/api/threads/${second.id}/turns`;
    const sideHold = randomUUID();
    await post(path, { id: sideHold, text: 'hold' });
    const queuedId = randomUUID(); await post(otherPath, { id: queuedId, text: 'after-limit' });
    assert.equal((await (await fetch(app.origin + otherPath)).json())[0].status, 'queued');
    const separateMain = randomUUID(); await post(main, { id: separateMain, text: 'main-independent' });
    for (let i = 0; i < 100; i++) {
      row = (await (await fetch(app.origin + main)).json()).find((turn: { id: string }) => turn.id === separateMain);
      if (row.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(row.status, 'done'); assert(!calls.includes('after-limit'));
    await post(`${path}/${sideHold}/cancel`, { id: randomUUID() });
    for (let i = 0; i < 100; i++) {
      row = (await (await fetch(app.origin + otherPath)).json())[0];
      if (row.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(row.status, 'done');
    for (const threadLimit of [0, 33, 1.5, null, '2']) {
      const response = await fetch(app.origin + '/api/agents', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), name: 'Invalid', model: 'fixture', instructions: 'Help.', threadLimit }) });
      assert.equal(response.status, 400);
    }
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});


test('conversation commands protect Main chat, revisions, queued work and deleted history across restart', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules/.conversation-controls-'));
  const provider = createServer(() => {}); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function post(path: string, body: unknown, status = 200) { const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; }
  const get = async (path: string) => (await fetch(app.origin + path)).json();
  try {
    const agent = await post('/api/agents', { id: randomUUID(), name: 'Owner agent', model: 'fixture', instructions: 'Help.' }, 201);
    const list = `/api/agents/${agent.id}/threads`;
    const side = await post(list, { id: randomUUID(), name: 'Side task' });
    const edit = `/api/threads/${side.id}/edit`, remove = `/api/threads/${side.id}/delete`, turns = `/api/threads/${side.id}/turns`;
    const rename = { id: randomUUID(), revision: 1, name: 'Renamed task', archived: false };
    const renamed = await post(edit, rename); assert.equal(renamed.revision, 2); assert.equal(renamed.name, 'Renamed task'); assert.deepEqual(await post(edit, rename), renamed);
    await post(edit, { ...rename, id: randomUUID() }, 409); await post(edit, { ...rename, name: 'Conflict' }, 409);
    await post(`/api/threads/${agent.id}/delete`, { id: randomUUID(), revision: 1 }, 404);
    await post(`/api/agents/${agent.id}/delete`, { id: randomUUID(), revision: 1 }, 400);
    const queued = randomUUID(); await post(turns, { id: queued, text: 'Queued task' }, 202);
    await post(remove, { id: randomUUID(), revision: 2 }, 409);
    const second = randomUUID(); await post(turns, { id: second, text: 'Second queued task' }, 202);
    assert.equal((await get(turns)).find((turn: { id: string }) => turn.id === second).status, 'queued');
    const archive = { id: randomUUID(), revision: 2, name: renamed.name, archived: true };
    const archived = await post(edit, archive); assert.equal(archived.revision, 3); assert.equal((await get(turns))[0].status, 'cancelled'); assert.deepEqual(await post(edit, archive), archived);
    const restore = { id: randomUUID(), revision: 3, name: renamed.name, archived: false };
    const restored = await post(edit, restore); assert.equal(restored.revision, 4); assert.equal(restored.archived, 0); assert.deepEqual(await post(edit, restore), restored);
    const deletion = { id: randomUUID(), revision: 4 }; const deleted = await post(remove, deletion); assert.equal(deleted.deleted, 1); assert.equal(deleted.revision, 5); assert.deepEqual(await post(remove, deletion), deleted);
    await post(remove, { ...deletion, revision: 3 }, 409); assert.deepEqual(await get(list), []); assert.equal((await fetch(app.origin + turns)).status, 404);
    assert.deepEqual(await get('/api/conversations/settings'), { autoArchive: true });
    await post('/api/conversations/settings', { id: randomUUID(), autoArchive: 'yes' }, 400);
    await post('/api/conversations/settings', { id: randomUUID(), autoArchive: false });
    await app.close(); app = await startApp(options); assert.deepEqual(await post(remove, deletion), deleted); assert.deepEqual(await get(list), []); assert.deepEqual(await get('/api/conversations/settings'), { autoArchive: false });
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('delivery origin migration, activity ordering, rename retention and seven-day archive use a fake clock', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,agent TEXT,name TEXT,revision INTEGER DEFAULT 1,archived INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0);
    CREATE TABLE turns(seq INTEGER,id TEXT PRIMARY KEY,thread TEXT,agent TEXT,parent TEXT,origin TEXT,text TEXT,status TEXT,paused INTEGER DEFAULT 0,reply TEXT);
    CREATE TABLE agent_deliveries(turn TEXT,request TEXT); CREATE TABLE agent_requests(id TEXT,turn TEXT); CREATE TABLE local_project_threads(thread TEXT);`);
  try {
    db.exec(`INSERT INTO agents VALUES ('helper','Helper'),('lead','Right Hand');
      INSERT INTO threads(id,agent,name) VALUES ('legacy','helper','Message from Right Hand'),('peer','helper','Message from Briefsip: omarchy'),('renamed','helper','Owner title'),('owner','helper','Owner side');
      UPDATE threads SET revision=2 WHERE id='renamed';
      INSERT INTO turns VALUES (1,'parent',NULL,'lead',NULL,NULL,'Main','done',0,NULL),(2,'child','legacy','helper','parent',NULL,'Review the release notes','done',0,'Ready'),(3,'remote','peer','helper',NULL,'peer:Briefsip: omarchy','Check cross-machine delivery','done',0,'Ready'),(4,'named','renamed','helper','parent',NULL,'Keep custom title','done',0,'Ready');
      INSERT INTO agent_requests VALUES ('request','parent'); INSERT INTO agent_deliveries VALUES ('child','request'),('named','request');`);
    initializeConversations(db);
    assert.equal(db.prepare("SELECT name FROM threads WHERE id='legacy'").get()!.name, 'Right Hand asked: Review the release notes');
    assert.equal(db.prepare("SELECT name FROM threads WHERE id='peer'").get()!.name, 'Briefsip on omarchy: Check cross-machine delivery');
    assert.equal(db.prepare("SELECT name FROM threads WHERE id='renamed'").get()!.name, 'Owner title');
    assert.equal(listConversations(db, 'helper').filter(row => row.delivery).length, 3);
    db.exec("UPDATE delivery_conversations SET activity=1 WHERE thread='legacy'; UPDATE delivery_conversations SET activity=2 WHERE thread='peer'");
    assert(listConversations(db, 'helper').findIndex(row => row.id === 'peer') < listConversations(db, 'helper').findIndex(row => row.id === 'legacy'));
    initializeConversations(db); assert.equal(db.prepare("SELECT revision FROM threads WHERE id='legacy'").get()!.revision, 2);
    const day = 86400000, start = 2000000000000;
    maintainConversations(db, start); maintainConversations(db, start + 7 * day - 1); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='peer'").get()!.archived, 0);
    db.exec("INSERT INTO turns VALUES (5,'grandchild',NULL,'helper','remote',NULL,'Still working','queued',1,NULL)");
    maintainConversations(db, start + 7 * day); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='peer'").get()!.archived, 0); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='legacy'").get()!.archived, 1);
    assert.equal(db.prepare("SELECT archived FROM threads WHERE id='owner'").get()!.archived, 0); assert.equal(db.prepare('SELECT sum(deleted) n FROM threads').get()!.n, 0);
    db.exec("UPDATE turns SET status='cancelled',paused=0 WHERE id='grandchild'"); maintainConversations(db, start + 8 * day);
    db.exec('UPDATE conversation_settings SET auto_archive=0'); maintainConversations(db, start + 30 * day); assert.equal(conversationSettings(db).autoArchive, false); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='peer'").get()!.archived, 0);
    db.exec('UPDATE conversation_settings SET auto_archive=1'); maintainConversations(db, start + 30 * day); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='peer'").get()!.archived, 1);
    const archivedRevision = db.prepare("SELECT revision FROM threads WHERE id='peer'").get()!.revision; maintainConversations(db, start + 31 * day); assert.equal(db.prepare("SELECT revision FROM threads WHERE id='peer'").get()!.revision, archivedRevision);
    db.exec("UPDATE threads SET archived=0 WHERE id='peer'; UPDATE delivery_conversations SET settled_at=NULL WHERE thread='peer'"); maintainConversations(db, start + 32 * day); maintainConversations(db, start + 38 * day); assert.equal(db.prepare("SELECT archived FROM threads WHERE id='peer'").get()!.archived, 0);
    db.exec("INSERT INTO threads(id,agent,name) VALUES ('fresh','helper','Pending')"); recordDeliveryConversation(db, 'fresh', 'Right Hand', 'Inspect   this\nrequest'); assert.equal(db.prepare("SELECT name FROM threads WHERE id='fresh'").get()!.name, 'Right Hand asked: Inspect this request');
    assert(deliveryName('Agent', 'x'.repeat(100)).length <= 80);
  } finally { db.close(); }
});

test('conversation recovery retains exact request and refuses corrupt or foreign routes', () => {
  const agent = randomUUID(), thread = randomUUID();
  const command = { path: `/api/threads/${thread}/edit`, data: { id: randomUUID(), revision: 2, name: 'Saved name', archived: true } };
  assert.deepEqual(restoreThreadCommand(JSON.stringify(command), agent), command); assert.equal(restoreThreadCommand(null, agent), null);
  for (const raw of ['{', 'null', '[]', JSON.stringify({ ...command, path: '/api/agents/other/threads' }), JSON.stringify({ ...command, data: { ...command.data, revision: 0 } }), JSON.stringify({ ...command, data: { ...command.data, name: '' } }), JSON.stringify({ ...command, data: { ...command.data, extra: true } })]) assert.throws(() => restoreThreadCommand(raw, agent));
});
