import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './server.ts';
import { newestPartial, parseTurnSnapshot, type StreamPartial } from './turn-stream.ts';

test('snapshot merge rejects stale calls, duplicate reconnects and late polling regressions', () => {
  const partial: StreamPartial = { seq: 1, text: 'Hello', model: 'fixture', status: 'pending' };
  assert.deepEqual(newestPartial(partial, { ...partial, text: 'He' }), partial);
  assert.deepEqual(newestPartial(partial, partial), partial);
  const resumed = { ...partial, seq: 2, text: 'New' };
  assert.deepEqual(newestPartial(resumed, partial), resumed);
  const received = { ...partial, status: 'received' };
  assert.deepEqual(newestPartial(received, partial), received);
  assert.deepEqual(newestPartial(partial, received), received);
  for (const value of [null, {}, { id: randomUUID(), partial: { ...partial, text: 42 } }, { id: randomUUID(), partial: { ...partial, seq: -1 } }]) assert.equal(parseTurnSnapshot(value), null);
});

test('SSE delivers ordered persisted snapshots; reconnect repairs missed text without provider replay', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'briefsip-turn-stream-'));
  let calls = 0, release: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* consume fixture request */ }
    calls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = (value: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: value }, finish_reason: null }] })}\n\n`);
    text('First block.\n\n');
    await delay(100); text('Second');
    await new Promise<void>(resolve => { release = resolve; });
    text(' complete.');
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ timeout: 3000, database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, stream: true });
  let closed = false;
  const controllers: AbortController[] = [];
  const request = async (path: string, data?: unknown) => {
    const res = await fetch(app.origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    assert(res.ok, await res.clone().text()); return res.json();
  };
  async function connect(path: string) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(app.origin + path + '/stream', { headers: { Origin: app.origin }, signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader(); let pending = '';
    return { controller, next: async () => {
      while (true) {
        const end = pending.indexOf('\n\n');
        if (end >= 0) { const frame = pending.slice(0, end); pending = pending.slice(end + 2); if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)); continue; }
        const { value, done } = await reader.read(); assert(!done, 'Stream ended before snapshot'); pending += value;
      }
    } };
  }
  try {
    const id = randomUUID(), other = randomUUID(), thread = randomUUID(), channel = randomUUID();
    await request('/api/agents', { id, name: 'Stream', model: 'fixture', instructions: 'Help' });
    await request('/api/agents', { id: other, name: 'Other', model: 'fixture', instructions: 'Help' });
    await request(`/api/agents/${id}/threads`, { id: thread, name: 'Side thread' });
    await request('/api/channels', { id: channel, name: 'Isolated channel', instructions: 'Help', members: [id, other], lead: null });
    const path = `/api/agents/${id}/turns`, turn = randomUUID();
    const stream = await connect(path);
    await request(path, { id: turn, text: 'Stream' });
    const first = await stream.next();
    const second = await stream.next();
    assert.equal(first.id, turn); assert.equal(first.partial.text, 'First block.\n\n');
    assert.equal(second.partial.seq, first.partial.seq); assert.equal(second.partial.text, 'First block.\n\nSecond');
    stream.controller.abort();
    const reconnected = await connect(path), snapshot = await reconnected.next();
    assert.deepEqual(snapshot, second);
    for (const scope of [`/api/agents/${other}/turns`, `/api/threads/${thread}/turns`, `/api/channels/${channel}/turns`]) {
      const isolated = await connect(scope);
      const outcome = await Promise.race([isolated.next(), delay(80).then(() => 'empty')]);
      assert.equal(outcome, 'empty'); isolated.controller.abort();
    }
    for (const [suffix, headers, status] of [['?q=x', {}, 400], ['', { Origin: 'https://foreign.example' }, 403], ['', { Authorization: 'Bearer fixture' }, 403]] as const) {
      const result = await fetch(app.origin + path + '/stream' + suffix, { headers }); assert.equal(result.status, status);
    }
    assert.equal((await fetch(app.origin + path + '/stream', { method: 'POST', headers: { Origin: app.origin } })).status, 405);
    release!();
    const last = await reconnected.next(); assert.equal(last.partial.text, 'First block.\n\nSecond complete.');
    let final;
    for (let n = 0; n < 100; n++) { final = (await request(path))[0]; if (final.status === 'done') break; await delay(10); }
    assert.equal(final.status, 'done'); assert.equal(last.partial.text, final.reply); assert.equal(calls, 1);
    await app.close(); closed = true;
  } finally {
    release?.(); for (const controller of controllers) controller.abort();
    if (!closed) await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
