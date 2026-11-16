import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './server.ts';

test('routine tools recover from invalid arguments, preserve owner scope and keep runtime faults fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-routine-tools-'));
  let mode = 'list', owned = '', foreign = '', lastResult: any;
  let badAfter: unknown = '';
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), previous = data.messages.filter((item: any) => item.role === 'tool');
    if (mode.startsWith('channel')) assert(!data.tools.some((item: any) => ['list_routines', 'read_routine', 'set_routine_flow'].includes(item.function.name)));
    const call = mode === 'channel-transfer' ? previous.length ? null : { name: 'transfer_task', args: { recipient: randomUUID(), task: 'Help' } }
      : mode === 'channel' ? null : mode === 'channel-denied' ? { name: 'set_routine_flow', args: { id: owned, revision: 1, links: [] } } : mode === 'list' ? previous.length < 2 ? { name: 'list_routines', args: previous.length ? { after: JSON.parse(previous[0].content).next_after } : {} } : null
      : mode === 'bad-after' ? previous.length > 1 ? null : { name: 'list_routines', args: previous.length ? {} : { after: badAfter } }
      : ['bad-json', 'runtime-fault'].includes(mode) ? previous.length ? null : { name: 'list_routines', args: { after: '' } }
      : previous.length ? null : { name: 'read_routine', args: { id: mode === 'foreign' ? foreign : owned, ...(mode === 'invalid' ? { extra: true } : {}) } };
    if (previous.length) lastResult = previous.map((item: any) => JSON.parse(item.content));
    if (mode === 'runtime-fault' && previous.length) { res.statusCode = 500; res.end('{}'); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: mode === 'bad-json' ? badAfter : JSON.stringify(call.args) } }] } : { content: 'Checked.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
  }
  async function run(path: string, recipient?: string, expected = 'done') {
    const id = randomUUID(); await request(path, { id, text: 'Inspect saved routines', ...(recipient ? { recipient } : {}) });
    for (let i = 0; i < 150; i++) {
      const turn = (await request(path)).find((item: any) => item.id === id);
      if (turn && ['done', 'failed'].includes(turn.status)) { assert.equal(turn.status, expected, turn.error); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Routine tool turn did not settle');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help.' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help.' });
    const input = { name: 'Routine', prompt: 'PRIVATE_PROMPT', enabled: false, nextAt: Date.now() + 3600000, intervalSeconds: null };
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await request(`/api/agents/${a.id}/routines`, { ...input, id: randomUUID(), trigger: i === 0 ? 'webhook' : 'schedule' })).id);
    owned = ids[0]; foreign = (await request(`/api/agents/${b.id}/routines`, { ...input, id: randomUUID(), prompt: 'FOREIGN_SECRET' })).id;
    const hook = await request(`/api/routines/${owned}/webhook`, { id: randomUUID(), revision: 0, rotate: true, eventName: 'test.ready', filters: [] });
    const saved = await request(`/api/routines/${owned}/flow`, { id: randomUUID(), revision: 0, links: [{ from: a.id, to: b.id }] });
    await run(`/api/agents/${a.id}/turns`);
    assert.equal(lastResult[0].routines.length, 10); assert.equal(lastResult[1].routines.length, 1); assert.equal(lastResult[1].next_after, null);
    assert.deepEqual(lastResult.flatMap((page: any) => page.routines.map((row: any) => row.id)), ids.sort());
    assert(!JSON.stringify(lastResult).includes('PRIVATE_PROMPT'));
    mode = 'bad-after';
    for (badAfter of ['', 0, 'Daily sales', null]) {
      await run(`/api/agents/${a.id}/turns`);
      assert.match(lastResult[0].error, /Omit after for the first page, or pass the UUID from next_after/);
      assert.equal(lastResult[0].status, 400);
      assert.equal(lastResult[1].routines.length, 10);
    }
    mode = 'bad-json';
    for (badAfter of ['{', 'null', '[]', '"cursor"']) {
      await run(`/api/agents/${a.id}/turns`);
      assert.match(lastResult[0].error, /Tool arguments must be/);
      assert.equal(lastResult[0].status, 400);
    }
    mode = 'runtime-fault'; await run(`/api/agents/${a.id}/turns`, undefined, 'failed');
    assert.equal(lastResult[0].status, 400);
    mode = 'read'; await run(`/api/agents/${a.id}/turns`);
    assert.equal(lastResult[0].prompt, input.prompt); assert.deepEqual(lastResult[0].flow, saved);
    assert(!JSON.stringify(lastResult).includes(hook.secret)); assert(!JSON.stringify(lastResult).includes(hook.route));
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Private side' });
    await run(`/api/threads/${side.id}/turns`); assert.deepEqual(lastResult[0].flow, saved);
    mode = 'foreign'; await run(`/api/agents/${a.id}/turns`);
    assert.deepEqual(lastResult, [{ error: 'Routine not found for this agent.' }]);
    mode = 'channel'; const room = await request('/api/channels', { id: randomUUID(), name: 'Shared', instructions: 'Help.', lead: a.id, members: [a.id, b.id] });
    await run(`/api/channels/${room.id}/turns`, a.id);
    mode = 'channel-transfer'; await run(`/api/channels/${room.id}/turns`, a.id);
    assert.deepEqual(lastResult, [{ error: 'Coordination recipient is not another channel member.', status: 400 }]);
    mode = 'channel-denied'; await run(`/api/channels/${room.id}/turns`, a.id, 'failed');
    mode = 'invalid'; await run(`/api/agents/${a.id}/turns`);
    assert.deepEqual(lastResult, [{ error: 'Invalid routine ID.', status: 400 }]);
    assert.equal((await request(`/api/routines/${owned}/runs`)).length, 0);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
