import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('skill tools page own enabled pins, reject foreign access and observe revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-skill-tools-'));
  let target = '', mode = 'list';
  let revoke: (() => Promise<unknown>) | undefined;
  const results: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), reads = data.messages.filter((m: any) => m.role === 'tool');
    const offered = data.tools?.some((t: any) => t.function.name === 'read_skill');
    if (mode === 'channel') assert.equal(offered, false); else assert(offered);
    if (revoke) { const action = revoke; revoke = undefined; await action(); }
    if (reads.length) results.push(JSON.parse(reads.at(-1).content));
    const after = reads.length ? results.at(-1).next_after : undefined;
    const call = mode !== 'channel' && (!reads.length || mode === 'list' && after);
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call
      ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: mode === 'list' ? 'list_skills' : 'read_skill', arguments: JSON.stringify(mode === 'list' ? { after } : mode === 'invalid' ? { id: target, agent: target } : { id: target }) } }] }
      : { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, await response.clone().text()); return response.json();
  }
  async function run(path: string, status = 'done') {
    results.length = 0; const id = randomUUID(); await request(path, { id, text: 'Inspect installed skills' });
    for (let n = 0; n < 150; n++) {
      const turn = (await request(path)).find((row: any) => row.id === id);
      if (['done', 'failed'].includes(turn.status)) { assert.equal(turn.status, status, turn.error); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Task did not settle');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const skill = await request('/api/skills', { id: randomUUID(), revision: 0, name: `Skill ${i}`, description: 'Description', content: `Pinned ${i}` });
      ids.push(skill.id);
      await request(`/api/agents/${i === 12 ? b.id : a.id}/skills/${skill.id}`, { id: randomUUID(), revision: 0, version: 1, enabled: i !== 11 });
    }
    const path = `/api/agents/${a.id}/turns`;
    await run(path); assert.equal(results.length, 2); assert.deepEqual(results.flatMap(r => r.items.map((s: any) => s.id)), ids.slice(0, 11).sort());
    target = ids[0]; mode = 'read';
    await request(`/api/skills/${target}`, { id: randomUUID(), revision: 1, name: 'New', description: 'New', content: 'UNINSTALLED VERSION' });
    await run(path); assert.equal(results[0].content, 'Pinned 0'); assert.equal(results[0].version, 1);
    for (target of [ids[11], ids[12], randomUUID()]) { await run(path); assert.match(results[0].error, /not found/); }
    target = ids[0];
    revoke = () => request(`/api/agents/${a.id}/skills/${target}`, { id: randomUUID(), revision: 1, version: 1, enabled: false });
    await run(path); assert.match(results[0].error, /not found/);
    await request(`/api/agents/${a.id}/skills/${target}`, { id: randomUUID(), revision: 2, version: 1, enabled: false, remove: true });
    await run(path); assert.match(results[0].error, /not found/);
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Private side' });
    target = ids[1]; await run(`/api/threads/${side.id}/turns`); assert.equal(results[0].content, 'Pinned 1');
    mode = 'invalid'; await run(path); assert.deepEqual(results, [{ error: 'Invalid skill request.', status: 400 }]);
    mode = 'channel';
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', lead: a.id, members: [a.id] });
    await run(`/api/channels/${channel.id}/turns`);
  } finally {
    await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
