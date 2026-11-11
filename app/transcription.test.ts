import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { audioFormat } from './transcription.ts';

function mp4Header(brand: string) {
  const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write(brand, 8); bytes.write('isom', 16); bytes.write('mp42', 20); return bytes;
}

test('audio detection recognizes MP4 brands and rejects malformed ftyp and image containers', () => {
  for (const brand of ['M4A ', 'M4B ', 'isom', 'mp41', 'mp42', 'iso2', 'iso5', 'iso6']) assert.equal(audioFormat(mp4Header(brand)), 'mp4');
  for (const brand of ['avif', 'heic', 'mif1', 'xxxx']) assert.equal(audioFormat(mp4Header(brand)), null);
  for (const size of [0, 1, 8, 15, 17, 25, 0xffffffff]) { const bytes = mp4Header('M4A '); bytes.writeUInt32BE(size); assert.equal(audioFormat(bytes), null); }
  assert.equal(audioFormat(mp4Header('M4A ').subarray(0, 15)), null);
});

test('HTTP transcription requires consent, isolates files and never silently replays uncertain requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-transcription-'));
  const bytes = Buffer.concat([mp4Header('M4A '), Buffer.from('synthetic audio transport bytes')]);
  let calls = 0, invalid: false | 'secret' | 'surrogate' | 'utf8' = false;
  const provider = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert(body.includes(bytes)); assert(body.includes(Buffer.from('fixture-transcribe')));
    assert(body.includes(Buffer.from('filename="audio.mp4"')));
    res.setHeader('Content-Type', 'application/json');
    if (invalid === 'utf8') res.end(Buffer.concat([Buffer.from('{\"text\":\"'), Buffer.from([255]), Buffer.from('\"}')]));
    else res.end(JSON.stringify({ text: invalid === 'secret' ? 'synthetic-secret' : invalid === 'surrogate' ? '\ud800' : 'Hasil transkripsi.\nBaris dua.' }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), transcriptionProvider: { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-transcribe', apiKey: 'synthetic-secret' } };
  let app = await startApp(options);
  const post = (path: string, data: unknown, origin = app.origin) => fetch(app.origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const get = async (path: string) => { const response = await fetch(app.origin + path); assert.equal(response.status, 200); return response.json(); };
  try {
    const agent = await (await post('/api/agents', { id: randomUUID(), name: 'Audio', model: 'fixture', instructions: 'Help.' })).json();
    const channel = await (await post('/api/channels', { id: randomUUID(), name: 'Audio room', instructions: 'Help.', members: [agent.id], lead: agent.id })).json();
    const thread = await (await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Audio side' })).json();
    const unsupported = `/api/agents/${agent.id}/files/${randomUUID()}`;
    await fetch(app.origin + unsupported, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'fake.wav' }, body: 'not audio' });
    const unsupportedInfo = await get(`${unsupported}?transcription=1`);
    assert.equal(unsupportedInfo.format, null);
    assert.equal((await post(`${unsupported}?transcription=1`, { id: randomUUID(), provider: unsupportedInfo.provider.id, consent: true })).status, 415);
    assert.equal(calls, 0);
    for (const scope of [`agents/${agent.id}`, `channels/${channel.id}`, `threads/${thread.id}`]) {
      const path = `/api/${scope}/files/${randomUUID()}`;
      assert.equal((await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'private.wav' }, body: bytes })).status, 200);
      const endpoint = `${path}?transcription=1`, info = await get(endpoint);
      const request = { id: randomUUID(), provider: info.provider.id, consent: true };
      assert.equal((await post(endpoint, { ...request, consent: false })).status, 400);
      assert.equal((await post(endpoint, request, 'https://outside.test')).status, 403);
      assert.equal((await post(endpoint, { ...request, provider: 'stale' })).status, 409);
      const before: number = calls;
      const result = await (await post(endpoint, request)).json(); assert.equal(result.status, 'done');
      assert.deepEqual(await (await post(endpoint, request)).json(), result); assert.equal(calls, before + 1);
      assert(!('request' in result));
      const output = `/api/${scope}/files/${result.result.id}`;
      assert.equal(await (await fetch(app.origin + output)).text(), 'Hasil transkripsi.\nBaris dua.');
      assert.equal((await fetch(app.origin + `/api/agents/${randomUUID()}/files/${result.result.id}`)).status, 404);
      assert.equal((await post(endpoint, { ...request, id: randomUUID() })).status, 409);
    }
    const path = `/api/agents/${agent.id}/files/${randomUUID()}`;
    await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'retry.wav' }, body: bytes });
    const endpoint = `${path}?transcription=1`, info = await get(endpoint);
    const request = { id: randomUUID(), provider: info.provider.id, consent: true };
    invalid = 'secret';
    assert.equal((await (await post(endpoint, request)).json()).status, 'uncertain');
    const count = calls;
    await app.close(); app = await startApp(options);
    assert.equal((await get(endpoint)).operation.status, 'uncertain');
    assert.equal((await (await post(endpoint, request)).json()).status, 'uncertain'); assert.equal(calls, count);
    assert.equal((await post(endpoint, { ...request, id: randomUUID() })).status, 409);
    for (const bad of ['surrogate', 'utf8'] as const) {
      invalid = bad;
      const attempt = { ...request, id: randomUUID(), retryOf: (await get(endpoint)).operation.id };
      assert.equal((await (await post(endpoint, attempt)).json()).status, 'uncertain');
    }
    invalid = false;
    const lastAttempt = (await get(endpoint)).operation.id;
    assert.equal((await (await post(endpoint, { ...request, id: randomUUID(), retryOf: lastAttempt })).json()).status, 'done');
    assert.equal(calls, count + 3);
  } finally {
    await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight transcription deduplicates and cannot publish after archive or shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-transcription-race-'));
  let calls = 0, release = () => {}, arrived = () => {};
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain multipart before holding response. */ }
    calls++; release = () => res.end(JSON.stringify({ text: 'Held result' })); arrived();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), transcriptionProvider: { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' } };
  let app = await startApp(options);
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const agent = await (await post('/api/agents', { id: randomUUID(), name: 'Held', model: 'fixture', instructions: 'Help.' })).json();
    for (const shutdown of [false, true]) {
      const thread = await (await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' })).json();
      const files = `/api/threads/${thread.id}/files`, path = `${files}/${randomUUID()}`;
      assert.equal((await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'audio.wav' }, body: 'RIFF0000WAVEfixture' })).status, 200);
      const endpoint = `${path}?transcription=1`, info = await (await fetch(app.origin + endpoint)).json();
      const request = { id: randomUUID(), provider: info.provider.id, consent: true };
      const barrier = new Promise<void>(resolve => { arrived = resolve; });
      const pending = post(endpoint, request).catch(() => null); await barrier;
      const count = calls;
      assert.equal((await (await post(endpoint, request)).json()).status, 'pending');
      assert.equal((await post(endpoint, { ...request, id: randomUUID() })).status, 409); assert.equal(calls, count);
      if (shutdown) {
        await app.close(); await pending; release(); app = await startApp(options);
      } else {
        const archived = await post(`/api/threads/${thread.id}/edit`, { id: randomUUID(), revision: 1, name: 'Side', archived: true }); assert.equal(archived.status, 200);
        release(); const response = await pending; assert(response); assert.equal((await response.json()).status, 'uncertain');
      }
      assert.equal((await (await fetch(app.origin + endpoint)).json()).operation.status, 'uncertain');
      assert.equal((await (await fetch(app.origin + files)).json()).length, 1); assert.equal(calls, count);
    }
  } finally { release(); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('transcription is opt-in and validates request bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-transcription-off-'));
  const app = await startApp({ database: join(dir, 'state.sqlite') });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const agent = await (await post('/api/agents', { id: randomUUID(), name: 'Off', model: 'fixture', instructions: 'Help.' })).json();
    const path = `/api/agents/${agent.id}/files/${randomUUID()}`;
    await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'audio.wav' }, body: 'RIFF0000WAVEfixture' });
    const endpoint = `${path}?transcription=1`;
    assert.equal((await (await fetch(app.origin + endpoint)).json()).provider, null);
    assert.equal((await post(endpoint, { id: randomUUID(), provider: 'none', consent: true })).status, 503);
    assert.equal((await post(endpoint, { id: randomUUID(), provider: {}, consent: true })).status, 400);
    assert.equal((await post(endpoint, [])).status, 400);
    assert.equal((await fetch(app.origin + endpoint, { method: 'DELETE', headers: { Origin: app.origin } })).status, 405);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('transcription rejects redirects and oversized output, and script grants cannot replace consent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-transcription-boundaries-'));
  let mode = 'redirect', calls = 0, redirected = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain uploaded audio. */ }
    if (req.url === '/unexpected') { redirected++; res.end('{}'); return; }
    calls++;
    if (mode === 'redirect') { res.writeHead(307, { Location: '/unexpected' }); res.end(); }
    else if (mode === 'body') res.end(JSON.stringify({ text: 'Valid text', padding: 'x'.repeat(512 * 1024) }));
    else if (mode === 'text') res.end(JSON.stringify({ text: 'x'.repeat(256 * 1024 + 1) }));
    else if (mode === 'empty') res.end(JSON.stringify({ text: ' \n ' }));
    else res.end(JSON.stringify({ text: 'Accepted final text' }));
  });
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const token = 'synthetic-token-for-transcription-tests-123456789';
  const app = await startApp({ database: join(dir, 'state.sqlite'), scriptToken: token, transcriptionProvider: { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' } });
  const post = (path: string, data: unknown) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const agent = await (await post('/api/agents', { id: randomUUID(), name: 'Bounds', model: 'fixture', instructions: 'Help.' })).json();
    assert.equal((await post(`/api/agents/${agent.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true })).status, 200);
    const thread = await (await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Bounds' })).json();
    const file = randomUUID(), files = `/api/threads/${thread.id}/files`, path = `${files}/${file}`, endpoint = `${path}?transcription=1`;
    assert.equal((await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'audio.wav' }, body: 'RIFF0000WAVEfixture' })).status, 200);
    const info = await (await fetch(app.origin + endpoint)).json();
    const script = `${app.origin}/api/scripts/agents/${agent.id}/threads/${thread.id}/files/${file}?transcription=1`;
    for (const method of ['GET', 'POST']) {
      const response = await fetch(script, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ id: randomUUID(), provider: info.provider.id, consent: true }) } : {}) });
      assert.equal(response.status, 403); assert.match((await response.json()).error, /persetujuan/);
    }
    assert.equal(calls, 0);
    let retryOf: string | undefined;
    for (mode of ['redirect', 'body', 'text', 'empty', 'valid']) {
      const request = { id: randomUUID(), provider: info.provider.id, consent: true, ...(retryOf ? { retryOf } : {}) };
      const response = await post(endpoint, request); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.status, mode === 'valid' ? 'done' : 'uncertain');
      assert.equal(redirected, 0);
      const before: number = calls;
      assert.deepEqual(await (await post(endpoint, request)).json(), result); assert.equal(calls, before);
      const listed = await (await fetch(app.origin + files)).json(); assert.equal(listed.length, mode === 'valid' ? 2 : 1);
      retryOf = request.id;
    }
    assert.equal(calls, 5);
  } finally { await app.close(); }
});
