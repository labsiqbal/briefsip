import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';

test('agent memory writes preserve scope, user selection, atomic errors and resume receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-memory-tools-'));
  let args: unknown = { text: 'First memory' }, hold = false, held = false, lastResult: any;
  let beforeWrite: (() => Promise<unknown>) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), results = data.messages.filter((m: any) => m.role === 'tool');
    assert(data.tools.some((tool: any) => tool.function.name === 'remember_memory'));
    if (results.length) {
      lastResult = JSON.parse(results.at(-1).content);
      if (hold) { held = true; return; }
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Saved.' } }] }));
    }
    if (beforeWrite) { const action = beforeWrite; beforeWrite = undefined; await action(); }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'memory-call', type: 'function', function: { name: 'remember_memory', arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  async function until(read: () => Promise<any>, predicate: (value: any) => boolean) {
    for (let n = 0; n < 150; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Memory task did not settle');
  }
  async function run(path: string, extra: Record<string, unknown> = {}) {
    const id = randomUUID(); await request(path, { id, text: 'Remember this', ...extra });
    const rows = await until(() => request(path), rows => ['done', 'failed'].includes(rows.find((r: any) => r.id === id)?.status));
    assert.equal(rows.find((r: any) => r.id === id).status, 'done'); return id;
  }
  const userEdit = (entry: string, revision: number, text: string, essential = false) => ({ id: randomUUID(), entry, revision, text, essential, remove: false });
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'C', instructions: 'Help', lead: a.id, members: [a.id, b.id] });
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const path = `/api/agents/${a.id}/turns`, memory = `/api/agents/${a.id}/memory`, foreign = `/api/agents/${b.id}/memory`, shared = `/api/channels/${channel.id}/memory`;
    hold = true; const task = randomUUID(); await request(path, { id: task, text: 'Remember' });
    await until(async () => held, Boolean);
    const first = (await request(memory)).items[0]; assert.equal(first.text, 'First memory'); assert.equal(first.essential, 0);
    assert.equal((await request(foreign)).items.length, 0); assert.equal((await request(shared)).items.length, 0);
    await app.close();
    const legacy = new DatabaseSync(options.database); legacy.exec('ALTER TABLE flow_tool_calls DROP COLUMN after_action'); legacy.close();
    app = await startApp(options); hold = false;
    await request(memory, userEdit(first.id, 1, 'User corrected', true));
    const interrupted = (await request(path)).find((r: any) => r.id === task); assert.equal(interrupted.status, 'interrupted');
    await request(`${path}/${task}/resume`, { id: randomUUID(), revision: interrupted.revision, acknowledgeUncertain: true });
    await until(() => request(path), rows => rows.find((r: any) => r.id === task)?.status === 'done');
    assert.equal(lastResult.text, 'First memory'); assert.equal(lastResult.revision, 1);
    assert.equal((await request(memory)).items[0].text, 'User corrected'); assert.equal((await request(memory)).items[0].revision, 2);
    args = { id: first.id, revision: 2, text: 'Agent updated' }; await run(path);
    assert.equal(lastResult.essential, 1); assert.equal(lastResult.revision, 3);
    args = { id: first.id, revision: 3, text: 'Stale after user edit' };
    beforeWrite = () => request(memory, userEdit(first.id, 3, 'New user choice', false)); await run(path);
    assert.equal(lastResult.status, 409); assert.equal((await request(memory)).items[0].text, 'New user choice');
    args = { id: first.id, revision: 4, text: 'Side update' }; await run(`/api/threads/${side.id}/turns`); assert.equal(lastResult.essential, 0);
    for (const invalid of [{ id: first.id, revision: 5, text: 'Wrong scope' }, { text: 'Forbidden selection', essential: true }, { text: 'Forbidden owner', owner: a.id }, { id: first.id, text: 'Missing revision' }, { text: 'x'.repeat(2001) }]) {
      args = invalid; await run(`/api/channels/${channel.id}/turns`, { recipient: a.id }); assert([400, 404].includes(lastResult.status)); assert.equal((await request(shared)).items.length, 0);
    }
    args = { text: 'Channel note' }; await run(`/api/channels/${channel.id}/turns`, { recipient: a.id }); assert.equal(lastResult.essential, 0); assert.equal((await request(shared)).items[0].text, 'Channel note');
    await run(`/api/channels/${channel.id}/turns`, { recipient: a.id }); assert.equal(lastResult.status, 409); assert.equal((await request(shared)).items.length, 1);
    await request(memory, userEdit(first.id, 5, '界'.repeat(2000), true));
    const second = randomUUID(); await request(memory, userEdit(second, 0, 'short', true));
    args = { id: second, revision: 1, text: '文'.repeat(2000) }; await run(path); assert.equal(lastResult.status, 413);
    const unchanged = (await request(memory)).items.find((r: any) => r.id === second); assert.equal(unchanged.text, 'short'); assert.equal(unchanged.revision, 1);
    const cancelled = randomUUID(); args = { text: 'Must not exist' }; beforeWrite = () => request(`${path}/${cancelled}/cancel`, { id: randomUUID() });
    await request(path, { id: cancelled, text: 'Cancel before write' }); await until(() => request(path), rows => rows.find((r: any) => r.id === cancelled)?.status === 'cancelled');
    assert.equal((await request(memory + '?query=Must')).items.length, 0);
    await request(memory, { ...userEdit(second, 1, '', false), remove: true });
    args = { id: second, revision: 2, text: 'Deleted note must stay deleted' }; await run(path); assert.equal(lastResult.status, 404);
    assert.equal((await request(memory + '?query=Deleted')).items.length, 0);
    await app.close();
    const fault = new DatabaseSync(options.database); fault.exec("CREATE TRIGGER reject_tool BEFORE INSERT ON flow_tool_calls BEGIN SELECT RAISE(ABORT, 'synthetic journal fault'); END"); fault.close();
    app = await startApp(options); args = { text: 'Atomic failure must roll back' };
    const failed = randomUUID(); await request(path, { id: failed, text: 'Inject journal failure' });
    await until(() => request(path), rows => rows.find((r: any) => r.id === failed)?.status === 'failed');
    assert.equal((await request(memory + '?query=Atomic')).items.length, 0);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('memory and artifact order survives repeated delegation when parent continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-memory-delegation-'));
  let peer = '', observed: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), user = data.messages.findLast((m: any) => m.role === 'user')?.content;
    const names = data.messages.flatMap((m: any) => m.tool_calls?.map((c: any) => c.function.name) ?? []);
    let call;
    if (user === 'root') {
      const steps = [
        { name: 'remember_memory', args: { text: 'Before delegation' } },
        { name: 'create_text_file', args: { name: 'first.txt', text: 'first' } },
        { name: 'delegate_task', args: { recipient: peer, task: 'child' } },
        { name: 'remember_memory', args: { text: 'Between delegations' } },
        { name: 'create_text_file', args: { name: 'second.txt', text: 'second' } },
        { name: 'delegate_task', args: { recipient: peer, task: 'child again' } },
        { name: 'remember_memory', args: { text: 'After delegations' } },
      ];
      if (names.length < steps.length) call = { id: `step-${names.length}`, ...steps[names.length] };
      else observed = names;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' }); peer = b.id;
    const c = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', lead: a.id, members: [a.id, b.id] });
    const path = `/api/channels/${c.id}/turns`, id = randomUUID(); await request(path, { id, text: 'root', recipient: a.id });
    let done = false;
    for (let n = 0; n < 200; n++) { if ((await request(path)).find((r: any) => r.id === id)?.status === 'done') { done = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(done); assert.deepEqual(observed, ['remember_memory', 'create_text_file', 'delegate_task', 'remember_memory', 'create_text_file', 'delegate_task', 'remember_memory']);
    assert.equal((await request(`/api/channels/${c.id}/memory`)).items.length, 3);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
