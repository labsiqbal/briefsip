import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { testDatabase } from './test-support/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';

test('agent history tools retrieve old originals and reject foreign conversations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-history-tools-'));
  let foreignId = '', oldestId = '', attachmentId = '', before = 1, mode = 'read';
  const results: any[] = [];
  const providerPhases: string[] = [];
  let duringRead: (() => Promise<unknown>) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    providerPhases.push(data.messages[0].content.startsWith('Summarize conversation history') ? 'compaction' : 'answer');
    if (data.messages[0].content.startsWith('Summarize conversation history')) return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Earlier details remain available through history tools.' } }] }));
    if (data.messages.at(-1).content?.startsWith('Future disclosure')) return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Saved.' } }] }));
    if (duringRead) { const action = duringRead; duringRead = undefined; await action(); }
    const reads = data.messages.filter((m: { role: string }) => m.role === 'tool');
    assert(data.tools.some((t: { function: { name: string } }) => t.function.name === 'read_history'));
    if (!reads.length) assert(!JSON.stringify(data.messages).includes('OLD_ORIGINAL_MARKER'));
    if (reads.length) results.push(JSON.parse(reads.at(-1).content));
    const steps = mode === 'read' ? [
      { name: 'read_history', args: { before } },
      { name: 'read_message', args: { id: oldestId } },
      { name: 'read_message', args: { id: oldestId, offset: 8000 } },
    ] : mode === 'attachment' ? [{ name: 'read_attachment', args: { id: attachmentId } }, { name: 'read_attachment', args: { id: attachmentId, offset: 8000 } }]
      : mode === 'denied-attachment' ? [{ name: 'read_attachment', args: { id: attachmentId } }] : mode === 'foreign' ? [{ name: 'read_message', args: { id: foreignId } }]
      : mode === 'invalid' ? [{ name: 'read_history', args: { before: -1 } }]
      : Array.from({ length: 9 }, () => ({ name: 'read_history', args: {} }));
    const step = steps[reads.length];
    res.end(JSON.stringify({ choices: [{ finish_reason: step ? 'tool_calls' : 'stop', message: step
      ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
      : { content: 'Read complete.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  const networkErrors: {name: string; code: string | null}[] = [];
  const captureError = (value: unknown) => {
    const event = value as {request?: {origin?: string}; error?: {name?: string; code?: string}};
    if (String(event.request?.origin) === `http://127.0.0.1:${address.port}`) networkErrors.push({name: event.error?.name ?? 'unknown', code: event.error?.code ?? null});
  };
  subscribe('undici:request:error', captureError);
  let app = await startApp(options, { directory: dir, servers: [provider] }).catch(error => {
    unsubscribe('undici:request:error', captureError);
    throw error;
  });
  async function post(path: string, data: unknown) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert(response.ok, await response.clone().text()); return response.json();
  }
  async function run(path: string, expected: string) {
    const id = randomUUID(); results.length = 0; networkErrors.length = 0; providerPhases.length = 0; await post(path, { id, text: 'Retrieve earlier evidence' });
    for (let n = 0; n < 150; n++) {
      const rows = await (await fetch(app.origin + path)).json();
      const turn = rows.find((row: { id: string }) => row.id === id);
      if (['done', 'failed'].includes(turn.status)) {
        if (turn.status !== expected) {
          assert.fail(JSON.stringify({expected, actual: turn.status, error: turn.error, mode, providerPhases, networkErrors}));
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Tool run did not settle');
  }
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Reader', model: 'fixture', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help.', lead: agent.id, members: [agent.id] });
    const a = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'A' });
    const b = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'B' });
    const scopes = [{ path: `/api/agents/${agent.id}/turns`, channel: null, thread: null }, { path: `/api/channels/${channel.id}/turns`, channel: channel.id, thread: null }, { path: `/api/threads/${a.id}/turns`, channel: null, thread: a.id }, { path: `/api/threads/${b.id}/turns`, channel: null, thread: b.id }];
    const files: string[] = [];
    for (const scope of scopes) {
      const id = randomUUID(); files.push(id);
      const response = await fetch(app.origin + scope.path.replace('/turns', `/files/${id}`), { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'old.txt' }, body: 'f'.repeat(9000) + 'OLD_ATTACHMENT_MARKER' });
      assert.equal(response.status, 200);
    }
    const unsentId = randomUUID();
    const unsent = await fetch(app.origin + scopes[0].path.replace('/turns', `/files/${unsentId}`), { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'unsent.txt' }, body: 'UNSENT_PRIVATE' });
    assert.equal(unsent.status, 200);
    await app.close();
    const db = testDatabase(options.database);
    const insert = db.prepare("INSERT INTO turns(id,agent,channel,thread,text,reply,status,created) VALUES (?,?,?,?,?,?,'done',?)");
    const originals: { id: string; seq: number }[] = [];
    for (const scope of scopes) {
      const id = randomUUID();
      const result = insert.run(id, agent.id, scope.channel, scope.thread, 'x'.repeat(12000) + 'OLD_ORIGINAL_MARKER', 'Saved original reply', new Date().toISOString());
      db.prepare('UPDATE turns SET attachments=? WHERE id=?').run(JSON.stringify([files[originals.length]]), id);
      originals.push({ id, seq: Number(result.lastInsertRowid) });
      for (let n = 0; n < 42; n++) insert.run(randomUUID(), agent.id, scope.channel, scope.thread, `Recent ${n}`, 'Recent reply', new Date().toISOString());
    }
    db.close(); app = await startApp(options);
    for (let n = 0; n < scopes.length; n++) {
      oldestId = originals[n].id; before = originals[n].seq + 1; mode = 'read';
      await run(scopes[n].path, 'done');
      assert.equal(results[0].messages[0].id, oldestId); assert.equal(results[0].messages[0].truncated, true);
      assert.equal(results[1].text.length, 8000); assert.equal(results[1].next_offset, 8000);
      assert.equal(results[2].text, 'x'.repeat(4000) + 'OLD_ORIGINAL_MARKER'); assert.equal(results[2].next_offset, null);
      mode = 'attachment'; attachmentId = files[n];
      await run(scopes[n].path, 'done'); assert.equal(results[0].text.length, 8000); assert.equal(results[0].next_offset, 8000);
      assert.equal(results[1].text, 'f'.repeat(1000) + 'OLD_ATTACHMENT_MARKER'); assert.equal(results[1].next_offset, null);
      mode = 'denied-attachment'; attachmentId = files[(n + 1) % scopes.length];
      await run(scopes[n].path, 'done'); assert.match(results[0].error, /not found/);
      mode = 'foreign'; foreignId = originals[(n + 1) % scopes.length].id;
      await run(scopes[n].path, 'done'); assert.match(results[0].error, /not found/);
    }
    mode = 'denied-attachment'; attachmentId = unsentId;
    await run(scopes[0].path, 'done'); assert.match(results[0].error, /not found/);
    duringRead = () => post(scopes[0].path, { id: randomUUID(), text: 'Future disclosure', files: [unsentId] });
    await run(scopes[0].path, 'done'); assert.match(results[0].error, /not found/);
    mode = 'invalid'; await run(scopes[0].path, 'done'); assert.deepEqual(results, [{ error: 'Invalid history position.', status: 400 }]);
    mode = 'loop'; await run(scopes[0].path, 'done'); assert.equal(results.length, 9);
  } finally { unsubscribe('undici:request:error', captureError); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
