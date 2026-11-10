import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageType, imagePart, imageLimit } from './image-attachment.ts';
import { anthropicRequest, type ProviderFamily } from './provider.ts';
import { startApp } from './server.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ84AAAAASUVORK5CYII=', 'base64');
test('image headers and inline provider conversion are bounded and never use remote URLs', () => {
  assert.equal(imageType(png), 'image/png'); assert.equal(imageType(Buffer.from([255,216,255,224])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp'); assert.equal(imageType(Buffer.from('<svg></svg>')), null);
  assert.equal(imageType(png.subarray(0, 12)), null); assert.throws(() => imagePart(Buffer.concat([png, Buffer.alloc(imageLimit)])));
  const part = imagePart(png); assert.equal(part.image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  const native = anthropicRequest('vision', [{ role: 'user', content: [{ type: 'text', text: 'Look' }, part] }], [], 100);
  assert.deepEqual(native.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  for (const url of ['https://example.com/private', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///tmp/private']) assert.throws(() => anthropicRequest('vision', [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }], [], 100));
});

for (const family of ['openai-compatible', 'anthropic'] as ProviderFamily[]) test(`${family} image attachments retain scope, bytes, retry identity and bounded rereading`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-images-'));
  let mode = 'text', target = '', stage = 0;
  const payloads: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body); stage++;
    const system = family === 'anthropic' ? body.system.map((part: any) => part.text).join('\n') : body.messages[0].content;
    const reply = (text: string) => res.end(JSON.stringify(family === 'anthropic' ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
    if (system.startsWith('Choose exactly one channel member')) {
      const input = JSON.parse(body.messages.at(-1).content[0].text);
      return reply(JSON.stringify({ action: 'assign', recipient: input.members[0].id }));
    }
    if (mode === 'read' && stage === 1) {
      const id = randomUUID(), args = { id: target };
      res.end(JSON.stringify(family === 'anthropic' ? { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'read_attachment', input: args }] } : { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id, type: 'function', function: { name: 'read_attachment', arguments: JSON.stringify(args) } }] } }] })); return;
    }
    reply('Image received');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, provider: family };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status?: number) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); if (status) assert.equal(response.status, status, JSON.stringify(data)); else assert(response.ok, JSON.stringify(data)); return data;
  }
  async function upload(scope: string, bytes = png, name = 'renamed.bin') {
    const id = randomUUID(); const res = await fetch(`${app.origin}${scope}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: bytes }); assert.equal(res.status, 200); return id;
  }
  async function until(scope: string, id: string) {
    for (let n = 0; n < 150; n++) { const row = (await request(scope + '/turns')).find((row: any) => row.id === id); if (row && ['done','failed'].includes(row.status)) return row; await new Promise(resolve => setTimeout(resolve, 15)); } assert.fail('Task did not settle');
  }
  const images = (payload: any) => payload.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url' || part.type === 'image') : []);
  const exactImage = (part: any) => assert.equal(family === 'anthropic' ? part.source.data : part.image_url.url, family === 'anthropic' ? png.toString('base64') : 'data:image/png;base64,' + png.toString('base64'));
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'vision', instructions: 'Inspect images' });
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'vision', instructions: 'Inspect images' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Route images', lead: a.id, members: [a.id, b.id] });
    const thread = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const scopes = [`/api/agents/${a.id}`, `/api/channels/${room.id}`, `/api/threads/${thread.id}`], files: string[] = [];
    for (const scope of scopes) {
      const image = await upload(scope), note = await upload(scope, Buffer.from('NOTE_DATA'), 'note.txt'); files.push(image);
      const id = randomUUID(), command = { id, text: 'Describe selected image', files: [image, note], ...(scope.includes('channels') ? { automatic: true } : {}) }, start = payloads.length;
      await request(scope + '/turns', command); assert.equal((await until(scope, id)).status, 'done');
      for (const payload of payloads.slice(start)) { assert.equal(images(payload).length, 1); exactImage(images(payload)[0]); assert(JSON.stringify(payload).includes('NOTE_DATA')); }
      const count = payloads.length; await request(scope + '/turns', command); assert.equal(payloads.length, count);
      await request(scope + '/turns', { ...command, files: [image] }, 409);
      assert.deepEqual(Buffer.from(await (await fetch(`${app.origin}${scope}/files/${image}`)).arrayBuffer()), png);
      mode = 'read'; target = image; stage = 0; const read = randomUUID(), before = payloads.length;
      await request(scope + '/turns', { id: read, text: 'Inspect previous image', ...(scope.includes('channels') ? { recipient: a.id } : {}) }); assert.equal((await until(scope, read)).status, 'done');
      assert.equal(images(payloads[before]).length, 0); assert.equal(images(payloads.at(-1)).length, 1); exactImage(images(payloads.at(-1))[0]);
      mode = 'text';
    }
    await request(scopes[0] + '/turns', { id: randomUUID(), text: 'Foreign', files: [files[1]] }, 404);
    mode = 'read'; target = files[1]; stage = 0; const foreign = randomUUID();
    await request(scopes[0] + '/turns', { id: foreign, text: 'Read foreign image' }); assert.equal((await until(scopes[0], foreign)).status, 'done'); assert.equal(images(payloads.at(-1)).length, 0); assert(JSON.stringify(payloads.at(-1)).includes('Attachment not found'));
    target = await upload(scopes[0]); stage = 0; const unsent = randomUUID();
    await request(scopes[0] + '/turns', { id: unsent, text: 'Read unsent image' }); await until(scopes[0], unsent); assert.equal(images(payloads.at(-1)).length, 0);
    const large = await upload(scopes[0], Buffer.concat([png, Buffer.alloc(imageLimit)]));
    await request(scopes[0] + '/turns', { id: randomUUID(), text: 'Large', files: [large] }, 413);
    const binary = await upload(scopes[0], Buffer.from([0,255]), 'fake.png');
    await request(scopes[0] + '/turns', { id: randomUUID(), text: 'Invalid', files: [binary] }, 415);
    const tooMany = await Promise.all(Array.from({ length: 5 }, () => upload(scopes[0])));
    await request(scopes[0] + '/turns', { id: randomUUID(), text: 'Five', files: tooMany }, 400);
    const half = Buffer.concat([png, Buffer.alloc(Math.floor(imageLimit / 2))]);
    const halfIds = [await upload(scopes[0], half), await upload(scopes[0], half)];
    await request(scopes[0] + '/turns', { id: randomUUID(), text: 'Total', files: halfIds }, 413);
    mode = 'text'; const oldImage = randomUUID();
    await request(scopes[0] + '/turns', { id: oldImage, text: 'Older image', files: [halfIds[0]] }); await until(scopes[0], oldImage);
    mode = 'read'; target = halfIds[0]; stage = 0; const overBudget = randomUUID();
    await request(scopes[0] + '/turns', { id: overBudget, text: 'Current plus older image', files: [halfIds[1]] }); assert.equal((await until(scopes[0], overBudget)).status, 'done');
    assert.equal(images(payloads.at(-1)).length, 1); assert(JSON.stringify(payloads.at(-1)).includes('Image context exceeds 4 MiB'));
    target = files[0]; stage = 0; const duplicate = randomUUID();
    await request(scopes[0] + '/turns', { id: duplicate, text: 'Already attached', files: [target] }); await until(scopes[0], duplicate);
    assert.equal(images(payloads.at(-1)).length, 1); assert(JSON.stringify(payloads.at(-1)).includes('already included'));
    await app.close(); app = await startApp(options); mode = 'read'; target = files[0]; stage = 0;
    const afterRestart = randomUUID(); await request(scopes[0] + '/turns', { id: afterRestart, text: 'Read after restart' }); assert.equal((await until(scopes[0], afterRestart)).status, 'done'); exactImage(images(payloads.at(-1))[0]);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
