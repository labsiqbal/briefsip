import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';

test('agent flow edits preserve ownership, revisions and ordered receipts across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-flow-tools-'));
  let args: unknown, hold = false, held = false, lastResult: any;
  let beforeEdit: (() => Promise<void>) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), results = data.messages.filter((row: any) => row.role === 'tool');
    const order = data.messages.filter((row: any) => row.tool_calls).map((row: any) => row.tool_calls[0].function.name);
    const step = results.length;
    if (step === 1 && beforeEdit) { const action = beforeEdit; beforeEdit = undefined; await action(); }
    if (step === 3) {
      assert.deepEqual(order, ['create_text_file', 'set_routine_flow', 'create_text_file']);
      lastResult = JSON.parse(results[1].content);
      if (hold) { held = true; return; }
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Saved flow.' } }] }));
    }
    const call = step === 1 ? { name: 'set_routine_flow', arguments: JSON.stringify(args) } : { name: 'create_text_file', arguments: JSON.stringify({ name: `step-${step}.txt`, text: 'Synthetic evidence' }) };
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: call }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
  }
  async function until(read: () => Promise<any>, ready: (data: any) => boolean) {
    for (let i = 0; i < 150; i++) { const data = await read(); if (ready(data)) return data; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('Flow tool state did not settle');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help.' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help.' });
    const input = { name: 'Flow', prompt: 'Synthetic', enabled: false, nextAt: Date.now() + 3600000, intervalSeconds: null };
    const own = await request(`/api/agents/${a.id}/routines`, { ...input, id: randomUUID() });
    const foreign = await request(`/api/agents/${b.id}/routines`, { ...input, id: randomUUID() });
    const settings = `/api/routines/${own.id}/flow`, turns = `/api/agents/${a.id}/turns`;
    args = { id: own.id, revision: 0, links: [{ from: a.id, to: b.id }] }; hold = true;
    const id = randomUUID(); await request(turns, { id, text: 'Update the flow' });
    await until(async () => held, Boolean);
    assert.equal((await request(settings)).revision, 1);
    await app.close(); app = await startApp(options); hold = false;
    const stopped = (await request(turns)).find((row: any) => row.id === id);
    assert.equal(stopped.status, 'interrupted');
    await request(settings, { id: randomUUID(), revision: 1, links: [] });
    await request(`${turns}/${id}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true });
    await until(() => request(turns), rows => rows.find((row: any) => row.id === id)?.status === 'done');
    assert.equal(lastResult.revision, 1); assert.equal((await request(settings)).revision, 2);
    const done = (await request(turns)).find((row: any) => row.id === id); assert.equal(done.generatedFiles.length, 2);
    for (const [change, status] of [
      [{ id: own.id, revision: 0, links: [] }, 409],
      [{ id: foreign.id, revision: 0, links: [] }, 404],
      [{ id: own.id, revision: 2, links: [{ from: a.id, to: a.id }] }, 400],
    ] as const) {
      args = change; const turn = randomUUID(); await request(turns, { id: turn, text: 'Attempt invalid edit' });
      await until(() => request(turns), rows => rows.find((row: any) => row.id === turn)?.status === 'done');
      assert.equal(lastResult.status, status); assert.equal((await request(settings)).revision, 2);
    }
    assert.equal((await request(`/api/routines/${own.id}/runs`)).length, 0);
    assert.equal((await request(`/api/routines/${foreign.id}/flow`)).revision, 0);
    const cancelled = randomUUID();
    args = { id: own.id, revision: 2, links: [{ from: a.id, to: b.id }] };
    beforeEdit = async () => { await request(`${turns}/${cancelled}/cancel`, { id: randomUUID() }); };
    await request(turns, { id: cancelled, text: 'Cancel before the edit arrives' });
    await until(() => request(turns), rows => rows.find((row: any) => row.id === cancelled)?.status === 'cancelled');
    await app.close(); app = await startApp(options);
    assert.equal((await request(settings)).revision, 2);
    assert.deepEqual((await request(settings)).graph.links, []);
    assert.equal((await request(turns)).find((row: any) => row.id === cancelled).generatedFiles.length, 1);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
