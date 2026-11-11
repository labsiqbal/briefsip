import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('queue edit holds survive restart, preserve order and original receipt, reject competing editors and completed cancellations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-queue-edit-'));
  const calls: string[] = []; let held: ServerResponse | undefined;
  const finish = (res: ServerResponse) => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] }));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const text = JSON.parse(raw).messages.at(-1).content; calls.push(text);
    if (text === 'BLOCK') held = res; else finish(res);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 1 };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status?: number): Promise<any> {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await res.json(); if (status) assert.equal(res.status, status, JSON.stringify(result)); else assert(res.ok, JSON.stringify(result)); return result;
  }
  async function until(check: () => Promise<boolean>) { for (let n=0; n<200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out'); }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Channel', lead: a.id, members: [a.id], instructions: 'Help' });
    for (const path of [`/api/agents/${a.id}/turns`, `/api/threads/${side.id}/turns`, `/api/channels/${channel.id}/turns`]) {
      held = undefined; const blocker = randomUUID(); await request(path, { id: blocker, text: 'BLOCK' }); await until(async () => !!held);
      const fileId = randomUUID(), filePath = path.replace(/\/turns$/, '/files') + '/' + fileId;
      const upload = await fetch(app.origin + filePath, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'note.txt' }, body: 'Saved attachment' }); assert.equal(upload.status, 200);
      const command = { id: randomUUID(), text: 'ORIGINAL', files: [fileId] }, tail = randomUUID();
      const turn = await request(path, command); await request(path, { id: tail, text: 'TAIL' });
      const editPath = `${path}/${turn.id}/edit`, hold = { id: randomUUID(), editor: randomUUID(), revision: turn.revision, action: 'hold' };
      const accepted = await request(editPath, hold); assert.deepEqual(accepted.files, [fileId]); assert.deepEqual(await request(editPath, hold), accepted);
      await request(`/api/agents/${b.id}/turns/${turn.id}/edit`, hold, 404);
      await request(editPath, { ...hold, id: randomUUID(), editor: randomUUID(), revision: accepted.revision }, 409);
      await request(`${path}/${turn.id}/pause`, { id: randomUUID(), revision: accepted.revision }, 409);
      const publicRows = await request(path); assert.equal(publicRows.find((row: any) => row.id === turn.id).editing, true); assert(!JSON.stringify(publicRows).includes(hold.editor));
      if (path.includes('/channels/')) {
        await request(`/api/agents/${a.id}/visibility`, { id: randomUUID(), revision: 0, hidden: true });
        assert.equal((await request(path)).find((row: any) => row.id === turn.id).revision, accepted.revision);
        await request(`/api/agents/${a.id}/visibility`, { id: randomUUID(), revision: 1, hidden: false });
      }
      finish(held!); await until(async () => (await request(path)).find((row: any) => row.id === blocker)?.status === 'done');
      await app.close(); app = await startApp(options);
      assert.equal((await request(path)).find((row: any) => row.id === tail).status, 'queued');
      await request(editPath, { id: randomUUID(), editor: hold.editor, revision: accepted.revision, action: 'save', text: 'WRONG', files: [randomUUID()] }, 404);
      const save = { id: randomUUID(), editor: hold.editor, revision: accepted.revision, action: 'save', text: 'CHANGED', files: [] };
      const result = await request(editPath, save); assert.deepEqual(await request(editPath, save), result);
      await until(async () => (await request(path)).find((row: any) => row.id === tail)?.status === 'done');
      assert.deepEqual(calls.slice(-3), ['BLOCK', 'CHANGED', 'TAIL']);
      const edited = await request(path, command); assert.equal(edited.text, 'CHANGED'); assert.deepEqual(JSON.parse(edited.attachments), []);
      assert.equal(await (await fetch(app.origin + filePath)).text(), 'Saved attachment');
      await request(path, { ...command, text: 'CHANGED' }, 409);
      await request(editPath, { ...save, id: randomUUID(), action: 'cancel', text: undefined, files: undefined }, 409);
    }
    const path = `/api/agents/${a.id}/turns`; held = undefined;
    await request(path, { id: randomUUID(), text: 'BLOCK' }); await until(async () => !!held);
    const turn = await request(path, { id: randomUUID(), text: 'UNCHANGED' });
    const editPath = `${path}/${turn.id}/edit`, editor = randomUUID();
    const hold = await request(editPath, { id: randomUUID(), editor, revision: turn.revision, action: 'hold' });
    const cancel = { id: randomUUID(), editor, revision: hold.revision, action: 'cancel' };
    const result = await request(editPath, cancel); assert.deepEqual(await request(editPath, cancel), result);
    await request(editPath, { id: randomUUID(), editor, revision: result.revision, action: 'save', text: 'NEVER', files: [] }, 409);
    finish(held!); await until(async () => (await request(path)).find((row: any) => row.id === turn.id)?.status === 'done');
    assert.equal(calls.at(-1), 'UNCHANGED');
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
