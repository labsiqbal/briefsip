import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startApp } from './test-bridge.ts';
import { restoreWorkspace } from './test-support/backup.ts';

test('avatar HTTP validates images, isolates agents, preserves receipts and survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-avatar-'));
  const options = { database: join(dir, 'state.sqlite') };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Avatar', model: 'fixture', instructions: 'Help' }, 201);
    const other = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Other', model: 'fixture', instructions: 'Help' }, 201);
    const path = `/api/agents/${agent.id}/avatar`;
    assert.deepEqual(await request(path), { revision: 0, present: false });
    let revision = 0;
    let firstCommand: { id: string; revision: number; image: string } | undefined;
    for (const format of ['png','jpeg','webp'] as const) {
      const input = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#cc7733' } }).toFormat(format).withMetadata().toBuffer();
      const command = { id: randomUUID(), revision, image: input.toString('base64') };
      firstCommand ??= command;
      const result = await request(path, command); revision++;
      assert.deepEqual(result, { revision, present: true });
      assert.deepEqual(await request(path, command), result);
      const response = await fetch(app.origin + path + '/image');
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer()), meta = await sharp(bytes).metadata();
      assert.equal(meta.width, 256); assert.equal(meta.height, 256); assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
      await request(`/api/agents/${other.id}/avatar`, command, 409);
      await request(path, { ...command, image: null }, 409);
    }
    assert.deepEqual(await request(`/api/agents/${other.id}/avatar`), { revision: 0, present: false });
    const animatedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABFmZEFUAAAAAnicY/jPwPAfAAUAAf+alZNkAAAAAElFTkSuQmCC';
    await request(path, { id: randomUUID(), revision, image: animatedPng }, 400);
    await request(path, { id: randomUUID(), revision: 0, image: null }, 409);
    for (const image of ['<svg/>', Buffer.from('<svg/>').toString('base64'), '/9j/AA==', 'a'.repeat(699056)]) {
      await request(path, { id: randomUUID(), revision, image }, image.length > 699052 ? 413 : 400);
    }
    const enormous = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#111111' } }).png().toBuffer();
    await request(path, { id: randomUUID(), revision, image: enormous.toString('base64') }, 400);
    const foreign = await fetch(app.origin + path, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
    await request(`/api/agents/${randomUUID()}/avatar`, undefined, 404);
    const before = (await request('/api/agents')).agents.find((item: { id: string }) => item.id === agent.id);
    assert.equal(before.avatar_revision, revision); assert.equal(before.revision, agent.revision);
    const savedBytes = Buffer.from(await (await fetch(app.origin + path + '/image')).arrayBuffer());
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(backup.status, 200);
    const snapshot = join(dir, 'snapshot.sqlite'), restored = join(dir, 'restored.sqlite');
    writeFileSync(snapshot, Buffer.from(await backup.arrayBuffer())); restoreWorkspace(snapshot, restored);
    const restoredApp = await startApp({ database: restored });
    try { assert.deepEqual(Buffer.from(await (await fetch(restoredApp.origin + path + '/image')).arrayBuffer()), savedBytes); }
    finally { await restoredApp.close(); }
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(path), { revision, present: true });
    const concurrent = { id: randomUUID(), revision, image: savedBytes.toString('base64') };
    const results = await Promise.all([request(path, concurrent), request(path, concurrent)]);
    revision++;
    assert.deepEqual(results, [{ revision, present: true }, { revision, present: true }]);
    await request(path, { ...concurrent, id: randomUUID() }, 409);
    const command = { id: randomUUID(), revision, image: null };
    const removed = await request(path, command);
    assert.deepEqual(removed, { revision: revision + 1, present: false });
    assert.deepEqual(await request(path, command), removed);
    assert.deepEqual(await request(path, firstCommand), { revision: 1, present: true });
    assert.deepEqual(await request(path), removed);
    assert.equal((await fetch(app.origin + path + '/image')).status, 404);
    assert.equal((await request('/api/agents')).agents.find((item: { id: string }) => item.id === agent.id).avatar_revision, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
