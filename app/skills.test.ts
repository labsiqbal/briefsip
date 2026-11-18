import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';
import { restoreSkillCommand } from './skill-command.ts';

test('skill revisions stay pinned, disable isolates agent context and receipts survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-skills-')), contexts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    contexts.push(JSON.parse(raw).messages[0].content);
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  async function send(agent: string) {
    const id = randomUUID(); await request(`/api/agents/${agent}/turns`, { id, text: 'Hello' }, 202);
    for (let i = 0; i < 100; i++) { const rows = await request(`/api/agents/${agent}/turns`); if (rows.find((row: any) => row.id === id)?.status === 'done') return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('Provider did not complete');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Base' }, 201);
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Base' }, 201);
    const command = { id: randomUUID(), revision: 0, name: 'Research', description: 'When researching', content: 'Unique version one' };
    await request('/api/skills/a', { ...command, id: randomUUID() }, 400);
    await request(`/api/skills/${randomUUID()}`, { ...command, id: randomUUID() }, 404);
    const skill = await request('/api/skills', command); assert.deepEqual(await request('/api/skills', command), skill);
    const install = { id: randomUUID(), revision: 0, version: 1, enabled: true }, path = `/api/agents/${a.id}/skills/${skill.id}`;
    await request(path, install); await request(`/api/skills/${skill.id}`, { ...command, id: randomUUID(), revision: 1, content: 'Unique version two' });
    await send(a.id); assert.match(contexts.at(-1)!, /Unique version one/); assert.doesNotMatch(contexts.at(-1)!, /Unique version two/);
    await send(b.id); assert.doesNotMatch(contexts.at(-1)!, /Unique version/);
    await request(path, { ...install, id: randomUUID(), revision: 1, version: 2 }); await send(a.id); assert.match(contexts.at(-1)!, /Unique version two/);
    await request(path, { ...install, id: randomUUID(), revision: 2, version: 2, enabled: false }); await send(a.id); assert.doesNotMatch(contexts.at(-1)!, /Unique version/);
    await request(path, { ...install, id: randomUUID() }, 409);
    await request(path, { ...install, id: randomUUID(), revision: 3, version: 2, enabled: true });
    const workflow = await request(`/api/agents/${a.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Model isolation', graph: { entry: 'model', maxSteps: 2, nodes: [{ id: 'model', kind: 'model', model: 'fixture', prompt: 'Model only', next: 'out' }, { id: 'out', kind: 'output' }] } });
    const run = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Test' });
    let completed = false;
    for (let i = 0; i < 100; i++) { if ((await request(`/api/workflow-runs/${run.id}`)).status === 'done') { completed = true; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    assert(completed); assert.doesNotMatch(contexts.at(-1)!, /Unique version/);
    await request(path, { ...install, id: randomUUID(), revision: 4, version: 2, enabled: false });

    assert.equal((await request(`/api/skills/${skill.id}?version=1`)).content, command.content);
    await app.close();
    const legacy = new DatabaseSync(options.database); legacy.exec('ALTER TABLE agent_skills DROP COLUMN removed'); legacy.close();
    app = await startApp(options); assert.equal((await request(path)).removed, 0);
    await request(path, install); assert.equal((await request(`/api/agents/${a.id}/skills`)).items[0].enabled, 0);
    for (let i = 0; i < 5; i++) {
      const large = await request('/api/skills', { ...command, id: randomUUID(), content: 'x'.repeat(16000) });
      await request(`/api/agents/${b.id}/skills/${large.id}`, { ...install, id: randomUUID() }, i === 4 ? 413 : 200);
    }
    assert.equal((await request(`/api/agents/${b.id}/skills`)).items.length, 4);
    for (let i = 0; i < 21; i++) {
      const extra = await request('/api/skills', { ...command, id: randomUUID() });
      await request(`/api/agents/${a.id}/skills/${extra.id}`, { ...install, id: randomUUID(), enabled: false });
    }
    const first = await request(`/api/agents/${a.id}/skills`), second = await request(`/api/agents/${a.id}/skills?after=${first.next_after}`);
    assert.equal(first.items.length, 20); assert.equal(second.items.length, 2); assert.equal(second.next_after, null);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.skill)).size, 22);
    assert.equal((await request(`/api/agents/${a.id}/skills/${skill.id}`)).version, 2);
    await request(`/api/agents/${a.id}/skills?after=invalid`, undefined, 400);
    const binding = await request(path);
    const remove = { id: randomUUID(), revision: binding.revision, version: binding.version, enabled: false, remove: true };
    const removed = await request(path, remove); assert.equal(removed.removed, 1);
    await send(a.id); assert.doesNotMatch(contexts.at(-1)!, /Unique version/);
    assert.equal((await request(`/api/skills/${skill.id}?version=1`)).content, command.content);
    const installedAgain = await request(path, { id: randomUUID(), revision: removed.revision, version: 1, enabled: true });
    await request(path, remove); assert.equal((await request(path)).removed, 0);
    assert.equal((await request(path)).revision, installedAgain.revision);
    await send(a.id); assert.match(contexts.at(-1)!, /Unique version one/);
    const finalRemove = { ...remove, id: randomUUID(), revision: installedAgain.revision, version: 1 };
    await request(path, finalRemove); await app.close(); app = await startApp(options);
    await request(path, finalRemove); await request(path, install);
    assert.equal((await request(path)).removed, 1);
    await request(path, { ...install, id: randomUUID() }, 409);
    const afterRemoval = await request(`/api/agents/${a.id}/skills`);
    const remainder = await request(`/api/agents/${a.id}/skills?after=${afterRemoval.next_after}`);
    assert.equal([...afterRemoval.items, ...remainder.items].some(row => row.skill === skill.id), false);
    assert.deepEqual(restoreSkillCommand(JSON.stringify({ path, body: finalRemove })), { path, body: finalRemove });
    assert.throws(() => restoreSkillCommand(JSON.stringify({ path, body: { ...finalRemove, enabled: true } })));
    assert.equal(restoreSkillCommand(null), null);
    assert.deepEqual(restoreSkillCommand(JSON.stringify({ path: '/api/skills', body: command })), { path: '/api/skills', body: command });
    for (const value of [{ path: '/api/backup', body: command }, { path: '/api/skills', body: { ...command, id: [command.id] } }, { path, body: { ...install, enabled: 'yes' } }, { path: '/api/skills', body: { ...command, extra: true } }]) assert.throws(() => restoreSkillCommand(JSON.stringify(value)));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
