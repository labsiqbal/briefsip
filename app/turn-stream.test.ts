import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './test-bridge.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializeHarness, streamSnapshot } from './harness-store.ts';
import { newestPartial, parseTurnSnapshot, type StreamPartial } from './shared/turn-stream.ts';
import { streamWork } from './src/ui/transcript.ts';

test('snapshot timer bounds writes, flushes terminal tails and isolates delivery failures', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,runtime TEXT); CREATE TABLE turns(id TEXT PRIMARY KEY);
      CREATE TABLE provider_calls(seq INTEGER PRIMARY KEY); INSERT INTO provider_calls VALUES (1),(2);
      CREATE TABLE provider_streams(call INTEGER PRIMARY KEY,text TEXT);
      CREATE TABLE writes(n INTEGER); CREATE TRIGGER inserted AFTER INSERT ON provider_streams BEGIN INSERT INTO writes VALUES (1); END;
      CREATE TRIGGER updated AFTER UPDATE ON provider_streams BEGIN INSERT INTO writes VALUES (1); END;`);
    initializeHarness(db);
    const read = (call: number) => db.prepare('SELECT text FROM provider_streams WHERE call=?').get(call)?.text;
    const count = () => Number(db.prepare('SELECT count(*) AS n FROM writes').get()!.n);
    const writer = streamSnapshot(db, 1, text => text, () => { throw new Error('Display unavailable'); });
    writer.text('A');
    for (let n = 0; n < 200; n++) writer.text('x');
    assert.equal(count(), 1); assert.equal(read(1), 'A');
    t.mock.timers.tick(39); assert.equal(count(), 1);
    t.mock.timers.tick(1); assert.equal(count(), 2); assert.equal(read(1), 'A' + 'x'.repeat(200));
    writer.tool('tool', 'Read', 'running');
    writer.text('Draft'); assert.equal(read(1), '');
    writer.finish('OK'); assert.equal(read(1), 'OK'); assert.equal(count(), 4);
    assert.deepEqual(db.prepare('SELECT ordinal,kind,text,final FROM provider_stream_segments WHERE call=1 ORDER BY ordinal').all().map(row => Object.values(row)), [[0, 'text', 'A' + 'x'.repeat(200), 0], [1, 'tool', 'Read', 0], [2, 'text', 'OK', 1]]);
    const interrupted = streamSnapshot(db, 2, text => text, () => {});
    interrupted.text('First'); interrupted.text(' buffered tail'); assert.equal(read(2), 'First');
    interrupted.finish(); assert.equal(read(2), 'First buffered tail');
    assert.equal(db.prepare('SELECT final FROM provider_stream_segments WHERE call=2').get()!.final, 0);
    const writes = count(); t.mock.timers.tick(1000); assert.equal(count(), writes);
    assert.throws(() => interrupted.text('Late'), /closed/);
  } finally { t.mock.timers.reset(); db.close(); }
});

test('snapshot merge rejects stale calls, duplicate reconnects and late polling regressions', () => {
  const partial: StreamPartial = { seq: 1, text: 'Hello', model: 'fixture', status: 'pending' };
  assert.deepEqual(newestPartial(partial, { ...partial, text: 'He' }), partial);
  assert.deepEqual(newestPartial(partial, partial), partial);
  const resumed = { ...partial, seq: 2, text: 'New' };
  assert.deepEqual(newestPartial(resumed, partial), resumed);
  const received = { ...partial, status: 'received' };
  assert.deepEqual(newestPartial(received, partial), received);
  assert.deepEqual(newestPartial(partial, received), received);
  const preTool = { ...partial, segment: 'before', revision: 2 };
  const afterTool = { ...partial, segment: 'after', text: 'OK', revision: 3 };
  assert.deepEqual(newestPartial(preTool, afterTool), afterTool);
  assert.deepEqual(newestPartial(afterTool, preTool), afterTool);
  const corrected = { ...afterTool, text: 'Y', revision: 4, final: true };
  assert.deepEqual(newestPartial(afterTool, corrected), corrected);
  assert.deepEqual(newestPartial(corrected, afterTool), corrected);
  assert.deepEqual(newestPartial(preTool, { ...afterTool, seq: 2, text: '' }), { ...afterTool, seq: 2, text: '' });
  for (const value of [null, {}, { id: randomUUID(), partial: { ...partial, text: 42 } }, { id: randomUUID(), partial: { ...partial, seq: -1 } }]) assert.equal(parseTurnSnapshot(value), null);
});

async function connectTurnStream(origin: string, path: string, signal: AbortSignal) {
  const response = await fetch(origin + path + '/stream', { headers: { Origin: origin }, signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  return async () => {
    while (true) {
      const end = pending.indexOf('\n\n');
      if (end >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      assert(!done, 'Stream ended before snapshot');
      pending += value;
    }
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('room polling retains active members beyond full history and orders prose/tool/final by attempt', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'briefsip-room-delivery-'));
  const database = join(directory, 'db.sqlite');
  const tool = gate(), draftGate = gate(), answer = gate();
  const attemptStarted = gate(), nextMemberStarted = gate();
  const streamController = new AbortController();
  t.signal.addEventListener('abort', () => {
    attemptStarted.release(); nextMemberStarted.release();
    streamController.abort(t.signal.reason);
  }, { once: true });
  let calls = 0, firstModel: string;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const end = (reason = 'stop') => { emit({}, reason); res.end('data: [DONE]\n\n'); };
    if (calls === 1 && body.messages.at(-1).content === 'Gated room') {
      firstModel = body.model;
      emit({ content: 'Before tool.' });
      await tool.promise;
      emit({ tool_calls: [{ index: 0, id: 'room-file', type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'room.txt', text: 'Once' }) } }] }); end('tool_calls'); return;
    }
    if (body.messages[0].content.includes('One verification reminder')) { emit({ content: 'Draft answer.' }); end(); return; }
    if (body.messages.at(-1).role === 'tool') {
      attemptStarted.release();
      await draftGate.promise;
      emit({ content: 'Draft' });
      await answer.promise;
      emit({ content: ' answer.' }); end(); return;
    }
    if (body.model !== firstModel) nextMemberStarted.release();
    emit({ content: 'NO_REPLY' }); end();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1`, stream: true });
  const request = async (path: string, data?: unknown) => {
    const res = await fetch(app.origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, signal: t.signal });
    if (!res.ok) assert.fail(await res.text());
    return res.json();
  };
  try {
    const agents = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of agents.entries()) await request('/api/agents', { runtime: 'api', id, name: `Member ${index}`, model: `fixture-${index}`, instructions: 'Help' });
    const channel = randomUUID(), other = randomUUID();
    for (const id of [channel, other]) await request('/api/channels', { id, name: id, members: agents, lead: null, instructions: 'Help' });
    const path = `/api/channels/${channel}/turns`, root = randomUUID();
    const next = await connectTurnStream(app.origin, path, streamController.signal);
    const waitForText = async (text: string) => {
      for (;;) {
        const snapshot = await next();
        if (snapshot.id === root && snapshot.partial?.text === text) return;
      }
    };
    await request(path, { id: root, text: 'Gated room' });
    await waitForText('Before tool.');
    let rows: any[] = await request(path);
    assert.equal(rows.length, 3); assert.equal(rows.filter(row => row.partial?.text === 'Before tool.').length, 1);
    assert.equal(calls, 1); assert.equal(rows.filter(row => row.status === 'running').length, 1); assert.equal(rows.filter(row => row.status === 'queued' && !row.partial).length, 2);
    // Fill history without admitting 35 unrelated discussions while the real room is running.
    const db = new DatabaseSync(database);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const insert = db.prepare("INSERT INTO turns(id,agent,channel,recipient,text,status,paused,created) VALUES (?,?,?,?,?,'queued',1,?)");
      for (let i = 0; i < 105; i++) {
        const agent = agents[i % agents.length];
        insert.run(randomUUID(), agent, channel, agent, `Queued ${i}`, '2026-01-01T00:00:00.000Z');
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    rows = await request(path);
    assert.equal(rows.length, 108); assert.equal(rows.filter((row: any) => row.room?.root === root).length, 3);
    assert.equal(rows.filter(row => row.history_page).length, 100);
    assert(rows.find(row => row.history_page)!.seq > rows[0].seq, 'Active rows must not become the history cursor');
    assert.equal((await request(path + '?before=' + (rows.at(-1).seq + 1))).length, 100);
    assert.deepEqual(await request(path + '?q=unrelated'), []);
    assert.deepEqual(await request(`/api/channels/${other}/turns`), []);
    const member = rows.find((row: any) => row.id === root), before = member.partial;
    const discussion = path + '?q=Gated%20room';
    tool.release();
    await attemptStarted.promise;
    rows = await request(discussion);
    const empty = rows.find((row: any) => row.id === root);
    assert(empty.partial.seq > before.seq);
    assert.equal(empty.partial.text, ''); assert.equal(empty.partial.status, 'pending'); assert.equal(empty.partial.revision, 0);
    assert.deepEqual(streamWork(empty).map(item => [item.kind, item.text]), [['text', 'Before tool.'], ['tool', 'create_text_file']]);
    draftGate.release();
    await waitForText('Draft');
    rows = await request(discussion);
    const draft = rows.find((row: any) => row.id === root), count = calls;
    assert.equal(draft.partial.text, 'Draft');
    assert.equal(draft.partial.final, false);
    assert.deepEqual((await request(discussion)).find((row: any) => row.id === root).partial, draft.partial); assert.equal(calls, count);
    answer.release();
    // A second room member starts only after the first member's result commits.
    await nextMemberStarted.promise;
    rows = await request(discussion);
    const done = rows.find((row: any) => row.id === root);
    assert.equal(done.status, 'done');
    assert.equal(done.reply, 'Draft answer.'); assert.equal(done.partial, null); assert.equal(done.generatedFiles.length, 1);
    assert.deepEqual(done.activity.stream.map((item: any) => [item.seq, item.ordinal, item.kind, item.final]), [[before.seq, 0, 'text', 0], [before.seq, 1, 'tool', 0], [draft.partial.seq, 0, 'text', 0], [done.activity.stream.at(-1).seq, 0, 'text', 1]]);
    assert.deepEqual(streamWork(done).map(item => item.text), ['Before tool.', 'create_text_file', 'Draft answer.']);
    assert.equal(done.activity.stream.at(-1).text, 'Draft answer.');
    const restored = (await request(discussion)).find((row: any) => row.id === root); assert.deepEqual(restored.activity.stream, done.activity.stream);
  } finally {
    streamController.abort();
    tool.release(); draftGate.release(); answer.release();
    await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
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
    return { controller, next: await connectTurnStream(app.origin, path, controller.signal) };
  }
  try {
    const id = randomUUID(), other = randomUUID(), thread = randomUUID(), channel = randomUUID();
    await request('/api/agents', { runtime: 'api', id, name: 'Stream', model: 'fixture', instructions: 'Help' });
    await request('/api/agents', { runtime: 'api', id: other, name: 'Other', model: 'fixture', instructions: 'Help' });
    await request(`/api/agents/${id}/threads`, { id: thread, name: 'Side thread' });
    await request('/api/channels', { id: channel, name: 'Isolated channel', instructions: 'Help', members: [id, other], lead: null });
    const path = `/api/agents/${id}/turns`, turn = randomUUID();
    const stream = await connect(path);
    await request(path, { id: turn, text: 'Stream' });
    const admitted = await stream.next(); assert.equal(admitted.partial.text, ''); assert.equal(admitted.partial.revision, 0);
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
    let last = await reconnected.next();
    while (!last.partial.final) last = await reconnected.next();
    assert.equal(last.partial.text, 'First block.\n\nSecond complete.');
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
