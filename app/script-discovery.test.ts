import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('duplicate discovery startup cannot interrupt the owning server task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-discovery-owner-'));
  let called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const provider = createServer(async (req, _res) => { for await (const _chunk of req) {} called(); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(root, 'db.sqlite'), scriptDirectory: join(root, 'scripts'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  const app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); assert(res.ok, JSON.stringify(value)); return value;
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'test', instructions: 'Help' });
    const path = `/api/agents/${agent.id}/turns`, id = randomUUID();
    await request(path, { id, text: 'Hold' }); await started;
    await assert.rejects(startApp(options));
    assert.equal((await request(path))[0].status, 'running');
    await request(`${path}/${id}/cancel`, { id: randomUUID() });
  } finally {
    await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('private script discovery follows live grants, rotates on restart and preserves foreign files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-discovery-'));
  const directory = join(root, 'scripts'), file = join(directory, 'connection.json');
  const options = { database: join(root, 'db.sqlite'), scriptDirectory: directory };
  let app = await startApp(options);
  let closed = false;
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); assert(res.ok, JSON.stringify(value)); return value;
  }
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  try {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert(!existsSync(file));
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'test', instructions: 'Help' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'test', instructions: 'Help' });
    const path = `/api/agents/${a.id}/scripts`;
    assert.equal((await request(path)).configured, true);
    const enable = { id: randomUUID(), revision: 0, enabled: true };
    writeFileSync(file, 'preserve', { mode: 0o600 });
    const failed = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(enable) });
    assert.equal(failed.status, 500); await failed.arrayBuffer();
    assert.equal(readFileSync(file, 'utf8'), 'preserve'); unlinkSync(file);
    await request(path, enable);
    const first = read(); assert.equal(first.url, app.origin); assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    const response = await fetch(first.url + `/api/scripts/agents/${a.id}/provider`, { headers: { Authorization: `Bearer ${first.token}` } });
    assert.equal(response.status, 200); assert(!(await response.text()).includes(first.token));
    await request(`/api/agents/${b.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    await request(path, { id: randomUUID(), revision: 1, enabled: false }); assert.deepEqual(read(), first);
    await request(`/api/agents/${b.id}/scripts`, { id: randomUUID(), revision: 1, enabled: false }); assert(!existsSync(file));
    await request(path, enable); assert(!existsSync(file), 'historical enabled receipt must not republish revoked access');
    await request(path, { id: randomUUID(), revision: 2, enabled: true });
    await app.close(); assert(!existsSync(file)); assert(!existsSync(join(directory, 'owner.lock')));
    app = await startApp(options);
    const second = read(); assert.notEqual(second.token, first.token); assert.equal(second.url, app.origin);
    const stale = await fetch(app.origin + `/api/scripts/agents/${a.id}/provider`, { headers: { Authorization: `Bearer ${first.token}` } });
    assert.equal(stale.status, 403); await stale.arrayBuffer();
    await assert.rejects(startApp({ ...options, database: join(root, 'competing.sqlite') }));
    assert.deepEqual(read(), second);
    await app.close();
    closed = true;
    writeFileSync(file, 'foreign', { mode: 0o600 });
    t.mock.timers.enable({ apis: ['setInterval'] });
    await assert.rejects(startApp(options)); assert.equal(readFileSync(file, 'utf8'), 'foreign');
    assert.doesNotThrow(() => t.mock.timers.tick(250), 'Failed startup must stop DB workers before closing DB');
    assert(!existsSync(join(directory, 'owner.lock')));
  } finally { if (!closed) await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('discovery rejects unsafe directories and symlink destinations without changing targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-discovery-boundary-'));
  const database = join(root, 'db.sqlite');
  const start = (scriptDirectory: string) => startApp({ database, scriptDirectory });
  try {
    const unsafe = join(root, 'unsafe'); mkdirSync(unsafe, { mode: 0o755 });
    await assert.rejects(start(unsafe), /must be private/);
    const link = join(root, 'link'); symlinkSync(unsafe, link);
    await assert.rejects(start(link), /must be private/);
    const directory = join(root, 'private'), target = join(root, 'target');
    const app = await start(directory);
    try {
      writeFileSync(target, 'preserve');
      symlinkSync(target, join(directory, 'connection.json'));
      const send = (path: string, body: unknown) => fetch(app.origin + path, {
        method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const agent = randomUUID();
      assert((await send('/api/agents', { id: agent, runtime: 'api', name: 'Fixture', model: 'test', instructions: 'Help' })).ok);
      assert.equal((await send(`/api/agents/${agent}/scripts`, { id: randomUUID(), revision: 0, enabled: true })).status, 500);
      assert.equal(readFileSync(target, 'utf8'), 'preserve');
    } finally { await app.close(); }
    assert(lstatSync(join(directory, 'connection.json')).isSymbolicLink());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
