import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageTokens, initializeUsage, readUsage } from './usage.ts';
import { startApp } from './server.ts';

test('usage preserves unknown counts, zero and exact sums beyond JS safe integers', () => {
  assert.deepEqual(usageTokens(null), [null, null, null]);
  assert.deepEqual(usageTokens({ prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 }), [0, 3, 3]);
  assert.deepEqual(usageTokens({ prompt_tokens: '1', completion_tokens: -1, total_tokens: 1.2 }), [null, null, null]);
  assert.deepEqual(usageTokens({ prompt_tokens: 1e30 }), [null, null, null]);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE turns(id TEXT PRIMARY KEY); INSERT INTO turns VALUES ('t'); CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT); INSERT INTO agents VALUES ('a','A');");
    initializeUsage(db);
    const insert = db.prepare("INSERT INTO provider_calls(turn,agent,model,origin,purpose,status,created,input_tokens) VALUES ('t','a','m','http://localhost','completion','received','2026-01-01',?)");
    insert.run(9007199254740991n); insert.run(2);
    assert.equal(readUsage(db, Number.MAX_SAFE_INTEGER).summary!.input_tokens, '9007199254740993');
    assert.equal(readUsage(db, Number.MAX_SAFE_INTEGER).summary!.total_tokens, null);
    for (let i = 0; i < 50; i++) insert.run(null);
    const first = readUsage(db, Number.MAX_SAFE_INTEGER);
    assert.equal(first.calls.length, 50);
    const second = readUsage(db, Number(first.next_before));
    assert.equal(second.calls.length, 2); assert.equal(second.next_before, null);
    assert.equal(new Set([...first.calls, ...second.calls].map(row => row.seq)).size, 52);
  } finally { db.close(); }
});

test('usage records each provider call including tool loops, missing counts and failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-usage-'));
  let mode = 'known', calls = 0, accepted: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); calls++;
    if (mode === 'hold') { accepted?.(); return; }
    if (payload.messages[0].content.startsWith('Choose exactly one channel member')) {
      const input = JSON.parse(payload.messages.at(-1).content);
      res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'assign', recipient: input.members[1].id }) } }] })); return;
    }
    if (mode === 'reject') { res.writeHead(429); res.end('private error'); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    const usage = mode === 'missing' ? undefined : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    if (mode === 'tools' && payload.messages.at(-1).role !== 'tool') {
      res.end(JSON.stringify({ usage, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'read_history', arguments: '{}' } }] } }] })); return;
    }
    res.end(JSON.stringify({ usage, choices: [{ finish_reason: mode === 'invalid' ? 'length' : 'stop', message: { content: 'Result' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-secret' };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Usage', model: 'fixture', instructions: 'Test' });
    for (const value of ['known', 'missing', 'tools', 'reject', 'malformed', 'invalid']) {
      mode = value; const id = randomUUID(), body = { id, text: value };
      await request(`/api/agents/${agent.id}/turns`, body);
      let ended = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const turns = await request(`/api/agents/${agent.id}/turns`);
        if (['done', 'failed'].includes(turns.find((turn: any) => turn.id === id)?.status)) { ended = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(ended); await request(`/api/agents/${agent.id}/turns`, body);
    }
    const report = await request('/api/usage');
    assert.equal(calls, 7); assert.equal(report.summary.calls, 7); assert.equal(report.summary.failed, 3);
    assert.equal(report.summary.input_tokens, '40'); assert.equal(report.summary.output_tokens, '8'); assert.equal(report.summary.total_tokens, '48');
    assert.equal(report.summary.unknown_total, 3); assert.equal(report.summary.pending, 0);
    assert(!JSON.stringify(report).includes('fixture-secret')); assert(!JSON.stringify(report).includes('private error'));
    assert.equal((await fetch(app.origin + '/api/usage?before=0')).status, 400);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request('/api/usage'), report);
    const other = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Other', model: 'other-model', instructions: 'Test' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Routing', instructions: 'Route', lead: agent.id, members: [agent.id, other.id] });
    mode = 'known'; const routed = randomUUID();
    await request(`/api/channels/${room.id}/turns`, { id: routed, text: 'Route this', automatic: true });
    let routedUsage;
    for (let i = 0; i < 100; i++) {
      routedUsage = (await request('/api/usage')).calls.filter((row: any) => row.turn === routed);
      if (routedUsage.length === 2 && routedUsage.every((row: any) => row.status === 'received')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(routedUsage.length, 2); assert.equal(routedUsage[1].purpose, 'routing'); assert.equal(routedUsage[1].agent, agent.id);
    assert.equal(routedUsage[0].purpose, 'completion'); assert.equal(routedUsage[0].model, routedUsage[0].agent === agent.id ? 'fixture' : 'other-model');
    mode = 'hold'; const held = new Promise<void>(resolve => { accepted = resolve; }), cancelled = randomUUID();
    await request(`/api/agents/${agent.id}/turns`, { id: cancelled, text: 'Cancel' }); await held;
    await request(`/api/agents/${agent.id}/turns/${cancelled}/cancel`, { id: randomUUID() });
    let cancelledUsage;
    for (let i = 0; i < 100; i++) {
      cancelledUsage = (await request('/api/usage')).calls.find((row: any) => row.turn === cancelled);
      if (cancelledUsage?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(cancelledUsage.status, 'failed'); assert.equal(cancelledUsage.total_tokens, null);

  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
