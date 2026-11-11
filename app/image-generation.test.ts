import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ84AAAAASUVORK5CYII=', 'base64');
test('image generation preserves scope, uncertain receipts and exact artifacts through restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-image-gen-'));
  let mode = 'ok', calls = 0, continuation = false, seenImage = false, release: (() => void) | undefined;
  const images = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/images/generations'); assert.equal(req.headers.authorization, 'Bearer image-secret'); calls++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { model: 'fixture-image', prompt: 'Synthetic landscape', n: 1, size: '1024x1024', output_format: 'png' });
    if (mode === 'lost') { res.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(); return; }
    const image = mode === 'large' ? Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024 - png.length)]) : png;
    const send = () => res.end(JSON.stringify({ data: mode === 'url' ? [{ url: 'http://127.0.0.1/private' }] : [{ b64_json: mode === 'invalid' ? 'AA==' : image.toString('base64') }], usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } }));
    if (mode === 'late') release = send; else send();
  });
  const chat = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer chat-secret'); let raw = ''; for await (const chunk of req) raw += chunk; assert(!raw.includes('image-secret'));
    const body = JSON.parse(raw);
    if (mode === 'disabled') { assert(!body.tools.some((tool: any) => tool.function.name === 'generate_image')); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Image provider disabled.' } }] })); return; }
    assert(body.tools.some((tool: any) => tool.function.name === 'generate_image'));
    const results = body.messages.filter((message: any) => message.role === 'tool');
    if (results.length) continuation = true;
    if (results.length && mode === 'hold') return;
    seenImage ||= body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url'));
    const result = results.length ? JSON.parse(results[0].content) : null;
    const tool = !results.length ? { id: 'generate', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'Synthetic landscape' }) } } : results.length === 1 && result.id ? { id: 'read', type: 'function', function: { name: 'read_attachment', arguments: JSON.stringify({ id: result.id }) } } : null;
    res.end(JSON.stringify({ choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { tool_calls: [tool] } : { content: 'Image complete or uncertain receipt checked.' } }] }));
  });
  for (const server of [chat, images]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const ca = chat.address(), ia = images.address(); assert(ca && typeof ca !== 'string' && ia && typeof ia !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${ca.port}/v1`, apiKey: 'chat-secret', imageProvider: { baseURL: `http://127.0.0.1:${ia.port}/v1`, model: 'fixture-image', apiKey: 'image-secret' } };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; }
  async function until(path: string, id: string, status: string) { for (let n = 0; n < 300; n++) { const row = (await request(path + '/turns')).find((row: any) => row.id === id); if (row?.status === status) return row; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Missing ${status}`); }
  async function waitFor(check: () => boolean) { for (let n = 0; n < 300 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(check()); }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'Artist', model: 'chat', instructions: 'Generate' });
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', members: [a.id], lead: a.id, instructions: 'Generate' });
    const scopes = [`/api/agents/${a.id}`, `/api/threads/${side.id}`, `/api/channels/${room.id}`];
    for (const path of scopes) {
      const id = randomUUID(); seenImage = false; await request(path + '/turns', { id, text: 'Image', ...(path.includes('channels') ? { recipient: a.id } : {}) });
      const row = await until(path, id, 'done'); assert.equal(row.generatedFiles.length, 1); assert(seenImage);
      const file = row.generatedFiles[0]; const res = await fetch(app.origin + path + '/files/' + file.id); assert.deepEqual(Buffer.from(await res.arrayBuffer()), png); assert.match(res.headers.get('content-disposition')!, /attachment/);
      assert.equal((await fetch(app.origin + scopes.find(other => other !== path) + '/files/' + file.id)).status, 404);
    }
    const path = scopes[0];
    mode = 'large'; const large = randomUUID(); await request(path + '/turns', { id: large, text: 'Large image boundary' }); assert.equal((await until(path, large, 'done')).generatedFiles[0].size, 4 * 1024 * 1024);
    mode = 'hold'; continuation = false; const id = randomUUID(); await request(path + '/turns', { id, text: 'Restart' }); await waitFor(() => continuation);
    const before = calls; await app.close(); app = await startApp(options); mode = 'ok';
    const stopped = await until(path, id, 'interrupted'); await request(`${path}/turns/${id}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true });
    const resumed = await until(path, id, 'done'); assert.deepEqual(resumed.generatedFiles, stopped.generatedFiles); assert.equal(calls, before);
    for (mode of ['lost', 'invalid', 'url', 'redirect']) {
      const id = randomUUID(); await request(path + '/turns', { id, text: mode }); const failed = await until(path, id, 'failed'); assert.equal(failed.generatedFiles.length, 0); const count = calls;
      await request(`${path}/turns/${id}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true }); await until(path, id, 'done'); assert.equal(calls, count);
    }
    mode = 'late'; const cancel = randomUUID(); await request(path + '/turns', { id: cancel, text: 'Cancel' }); await waitFor(() => !!release); await request(`${path}/turns/${cancel}/cancel`, { id: randomUUID() }); release!(); assert.equal((await until(path, cancel, 'cancelled')).generatedFiles.length, 0);
    const usage = await request('/api/usage'); const rows = usage.calls.filter((row: any) => row.phase === 'image'); assert(rows.some((row: any) => row.status === 'received' && row.total_tokens === 11)); assert(rows.some((row: any) => row.status === 'failed'));
    await app.close(); app = await startApp({ ...options, imageProvider: undefined }); mode = 'disabled'; const disabled = randomUUID(), beforeDisabled = calls; await request(path + '/turns', { id: disabled, text: 'No image provider' }); await until(path, disabled, 'done'); assert.equal(calls, beforeDisabled);
  } finally { release?.(); await app.close(); for (const server of [chat, images]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } rmSync(dir, { recursive: true, force: true }); }
});
