import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createAvatars } from './avatars.ts';
import { startApp } from './server.ts';

test('avatar tool scopes files, journals atomic changes and preserves user changes on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-avatar-tool-'));
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#448866' } }).png().toBuffer();
  const generated = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
  assert(generated.length > 512 * 1024);
  let generate = false, imageCalls = 0;
  let args: Record<string, unknown> = {}, hold = false, continued = false, result: any, advertised = false;
  let before: (() => Promise<unknown>) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/images/generations') { imageCalls++; res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] })); return; }
    const body = JSON.parse(raw); advertised = body.tools.some((tool: any) => tool.function.name === 'set_avatar');
    if (generate && !body.messages.some((message: any) => message.role === 'tool')) { res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'generate', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'Synthetic avatar' }) } }] } }] })); return; }
    const last = body.messages.findLast((message: any) => message.role === 'tool');
    if (generate && last?.tool_call_id === 'generate') { const file = JSON.parse(last.content); res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'avatar', type: 'function', function: { name: 'set_avatar', arguments: JSON.stringify({ image: file.id, revision: 5 }) } }] } }] })); return; }
    if (last) { result = JSON.parse(last.content); continued = true; if (hold) return; }
    else if (before) { const action = before; before = undefined; await action(); }
    res.end(JSON.stringify({ choices: [{ finish_reason: last ? 'stop' : 'tool_calls', message: last ? { content: 'Avatar result checked.' } : { tool_calls: [{ id: 'avatar', type: 'function', function: { name: 'set_avatar', arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, imageProvider: { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-image' } };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  }
  async function waitFor(check: () => Promise<any>) { for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out'); }
  async function until(path: string, id: string, status = 'done') { return waitFor(async () => (await request(path + '/turns')).find((row: any) => row.id === id && row.status === status)); }
  async function upload(path: string, bytes = png) {
    const id = randomUUID(); const response = await fetch(`${app.origin}${path}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'image.png' }, body: bytes }); assert(response.ok); return id;
  }
  async function run(path: string, attachments: string[] = [], status = 'done') { const id = randomUUID(); await request(path + '/turns', { id, text: 'Use this as your avatar', files: attachments }); await until(path, id, status); return id; }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Artist', model: 'fixture', instructions: 'Help' });
    const other = await request('/api/agents', { id: randomUUID(), name: 'Other', model: 'fixture', instructions: 'Help' });
    const side = await request(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', members: [agent.id], lead: agent.id });
    const path = `/api/agents/${agent.id}`, avatar = path + '/avatar', sidePath = `/api/threads/${side.id}`;
    const image = await upload(path); args = { image, revision: 0 }; await run(path, [image]);
    assert(advertised); assert.equal(result.revision, 1); assert.equal(result.present, true);
    const bytes = Buffer.from(await (await fetch(app.origin + avatar + '/image')).arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).width, 256);
    const unsent = await upload(path); args = { image: unsent, revision: 1 }; await run(path); assert.equal(result.status, 404);
    args = { image, revision: 1 }; await run(sidePath); assert.equal(result.status, 404);
    args = { image, revision: 0 }; await run(`/api/agents/${other.id}`); assert.equal(result.status, 404);
    args = { image, revision: 0 }; await run(path); assert.equal(result.status, 409);
    args = { image: null, revision: 1, agent: other.id }; await run(path); assert.equal(result.status, 400);
    args = { image: null, revision: 1 }; await run(`/api/channels/${room.id}`, [], 'failed'); assert.equal(advertised, false);
    assert.deepEqual(await request(avatar), { revision: 1, present: true });
    const sideImage = await upload(sidePath); args = { image: sideImage, revision: 1 }; await run(sidePath, [sideImage]); assert.equal(result.revision, 2);
    args = { image: null, revision: 2 }; before = () => request(avatar, { id: randomUUID(), revision: 2, image: png.toString('base64') });
    await run(path); assert.equal(result.status, 409); assert.equal((await request(avatar)).revision, 3);
    args = { image: null, revision: 3 }; hold = true; continued = false;
    const interrupted = randomUUID(); await request(path + '/turns', { id: interrupted, text: 'Remove avatar' }); await waitFor(async () => continued);
    assert.deepEqual(await request(avatar), { revision: 4, present: false });
    await app.close(); app = await startApp(options); hold = false;
    await request(avatar, { id: randomUUID(), revision: 4, image: png.toString('base64') });
    const stopped = await until(path, interrupted, 'interrupted');
    await request(`${path}/turns/${interrupted}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true }); await until(path, interrupted);
    assert.deepEqual(result, { revision: 4, present: false }); assert.deepEqual(await request(avatar), { revision: 5, present: true });
    args = { image: null, revision: 5 }; const cancelled = randomUUID(); before = () => request(`${path}/turns/${cancelled}/cancel`, { id: randomUUID() });
    await request(path + '/turns', { id: cancelled, text: 'Cancel' }); await until(path, cancelled, 'cancelled'); assert.equal((await request(avatar)).revision, 5);
    generate = true; await run(path); generate = false; assert.equal(imageCalls, 1); assert.equal(result.revision, 6);
    args = { image: null, revision: 6 };
    await app.close(); const db = new DatabaseSync(options.database); db.exec("CREATE TRIGGER reject_avatar_journal BEFORE INSERT ON flow_tool_calls BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END"); db.close();
    app = await startApp(options); await run(path, [], 'failed'); assert.deepEqual(await request(avatar), { revision: 6, present: true });
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});


test('avatar decode completion cannot commit after cancellation or a newer revision', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY); INSERT INTO agents VALUES ('agent'); CREATE TABLE turns(id TEXT,status TEXT,agent TEXT,channel TEXT); INSERT INTO turns VALUES ('turn','running','agent',NULL); CREATE TABLE generated_files(turn TEXT); CREATE TABLE flow_tool_calls(turn TEXT,call_id TEXT,call TEXT,result TEXT,after_output INTEGER,after_action INTEGER);");
  const transaction = <T>(fn: () => T): T => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const avatars = createAvatars(db, transaction), signal = new AbortController();
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#123456' } }).png().toBuffer();
  try {
    // fromTool reaches sharp's first await before returning this promise.
    const cancelled = avatars.fromTool('turn', 'agent', { id: 'cancel' }, { image: randomUUID(), revision: 0 }, png, 0, signal.signal);
    db.prepare("UPDATE turns SET status='cancelled'").run();
    await assert.rejects(cancelled, /dibatalkan/);
    assert.equal(avatars.read('agent').revision, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM flow_tool_calls').get()!.n, 0);
    db.prepare("UPDATE turns SET status='running'").run();
    const conflict = avatars.fromTool('turn', 'agent', { id: 'conflict' }, { image: randomUUID(), revision: 0 }, png, 0, signal.signal);
    db.prepare('INSERT INTO agent_avatars VALUES (?,1,NULL)').run('agent');
    assert.equal((await conflict as { status: number }).status, 409);
    assert.deepEqual(avatars.read('agent'), { revision: 1, present: false });
    assert.equal(db.prepare('SELECT count(*) AS n FROM flow_tool_calls').get()!.n, 1);
  } finally { db.close(); }
});
