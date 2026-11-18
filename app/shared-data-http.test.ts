import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { restoreWorkspace } from './test-support/backup.ts';

test('shared data agent tools journal once across resume, user reads/drop and restored workspace retain data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-data-http-'));
  let fail = false;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), prompt = body.messages.filter((m: any) => m.role === 'user').at(-1).content;
    const result = body.messages.filter((m: any) => m.role === 'tool').at(-1);
    if (result && fail) { fail = false; res.writeHead(503); res.end(); return; }
    const call = { id: 'sql-call', type: 'function', function: { name: prompt === 'list' ? 'list_data_tables' : 'query_data', arguments: JSON.stringify(prompt === 'list' ? {} : { sql: prompt }) } };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message: result ? { content: result.content } : { tool_calls: [call] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  const get = async (path: string) => { const r = await fetch(app.origin + path); assert(r.ok); return r.json(); };
  const post = async (path: string, data: unknown, status = 200) => {
    const r = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const value = await r.json(); assert.equal(r.status, status, JSON.stringify(value)); return value;
  };
  const until = async (path: string, id: string, status: string) => {
    for (let n = 0; n < 300; n++) { const row = (await get(path)).find((row: any) => row.id === id); if (row?.status === status) return row; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Turn did not finish');
  };
  const query = async (path: string, text: string) => { const id = randomUUID(); await post(path, { id, text }, 202); return JSON.parse((await until(path, id, 'done')).reply); };
  try {
    const a = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Creator', model: 'fixture', instructions: 'Use SQL' }, 201);
    const b = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Writer', model: 'fixture', instructions: 'Use SQL' }, 201);
    const ap = `/api/agents/${a.id}/turns`, bp = `/api/agents/${b.id}/turns`;
    assert.equal((await query(ap, 'CREATE TABLE things(id INTEGER PRIMARY KEY, text TEXT)')).revision, 1);
    fail = true; const insertion = { id: randomUUID(), text: "INSERT INTO things(text) VALUES ('saved once')" };
    await post(bp, insertion, 202); const failed = await until(bp, insertion.id, 'failed');
    await app.close(); app = await startApp(options);
    await post(bp, insertion, 202); await post(`${bp}/${insertion.id}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true });
    assert.equal(JSON.parse((await until(bp, insertion.id, 'done')).reply).changes, 1);
    assert.deepEqual((await query(ap, 'SELECT * FROM things')).rows, [[1, 'saved once']]);
    assert.match((await query(bp, 'DROP TABLE things')).error, /authorized/);
    assert.equal((await query(bp, 'list')).tables[0].owner, a.id);
    const listing = await get('/api/data'); assert.equal(listing.tables[0].name, 'things');
    await post('/api/data/query', { id: randomUUID(), revision: listing.revision, sql: 'DELETE FROM things' }, 400);
    const read = { id: randomUUID(), revision: listing.revision, sql: 'SELECT * FROM things' };
    const viewed = await post('/api/data/query', read); assert.deepEqual(viewed.rows, [[1, 'saved once']]); assert.deepEqual(await post('/api/data/query', read), viewed);
    // Existing backup endpoint includes the embedded database image and ownership metadata.
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) }); assert(backup.ok); const backupPath = join(dir, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    const drop = { id: randomUUID(), revision: listing.revision, table: 'things' };
    const removed = await post('/api/data/drop', drop); assert.deepEqual(await post('/api/data/drop', drop), removed);
    assert.deepEqual((await get('/api/data')).tables, []);
    await post('/api/data/drop', { ...drop, id: randomUUID() }, 409);
    await app.close(); const restored = join(dir, 'restored.sqlite'); restoreWorkspace(backupPath, restored); app = await startApp({ ...options, database: restored });
    const restoredList = await get('/api/data'); assert.equal(restoredList.tables[0].owner, a.id);
    assert.deepEqual((await post('/api/data/query', { id: randomUUID(), revision: restoredList.revision, sql: 'SELECT * FROM things' })).rows, [[1, 'saved once']]);
    await post('/api/data/drop', { id: randomUUID(), revision: restoredList.revision, table: 'briefsip_owners' }, 400);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
