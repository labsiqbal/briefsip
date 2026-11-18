import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { restoreChatCommand } from './conversation-command.ts';

test('attachment-only messages validate, recover and retry in direct chats, threads and rooms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-attachment-only-'));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.match(raw, /Synthetic attachment|Its contents have not been transcribed/);
    assert(!raw.includes('PRIVATE_AUDIO_BYTES'));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Attachment received' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  const request = async (path: string, data: unknown, status?: number) => {
    const res = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (status) assert.equal(res.status, status); else assert(res.ok, await res.clone().text()); return res.json();
  };
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Files', model: 'fixture', instructions: 'Synthetic' });
    const thread = await request(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', members: [agent.id], lead: agent.id, instructions: 'Synthetic' });
    for (const path of [`/api/agents/${agent.id}/turns`, `/api/threads/${thread.id}/turns`, `/api/channels/${room.id}/turns`]) {
      const file = randomUUID();
      const upload = await fetch(app.origin + path.replace(/\/turns$/, '/files') + '/' + file, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'notes.txt' }, body: 'Synthetic attachment' });
      assert.equal(upload.status, 200);
      const command = { id: randomUUID(), text: '', files: [file] };
      assert.deepEqual(restoreChatCommand(JSON.stringify(command), path.includes('/channels/')), command);
      const accepted = await request(path, command); assert.equal(accepted.text, '');
      assert.equal((await request(path, command)).id, command.id);
      await request(path, { ...command, files: [] }, 400);
      await request(path, { id: randomUUID(), text: '', files: [] }, 400);
      await request(path, { id: randomUUID(), text: '', files: [randomUUID()] }, 404);
      await request(path, { id: randomUUID(), text: ' '.repeat(16001), files: [file] }, 400);
      let rows: any[] = [];
      for (let n = 0; n < 200; n++) { rows = await fetch(app.origin + path).then(res => res.json()); if (rows.find(row => row.id === command.id)?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(rows.find(row => row.id === command.id)?.status, 'done');
      assert.equal(rows.find(row => row.id === command.id)?.files[0].id, file);
    }
    const path = `/api/agents/${agent.id}/turns`, file = randomUUID();
    const bytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.from('PRIVATE_AUDIO_BYTES')]);
    const upload = await fetch(`${app.origin}/api/agents/${agent.id}/files/${file}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'Voice note 0:04.wav' }, body: bytes });
    assert.equal(upload.status, 200);
    const command = { id: randomUUID(), text: '', files: [file] };
    await request(path, command); assert.equal((await request(path, command)).id, command.id);
    let audio: any;
    for (let n = 0; n < 200; n++) { audio = (await fetch(app.origin + path).then(res => res.json())).find((row: any) => row.id === command.id); if (audio?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(audio.status, 'done'); assert.equal(audio.files[0].name, 'Voice note 0:04.wav');
    const large = [randomUUID(), randomUUID()];
    for (const id of large) {
      const upload = await fetch(`${app.origin}/api/agents/${agent.id}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'large.wav' }, body: Buffer.concat([bytes, Buffer.alloc(6 * 1024 * 1024)]) });
      assert.equal(upload.status, 200);
    }
    await request(path, { id: randomUUID(), text: '', files: large }, 413);
    assert.throws(() => restoreChatCommand(JSON.stringify({ id: randomUUID(), text: '', files: [] }), false));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
