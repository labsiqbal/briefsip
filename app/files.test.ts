import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('files preserve bytes, scope, retry identity and archive boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-files-')), database = join(dir, 'state.sqlite');
  let app = await startApp({ database });
  const post = async (path: string, data: unknown) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert(response.ok); return response.json();
  };
  const upload = (path: string, bytes: Uint8Array, name = 'report.bin', origin = app.origin) => fetch(app.origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: Buffer.from(bytes) });
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Files', model: 'fixture', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Files room', instructions: 'Help.', members: [agent.id], lead: agent.id });
    const thread = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Files side' });
    const direct = `/api/agents/${agent.id}/files`, room = `/api/channels/${channel.id}/files`, side = `/api/threads/${thread.id}/files`;
    const id = randomUUID(), bytes = Buffer.from([0, 255, 128, 10, 13, 65]), path = `${room}/${id}`;
    const response = await upload(path, bytes, 'report é.bin'); assert.equal(response.status, 200);
    const receipt = await response.json(); assert.equal(receipt.size, bytes.length);
    const metadata = await (await fetch(app.origin + path + '?metadata=1')).json();
    assert.equal(metadata.digest, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(metadata.size, receipt.size); assert.equal(metadata.id, id);
    assert(!('bytes' in metadata));
    assert.deepEqual(await (await upload(path, bytes, 'report é.bin')).json(), receipt);
    assert.equal((await upload(path, Buffer.from('different'), 'report é.bin')).status, 409);
    assert.equal((await upload(`${direct}/${id}`, bytes, 'report é.bin')).status, 409);
    assert.equal((await fetch(app.origin + `${direct}/${id}`)).status, 404);
    assert.equal((await fetch(app.origin + `${direct}/${id}?metadata=1`)).status, 404);
    assert.deepEqual(await (await fetch(app.origin + direct)).json(), []);
    const download = await fetch(app.origin + path);
    assert.match(download.headers.get('content-disposition')!, /attachment/);
    assert.match(download.headers.get('content-disposition')!, /%C3%A9/);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(app.origin + path + '?preview=text')).status, 415);
    const textId = randomUUID(), html = '<script>window.injected = true</script>\nHello';
    assert.equal((await upload(`${direct}/${textId}`, Buffer.from(html), 'example.html')).status, 200);
    const preview = await fetch(app.origin + `${direct}/${textId}?preview=text`);
    assert.equal(preview.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal((await preview.json()).text, html);
    assert.equal((await fetch(app.origin + `${room}/${textId}?preview=text`)).status, 404);
    const largeText = randomUUID();
    await upload(`${direct}/${largeText}`, Buffer.alloc(256 * 1024 + 1, 65), 'large.txt');
    assert.equal((await fetch(app.origin + `${direct}/${largeText}?preview=text`)).status, 413);
    assert.equal((await upload(`${room}/${randomUUID()}`, bytes, '../escape')).status, 400);
    assert.equal((await upload(`${room}/${randomUUID()}`, bytes, 'bad\nname')).status, 400);
    assert.equal((await upload(`${room}/${randomUUID()}`, bytes, 'safe', 'https://outside.test')).status, 403);
    assert.equal((await upload(`${room}/${randomUUID()}`, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
    const oversizedId = randomUUID();
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(app.origin + `${room}/${oversizedId}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'large.bin', 'Transfer-Encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      for (let i = 0; i < 11; i++) request.write(Buffer.alloc(1024 * 1024));
      request.end();
    });
    assert.equal(chunked, 413);
    assert.equal((await fetch(app.origin + `${room}/${oversizedId}`)).status, 404);
    assert.equal((await fetch(app.origin + room + '?before=-1')).status, 400);
    assert.deepEqual(await (await fetch(app.origin + room + `?before=${receipt.seq}`)).json(), []);
    let finishUpload!: () => void;
    const delayedId = randomUUID();
    const delayed = new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(app.origin + `${room}/${delayedId}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'delayed.bin', 'Content-Length': bytes.length } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.write(bytes.subarray(0, 1)); finishUpload = () => request.end(bytes.subarray(1));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    await post(`/api/channels/${channel.id}/edit`, { ...channel, id: randomUUID(), revision: 1, archived: true });
    finishUpload(); assert.equal(await delayed, 409);
    assert.equal((await fetch(app.origin + `${room}/${delayedId}`)).status, 404);
    assert.equal((await upload(`${room}/${randomUUID()}`, bytes)).status, 409);
    assert.deepEqual(await (await upload(path, bytes, 'report é.bin')).json(), receipt);
    await app.close(); app = await startApp({ database });
    assert.deepEqual(Buffer.from(await (await fetch(app.origin + path)).arrayBuffer()), bytes);
    assert.equal((await (await fetch(app.origin + room)).json()).length, 1);
    const sideFile = `${side}/${randomUUID()}`;
    assert.equal((await upload(sideFile, bytes)).status, 200);
    let finishDeleted!: () => void;
    const removedUpload = new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(app.origin + `${side}/${randomUUID()}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'deleted.bin', 'Content-Length': bytes.length } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.write(bytes.subarray(0, 1)); finishDeleted = () => request.end(bytes.subarray(1));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    await post(`/api/threads/${thread.id}/edit`, { id: randomUUID(), revision: 1, name: thread.name, archived: true });
    await post(`/api/threads/${thread.id}/delete`, { id: randomUUID(), revision: 2 });
    finishDeleted(); assert.equal(await removedUpload, 404);
    assert.equal((await fetch(app.origin + sideFile)).status, 404);
    assert.equal((await upload(sideFile, bytes)).status, 404);
    assert.equal((await upload(`${direct}/${randomUUID()}`, Buffer.alloc(0), 'empty.txt')).status, 200);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('text attachments reach only selected conversation and retain retry identity', async () => {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-attachments-'));
  const calls: string[][] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw).messages.map((message: { content: string }) => message.content));
    const messages = calls.at(-1)!;
    const content = messages[0].startsWith('Choose exactly one channel member')
      ? JSON.stringify({ action: 'assign', recipient: JSON.parse(messages.at(-1)!).members.find((member: { name: string }) => member.name === 'Worker').id })
      : 'Read attachment.';
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  async function post(path: string, data: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  async function wait(path: string, id: string) {
    for (let i = 0; i < 100; i++) {
      const turn = (await (await fetch(app.origin + path)).json()).find((row: { id: string }) => row.id === id);
      if (turn.status === 'done') return turn;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Attachment response did not finish');
  }
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Reader', model: 'fixture', instructions: 'Help.' }, 201);
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help.', lead: agent.id, members: [agent.id] }, 201);
    const path = `/api/channels/${channel.id}/turns`, main = `/api/agents/${agent.id}/turns`;
    const ids: string[] = [];
    for (const [name, bytes] of [['note.txt', Buffer.from('PRIVATE_ROOM_NOTE')], ['binary.bin', Buffer.from([0,255])], ['large.txt', Buffer.alloc(32769, 65)]] as const) {
      const id = randomUUID(); ids.push(id);
      const response = await fetch(app.origin + `/api/channels/${channel.id}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: bytes });
      assert.equal(response.status, 200);
    }
    await post(main, { id: randomUUID(), text: 'Read', files: [ids[0]] }, 404);
    await post(path, { id: randomUUID(), text: 'Read', files: [ids[1]] }, 415);
    await post(path, { id: randomUUID(), text: 'Read', files: [ids[2]] }, 413);
    await post(path, { id: randomUUID(), text: 'Read', files: [ids[0],ids[0]] }, 400);
    await post(path, { id: randomUUID(), text: 'Read', files: null }, 400);
    assert.equal(calls.length, 0);
    const send = { id: randomUUID(), text: 'Read', files: [ids[0]] };
    await post(path, send, 202); const done = await wait(path, send.id);
    assert.equal(done.files[0].name, 'note.txt');
    assert(calls[0].at(-1)!.includes('PRIVATE_ROOM_NOTE'));
    await post(path, send, 202); assert.equal(calls.length, 1);
    await post(path, { ...send, files: [] }, 409);
    await app.close(); app = await startApp(options);
    const follow = { id: randomUUID(), text: 'Follow up' };
    await post(path, follow, 202); await wait(path, follow.id);
    assert(calls[1].some(text => text.includes('PRIVATE_ROOM_NOTE')));
    const direct = { id: randomUUID(), text: 'Direct chat' };
    await post(main, direct, 202); await wait(main, direct.id);
    assert(!calls[2].some(text => text.includes('PRIVATE_ROOM_NOTE')));
    const worker = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Worker', model: 'fixture', instructions: 'Help.' }, 201);
    await post(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: channel.revision, name: channel.name, instructions: 'Help.', lead: agent.id, members: [agent.id, worker.id], archived: false });
    const routed = { id: randomUUID(), text: 'Route this file', automatic: true, files: [ids[0]] };
    await post(path, routed, 202);
    const routedDone = await wait(path, routed.id);
    assert.equal(routedDone.agent, worker.id);
    assert.equal(routedDone.routing, 'assigned');
    assert.equal(calls.length, 5);
    assert(JSON.parse(calls[3].at(-1)!).request.includes('PRIVATE_ROOM_NOTE'));
    assert(calls[4].at(-1)!.includes('PRIVATE_ROOM_NOTE'));
    const sideA = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side A' });
    const sideB = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side B' });
    const fileId = randomUUID();
    const upload = await fetch(app.origin + `/api/threads/${sideA.id}/files/${fileId}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'side.txt' }, body: 'PRIVATE_SIDE_NOTE' });
    assert.equal(upload.status, 200);
    const sidePathA = `/api/threads/${sideA.id}/turns`, sidePathB = `/api/threads/${sideB.id}/turns`;
    const sideSend = { id: randomUUID(), text: 'Read side file', files: [fileId] };
    await post(sidePathB, sideSend, 404);
    await post(sidePathA, sideSend, 202); await wait(sidePathA, sideSend.id);
    assert(calls[5].at(-1)!.includes('PRIVATE_SIDE_NOTE'));
    const otherSend = { id: randomUUID(), text: 'Other side' };
    await post(sidePathB, otherSend, 202); await wait(sidePathB, otherSend.id);
    assert(!calls[6].some(text => text.includes('PRIVATE_SIDE_NOTE') || text.includes('PRIVATE_ROOM_NOTE')));

  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
