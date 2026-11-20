import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { restoreSkillCommand } from './shared/skill-command.ts';

test('packs pin members and apply lifecycle atomically without replacing manual skills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-packs-')), options = { database: join(dir, 'state.sqlite') };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'unused', instructions: 'Test' }, 201);
    const skills: { id: string }[] = [];
    for (let i = 0; i < 5; i++) skills.push(await request('/api/skills', { id: randomUUID(), revision: 0, name: `Skill ${i}`, description: 'Fixture', content: 'x'.repeat(16000) }));
    const members = skills.slice(0, 2).map(skill => ({ skill: skill.id, version: 1 }));
    const create = { id: randomUUID(), revision: 0, name: 'Pack', members };
    const pack = await request('/api/skill-packs', create); assert.deepEqual(await request('/api/skill-packs', create), pack);
    const path = `/api/agents/${agent.id}/skill-packs/${pack.id}`, memberPath = `/api/agents/${agent.id}/skills/${skills[0].id}`;
    const manual = await request(memberPath, { id: randomUUID(), revision: 0, version: 1, enabled: false });
    const install = { id: randomUUID(), revision: 0, version: 1, enabled: true };
    await request(path, install, 409); assert.equal(await request(path), null);
    assert.equal((await request(`/api/agents/${agent.id}/skills`)).items.length, 1);
    await request(memberPath, { id: randomUUID(), revision: manual.revision, version: 1, enabled: false, remove: true });
    await request(path, install);
    let rows = (await request(`/api/agents/${agent.id}/skills`)).items;
    assert.equal(rows.length, 2); assert(rows.every((row: any) => row.pack === pack.id && row.enabled === 1));
    await request(memberPath, { id: randomUUID(), revision: rows.find((row: any) => row.skill === skills[0].id).revision, version: 1, enabled: false }, 409);
    await request(`/api/skill-packs/${pack.id}`, { ...create, id: randomUUID(), revision: 1, members: [{ skill: skills[2].id, version: 1 }] });
    assert.equal((await request(path)).version, 1);
    const disabled = await request(path, { id: randomUUID(), revision: 1, version: 1, enabled: false });
    assert((await request(`/api/agents/${agent.id}/skills`)).items.every((row: any) => row.enabled === 0));
    const upgraded = await request(path, { id: randomUUID(), revision: disabled.revision, version: 2, enabled: true });
    rows = (await request(`/api/agents/${agent.id}/skills`)).items; assert.equal(rows.length, 1); assert.equal(rows[0].skill, skills[2].id);
    const remove = { id: randomUUID(), revision: upgraded.revision, version: 2, enabled: false, remove: true };
    const removed = await request(path, remove); assert.equal((await request(`/api/agents/${agent.id}/skills`)).items.length, 0);
    const reinstalled = await request(path, { ...install, id: randomUUID(), revision: removed.revision });
    await request(path, remove); assert.equal((await request(path)).revision, reinstalled.revision);
    await app.close(); app = await startApp(options); await request(path, install);
    assert.equal((await request(path)).revision, reinstalled.revision);
    await request(`/api/skill-packs/${pack.id}`, { ...create, id: randomUUID(), revision: 2, members: skills.map(skill => ({ skill: skill.id, version: 1 })) });
    await request(path, { ...install, id: randomUUID(), revision: reinstalled.revision, version: 3 }, 413);
    assert.equal((await request(path)).version, 1); assert.equal((await request(`/api/agents/${agent.id}/skills`)).items.length, 2);
    const otherPack = await request('/api/skill-packs', { ...create, id: randomUUID() });
    await request(`/api/agents/${agent.id}/skill-packs/${otherPack.id}`, { ...install, id: randomUUID() }, 409);
    await request('/api/skill-packs', { ...create, id: randomUUID(), members: [members[0], members[0]] }, 400);
    await request('/api/skill-packs', { ...create, id: randomUUID(), members: [{ skill: randomUUID(), version: 1 }] }, 404);
    assert.deepEqual(restoreSkillCommand(JSON.stringify({ path: '/api/skill-packs', body: create })), { path: '/api/skill-packs', body: create });
    assert.throws(() => restoreSkillCommand(JSON.stringify({ path: '/api/skill-packs', body: { ...create, members: [] } })));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
