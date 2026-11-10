import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreWorkspace } from './backup.ts';
import { startApp } from './server.ts';

test('agent event waits release workers, survive restart, honor pause and accept once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-turn-events-'));
  const prompts: string[] = [];
  let continuations = 0, invalid = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    prompts.push(raw); const { messages } = JSON.parse(raw);
    const received = messages.some((m: any) => m.role === 'tool');
    const ordinary = messages.findLast((m: any) => m.role === 'user').content === 'ordinary';
    if (received) continuations++;
    res.end(JSON.stringify({ choices: [{ finish_reason: received || ordinary ? 'stop' : 'tool_calls', message: received || ordinary ? { content: 'Finished' } : { tool_calls: [{ id: 'wait', type: 'function', function: { name: 'wait_for_event', arguments: JSON.stringify({ event: 'ready', timeoutSeconds: invalid ? 0 : 3600 }) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected?: number) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); if (expected) assert.equal(res.status, expected, JSON.stringify(value)); else assert(res.ok, JSON.stringify(value)); return value;
  }
  async function until(path: string, id: string, predicate: (row: any) => boolean) {
    for (let n = 0; n < 200; n++) { const row = (await request(path)).find((r: any) => r.id === id); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Turn did not settle');
  }
  async function waiting(path: string) { const id = randomUUID(); await request(path, { id, text: id }); return until(path, id, row => row.events?.length); }
  async function send(connection: any, id = randomUUID(), expected = 200) {
    const body = JSON.stringify({ event: 'ready', payload: 'synthetic' }), time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', connection.secret).update(`${time}\n${id}\n${body}`).digest('hex');
    const res = await fetch(app.origin + new URL(connection.url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': signature }, body });
    const value = await res.json(); assert.equal(res.status, expected, JSON.stringify(value)); return value;
  }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const direct = `/api/agents/${a.id}/turns`;
    const first = await waiting(direct), connection = await request(`/api/turn-waits/${first.events[0].id}`);
    for (const [name, value] of [['Origin', 'https://foreign.test'], ['Sec-Fetch-Site', 'cross-site']]) {
      const headers = { [name]: value };
      const denied = await fetch(connection.url, { headers }); assert.equal(denied.status, 403); assert(!(await denied.text()).includes(connection.secret));
    }
    await send({ ...connection, secret: 'wrong' }, randomUUID(), 401);
    assert.equal(first.status, 'queued'); assert.equal(first.paused, 0); assert(!JSON.stringify(first).includes(connection.secret));
    const other = randomUUID(); await request(direct, { id: other, text: 'ordinary' }); await until(direct, other, row => row.status === 'done');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(`/api/turn-waits/${first.events[0].id}`), { ...connection, url: app.origin + new URL(connection.url).pathname });
    await request(`${direct}/${first.id}/pause`, { id: randomUUID(), revision: first.revision });
    const delivery = randomUUID(), receipt = await send(connection, delivery); assert.deepEqual(await send(connection, delivery), receipt);
    const still = (await request(direct)).find((r: any) => r.id === first.id); assert.equal(still.paused, 1); assert.equal(continuations, 0);
    await request(`${direct}/${first.id}/resume`, { id: randomUUID(), revision: still.revision }); await until(direct, first.id, row => row.status === 'done'); assert.equal(continuations, 1);
    assert(!prompts.join('').includes(connection.secret));
    await app.close(); app = await startApp(options); assert.deepEqual(await send(connection, delivery), receipt); assert.equal(continuations, 1);
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const sidePath = `/api/threads/${side.id}/turns`, sideTurn = await waiting(sidePath);
    assert(!(await request(direct)).some((r: any) => r.id === sideTurn.id));
    const sideConnection = await request(`/api/turn-waits/${sideTurn.events[0].id}`);
    await request(`${sidePath}/${sideTurn.id}/cancel`, { id: randomUUID() }); await send(sideConnection, randomUUID(), 409);
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Events', instructions: 'Help', lead: a.id, members: [a.id] });
    const channelPath = `/api/channels/${channel.id}/turns`, channelTurn = await waiting(channelPath);
    const channelConnection = await request(`/api/turn-waits/${channelTurn.events[0].id}`);
    await request(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: 1, name: 'Events', instructions: 'Help', members: [a.id], lead: a.id, archived: true });
    await send(channelConnection, randomUUID(), 409); await request(new URL(channelConnection.url).pathname, undefined, 404);
    const pending = await waiting(direct), pendingConnection = await request(`/api/turn-waits/${pending.events[0].id}`);
    const pausedPending = await request(`${direct}/${pending.id}/pause`, { id: randomUUID(), revision: pending.revision });
    await request(`${direct}/${pending.id}/resume`, { id: randomUUID(), revision: pausedPending.revision });
    await request(`${direct}/${pending.id}/reassign`, { id: randomUUID(), revision: pausedPending.revision + 1, recipient: a.id }, 409);
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(backup.status, 200); const backupPath = join(dir, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    await app.close(); app = await startApp({ ...options, database: restoreWorkspace(backupPath, join(dir, 'restored.sqlite')) });
    await request(new URL(pendingConnection.url).pathname, undefined, 404); await send(pendingConnection, randomUUID(), 409);
    const recovered = (await request(direct)).find((r: any) => r.id === pending.id); assert.equal(recovered.events[0].status, 'closed');
    await app.close(); app = await startApp(options);
    const expiring = await waiting(direct); await app.close();
    const db = new DatabaseSync(options.database); db.prepare('UPDATE turn_waits SET deadline=0 WHERE turn=?').run(expiring.id); db.close();
    app = await startApp(options); const expired = await until(direct, expiring.id, row => row.status === 'failed'); assert.equal(expired.events[0].status, 'expired');
    invalid = true; const bad = randomUUID(); await request(direct, { id: bad, text: bad }); const failed = await until(direct, bad, row => row.status === 'failed'); assert.match(failed.error, /Nama event atau batas tunggu/);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
