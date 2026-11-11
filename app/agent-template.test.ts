import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentTemplate, restoreTemplateImport, templateCommand } from './agent-template.ts';
import { startApp } from './server.ts';
import sharp from 'sharp';

const template = { format: 'briefsip-agent', version: 1, name: 'Template', model: 'fixture', instructions: '<script>Test text only</script>', threadLimit: 3 } as const;
test('agent template validation rejects extra authority and preserves exact recovery identity', () => {
  assert.deepEqual(parseAgentTemplate(template), template);
  for (const input of [null, [], {}, { ...template, version: 2 }, { ...template, token: 'secret' }, { ...template, permissions: 'full' }, { ...template, path: '/tmp/example' }, { ...template, instructions: '' }, { ...template, name: 'x'.repeat(81) }, { ...template, model: 2 }, { ...template, threadLimit: 33 }, { ...template, threadLimit: 1.5 }]) assert.throws(() => parseAgentTemplate(input));
  const pending = { id: randomUUID(), template };
  assert.deepEqual(restoreTemplateImport(JSON.stringify(pending)), pending);
  assert.deepEqual(templateCommand(template, pending.id), { id: pending.id, name: template.name, model: template.model, instructions: template.instructions, threadLimit: 3 });
  assert.equal(restoreTemplateImport(null), null);
  for (const raw of ['{', '{}', '[]', ' '.repeat(64001), JSON.stringify({ ...pending, id: 'bad' }), JSON.stringify({ ...pending, extra: true }), JSON.stringify({ ...pending, template: { ...template, version: 2 } })]) assert.throws(() => restoreTemplateImport(raw));
});

test('template avatars import atomically and replay never replaces newer images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-template-avatar-'));
  const options = { database: join(dir, 'state.sqlite') };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  try {
    const image = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    assert(image.length > 64000);
    const value = { ...template, avatar: image.toString('base64') };
    assert.deepEqual(parseAgentTemplate(value), value);
    assert.throws(() => parseAgentTemplate({ ...template, avatar: 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAACXBIWXMAAAPoAAAD6ADCfGL9AAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAEAAAABAAAAAAAAAAAAAAEAAgAA8XqQDwAAAsFJREFUeJzt0zENADAMwLBiGYzxZzIig9EjlgwgT+bdA1mzXgCLDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmAtA+KKBKyvNLx1AAAABpmY1RMAAAAAQAAAQAAAAEAAAAAAAAAAAAAAQACAABqCXrbAAACxGZkQVQAAAACeJzt0zENADAMwLBCGbKRH5HB6BFLBpAnc+6DrFkvgEUGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDECaAUgzAGkGIM0ApBmANAOQZgDSDEDaB59OFLC07+AeAAAAAElFTkSuQmCC' }), /statis/);
    assert.throws(() => parseAgentTemplate({ ...value, avatar: image.subarray(0, 32).toString('base64') }));
    const id = randomUUID(), command = templateCommand(value, id);
    assert.deepEqual(restoreTemplateImport(JSON.stringify({ id, template: value })), { id, template: value });
    const created = await request('/api/agents', command, 201);
    assert.equal(created.avatar_revision, 1);
    const exported = await request(`/api/agents/${id}/template`);
    assert.equal(exported.avatar, value.avatar);
    const second = await request('/api/agents', templateCommand(parseAgentTemplate(exported), randomUUID()), 201);
    assert.notEqual(second.id, id);
    assert.equal((await request(`/api/agents/${second.id}/template`)).avatar, value.avatar);
    const rejectedId = randomUUID();
    await request('/api/agents', { ...command, id: rejectedId, avatar: image.subarray(0, 32).toString('base64') }, 400);
    assert(!(await request('/api/agents')).agents.some((row: { id: string }) => row.id === rejectedId));
    for (const avatar of [null, 'https://example.com/a.png', Buffer.from('<svg/>').toString('base64'), 'A'.repeat(699056)]) assert.throws(() => parseAgentTemplate({ ...template, avatar }));
    await request(`/api/agents/${id}/avatar`, { id: randomUUID(), revision: 1, image: null });
    await app.close(); app = await startApp(options);
    assert.equal((await request('/api/agents', command)).avatar_revision, 0);
    assert(!('avatar' in await request(`/api/agents/${id}/template`)));
    await request('/api/agents', { ...command, avatar: image.toString('base64') + '%'  }, 400);
    await request('/api/agents', templateCommand(template, id), 409);
    assert.equal((await request('/api/agents')).agents.length, 2);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('profile export and reviewed import create a new agent once across restart without changing original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-template-'));
  const options = { database: join(dir, 'state.sqlite'), apiKey: 'private-fixture-key' };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  try {
    const original = await request('/api/agents', templateCommand(template, randomUUID()), 201);
    const exported = await request(`/api/agents/${original.id}/template`);
    assert.deepEqual(exported, template); assert(!JSON.stringify(exported).includes(options.apiKey));
    const pending = restoreTemplateImport(JSON.stringify({ id: randomUUID(), template: exported }))!;
    const imported = await request('/api/agents', templateCommand(pending.template, pending.id), 201);
    assert.notEqual(imported.id, original.id); assert.equal(imported.instructions, original.instructions);
    assert.equal(imported.thread_limit, original.thread_limit);
    assert.equal((await request(`/api/agents/${imported.id}/turns`)).length, 0);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request('/api/agents', templateCommand(pending.template, pending.id)), imported);
    assert.deepEqual(await request(`/api/agents/${original.id}/template`), template);
    await request('/api/agents', { ...templateCommand(pending.template, pending.id), name: 'Changed' }, 409);
    await request(`/api/agents/${randomUUID()}/template`, undefined, 404);
    const directory = await request('/api/agents');
    assert.equal(directory.agents.length, 2);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
