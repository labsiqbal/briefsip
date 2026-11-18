import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { memoryCommand, memoryDraft } from './memory-command.ts';

test('memory CRUD, exact retry, isolated provider search and bounded context survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-memory-'));
  const contexts: string[] = [], results: any[] = [];
  let malformed = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); contexts.push(data.messages[0].content);
    const tools = data.messages.filter((m: any) => m.role === 'tool');
    if (tools.length) results.push(JSON.parse(tools.at(-1).content));
    const offered = data.tools?.some((t: any) => t.function.name === 'search_memory');
    const call = offered && !tools.length;
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'search_memory', arguments: JSON.stringify(malformed ? { owner: 'foreign' } : {}) } }] } : { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected?: number) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); if (expected) assert.equal(response.status, expected, JSON.stringify(value)); else assert(response.ok, JSON.stringify(value)); return value;
  }
  const command = (text: string, essential = false) => ({ id: randomUUID(), entry: randomUUID(), revision: 0, text, essential, remove: false });
  async function run(path: string, status = 'done') {
    contexts.length = 0; results.length = 0; const id = randomUUID(); await request(path, { id, text: 'Recall' });
    for (let n = 0; n < 150; n++) { const turns = await request(path), turn = turns.find((t: any) => t.id === id); if (['done', 'failed'].includes(turn.status) && !turns.some((t: any) => t.room?.root === id && ['queued','running'].includes(t.status))) { assert.equal(turn.status, status, turn.error); return; } await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Task did not settle');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'C', instructions: 'Help', lead: a.id, members: [a.id, b.id] });
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const pa = `/api/agents/${a.id}/memory`, pb = `/api/agents/${b.id}/memory`, pc = `/api/channels/${channel.id}/memory`;
    const original = command('PRIVATE_A', true), created = await request(pa, original);
    assert.deepEqual(await request(pa, original), created);
    await request(pb, original, 409);
    await request(pa, { ...original, id: randomUUID(), entry: randomUUID() }, 409);
    await request(pa, command('SEARCHABLE_A'));
    await request(pb, command('PRIVATE_B', true)); const shared = command('SHARED_CHANNEL', true), sharedResult = await request(pc, shared);
    for (const path of [`/api/agents/${a.id}/turns`, `/api/threads/${side.id}/turns`]) {
      await run(path); assert.match(contexts[0], /PRIVATE_A/); assert.doesNotMatch(contexts[0], /PRIVATE_B|SHARED_CHANNEL|SEARCHABLE_A/);
      assert.deepEqual(results[0].items.map((r: any) => r.text).sort(), ['PRIVATE_A', 'SEARCHABLE_A']);
    }
    await run(`/api/channels/${channel.id}/turns`); assert.match(contexts[0], /SHARED_CHANNEL/); assert.doesNotMatch(contexts[0], /PRIVATE_A|PRIVATE_B|SEARCHABLE_A/); assert.equal(results[0].items[0].text, 'SHARED_CHANNEL');
    await run(`/api/agents/${b.id}/turns`); assert.match(contexts[0], /PRIVATE_B/); assert.doesNotMatch(contexts[0], /PRIVATE_A|SHARED_CHANNEL/);
    const workflow = await request(`/api/agents/${a.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Memory exclusion', graph: { entry: 'model', maxSteps: 2, nodes: [{ id: 'model', kind: 'model', model: 'fixture', prompt: 'Model only', next: 'out' }, { id: 'out', kind: 'output' }] } });
    contexts.length = 0; results.length = 0;
    const modelRun = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Test' });
    let done = false;
    for (let n = 0; n < 150; n++) { if ((await request(`/api/workflow-runs/${modelRun.id}`)).status === 'done') { done = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(done); assert.equal(results.length, 0); assert.doesNotMatch(contexts[0], /PRIVATE_A|SEARCHABLE_A|SHARED_CHANNEL/);
    malformed = true; await run(`/api/agents/${a.id}/turns`); malformed = false;
    assert.deepEqual(results, [{ error: 'Invalid memory search.', status: 400 }]);
    const edit = { ...original, id: randomUUID(), revision: 1, text: 'UPDATED_A' }; await request(pa, edit);
    await request(pa, { ...edit, id: randomUUID() }, 409);
    assert.deepEqual(await request(pa, original), created); assert.equal((await request(pa + '?query=UPDATED')).items.length, 1);
    const removal = { ...edit, id: randomUUID(), revision: 2, remove: true, text: '', essential: false }; await request(pa, removal);
    await request(pa, { ...edit, id: randomUUID(), revision: 3 }, 409);
    await request(pa, edit); assert.equal((await request(pa + '?query=UPDATED')).items.length, 0);
    const large = command('界'.repeat(2000), true); await request(pa, large);
    await request(pa, command('文'.repeat(2000), true), 413);
    assert.equal((await request(pa)).items.length, 2);
    for (let n = 0; n < 11; n++) await request(pa, command(`page ${n}`));
    const first = await request(pa), second = await request(pa + '?after=' + first.next_after);
    assert.equal(first.items.length, 10); assert.equal(second.items.length, 3); assert.equal(new Set([...first.items, ...second.items].map(r => r.id)).size, 13);
    assert.equal((await request(pa + '?query=page')).items.length, 10);
    await request(pa + '?after=bad', undefined, 400);
    await request(`/api/agents/${randomUUID()}/memory`, undefined, 404);
    await request(pa, { ...command('bad'), extra: true }, 400);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(pa, original), created); assert.equal((await request(pa + '?query=UPDATED')).items.length, 0);
    await request(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: 1, name: 'C', instructions: 'Help', lead: a.id, members: [a.id, b.id], archived: true });
    assert.deepEqual(await request(pc, shared), sharedResult);
    await request(pc, command('archived'), 409); assert.equal((await request(pc)).items.length, 1);
    const draft = { entry: { id: original.entry, revision: 1, text: original.text, essential: 1 }, text: 'Unsaved edit', essential: false };
    assert.deepEqual(memoryDraft(JSON.parse(JSON.stringify(draft))), draft);
    for (const bad of [null, {}, { ...draft, entry: { ...draft.entry, revision: 0 } }, { ...draft, text: 123 }]) assert.throws(() => memoryDraft(bad));
    for (const bad of [null, [], {}, { ...original, text: '' }, { ...original, revision: -1 }, { ...original, essential: 1 }]) assert.throws(() => memoryCommand(bad));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('Rust memory permits edits at capacity and rolls back edits over the context budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-memory-capacity-'));
  const app = await startApp({ database: join(dir, 'state.sqlite') });
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, {
      method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  const make = (text: string) => ({ id: randomUUID(), entry: randomUUID(), revision: 0, text, essential: false, remove: false });
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Memory capacity', runtime: 'api', model: 'fixture', instructions: 'Help' }, 201);
    const path = `/api/agents/${agent.id}/memory`;
    const original = make('first'), second = make('unique second note');
    await request(path, original);
    await request(path, second);
    for (let index = 2; index < 128; index++) await request(path, make(`note ${index}`));
    assert.match((await request(path, make('overflow'), 413)).error, /128/);
    const revised = await request(path, { ...original, id: randomUUID(), revision: 1, text: 'edited' });
    assert.equal(revised.text, 'edited');
    await request(path, { ...original, id: randomUUID(), revision: 2, text: '', remove: true });
    await request(path, { ...make('界'.repeat(2000)), essential: true });

    const denied = await request(path, { ...second, id: randomUUID(), revision: 1, text: '文'.repeat(2000), essential: true }, 413);
    assert.match(denied.error, /8 KiB/);
    const page = await request(path + '?query=' + encodeURIComponent('unique second note'));
    const saved = page.items.find((item: { id: string }) => item.id === second.entry);
    assert.equal(saved?.essential, 0);
    assert.equal(saved?.text, 'unique second note');
    assert.equal(saved?.revision, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
