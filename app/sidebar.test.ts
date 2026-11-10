import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { restoreWorkspace } from './backup.ts';
import { parseSections } from './sidebar.ts';

test('sidebar validates unique membership, names, IDs and bounded settings', () => {
  const id = randomUUID(), agent = randomUUID(), section = { id, name: ' Work ', agents: [agent] };
  assert.equal(parseSections([section])[0].name, 'Work');
  for (const value of [null, {}, [null], [{ ...section, name: ' ' }], [{ ...section, name: 'a'.repeat(81) }], [{ ...section, name: 'a\nb' }], [{ ...section, id: '__proto__' }], [section, section], [{ ...section, agents: [agent, agent] }], [section, { ...section, id: randomUUID() }], [{ ...section, agents: ['missing'] }], [{ ...section, privilege: 'admin' }], Array(101).fill(section)]) assert.throws(() => parseSections(value));
});

test('sidebar HTTP edits retain agents/history through delete, conflicts, retry, restart and backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-sidebar-'));
  const provider = createServer(async (request, response) => { for await (const chunk of request) {} response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'History retained.' } }] })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options), restored: Awaited<ReturnType<typeof startApp>> | undefined;
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  try {
    assert.deepEqual(await request('/api/sidebar'), { revision: 0, sections: [] });
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' }, 201);
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' }, 201);
    const historyPath = `/api/agents/${a.id}/turns`;
    await request(historyPath, { id: randomUUID(), text: 'Retain this conversation' }, 202);
    let history;
    for (let attempt = 0; attempt < 100; attempt++) { history = await request(historyPath); if (history[0]?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(history[0].status, 'done');
    const first = { id: randomUUID(), name: 'Projects', agents: [a.id, b.id] }, second = { id: randomUUID(), name: 'Personal', agents: [] as string[] };
    const create = { id: randomUUID(), revision: 0, sections: [first, second] };
    const initial = await request('/api/sidebar', create);
    assert.equal(initial.revision, 1);
    assert.deepEqual(await request('/api/sidebar', create), initial);
    await request('/api/sidebar', { ...create, sections: [] }, 409);
    const edited = await request('/api/sidebar', { id: randomUUID(), revision: 1, sections: [{ ...second, name: 'Reading', agents: [b.id] }, { ...first, agents: [a.id] }] });
    assert.equal(edited.revision, 2); assert.equal(edited.sections[0].name, 'Reading');
    await request('/api/sidebar', { id: randomUUID(), revision: 1, sections: [] }, 409);
    await request('/api/sidebar', { id: randomUUID(), revision: 2, sections: [{ ...first, agents: [randomUUID()] }] }, 404);
    await request('/api/sidebar', { id: randomUUID(), revision: 2, sections: [{ ...first, agents: [a.id, a.id] }] }, 400);
    await request('/api/sidebar?path=other', undefined, 400);
    const foreign = await fetch(app.origin + '/api/sidebar', { method: 'POST', headers: { Origin: 'https://foreign.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), revision: 2, sections: [] }) });
    assert.equal(foreign.status, 403);
    await app.close();
    const seed = new DatabaseSync(options.database);
    seed.exec("CREATE TRIGGER reject_sidebar_receipt BEFORE INSERT ON sidebar_commands BEGIN SELECT RAISE(ABORT,'fixture'); END");
    seed.close(); app = await startApp(options);
    const remove = { id: randomUUID(), revision: 2, sections: [] };
    await request('/api/sidebar', remove, 500);
    assert.deepEqual(await request('/api/sidebar'), edited);
    await app.close();
    const cleanup = new DatabaseSync(options.database); cleanup.exec('DROP TRIGGER reject_sidebar_receipt'); cleanup.close(); app = await startApp(options);
    const empty = await request('/api/sidebar', remove); assert.equal(empty.revision, 3);
    assert.deepEqual(await request('/api/sidebar', create), initial);
    assert.deepEqual(await request('/api/sidebar'), empty);
    assert.deepEqual(await request(historyPath), history);
    assert.equal((await request('/api/agents')).agents.length, 2);
    const [one, two] = await Promise.all([randomUUID(), randomUUID()].map(id => fetch(app.origin + '/api/sidebar', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, revision: 3, sections: [first] }) })));
    assert.deepEqual([one.status, two.status].sort(), [200, 409]);
    const latest = await request('/api/sidebar');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request('/api/sidebar'), latest);
    assert.deepEqual(await request('/api/sidebar', create), initial);
    assert.deepEqual(await request(historyPath), history);
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(backup.status, 200);
    const backupPath = join(directory, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    const restoredPath = restoreWorkspace(backupPath, join(directory, 'restored.sqlite'));
    restored = await startApp({ database: restoredPath });
    assert.deepEqual(await (await fetch(restored.origin + '/api/sidebar')).json(), latest);
  } finally { await restored?.close(); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
