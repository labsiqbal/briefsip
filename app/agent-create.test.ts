import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { restoreAgentCreation } from './agent-create.ts';

test('creation recovery keeps exact command and rejects malformed authority', () => {
  const command = { id: randomUUID(), name: 'Agent baru', model: 'fixture', backupModel: '', instructions: 'Help with research', threadLimit: 2, providerAccount: '', setup: true };
  assert.deepEqual(restoreAgentCreation(JSON.stringify(command)), command); assert.equal(restoreAgentCreation(null), null);
  for (const value of [{ ...command, role: 'admin' }, { ...command, setup: 1 }, { ...command, id: 'bad' }, { ...command, threadLimit: 0 }, { ...command, instructions: '' }, { ...command, providerAccount: null }, { ...command, backupModel: 'fixture' }]) assert.throws(() => restoreAgentCreation(JSON.stringify(value)));
  assert.throws(() => restoreAgentCreation('x'.repeat(64001)));
});

test('prompt creation atomically queues one restricted setup and recovers without duplicate work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-create-'));
  let mode = 'normal', calls = 0, edits = 0, continued = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), ['ask_user', 'edit_profile']);
    const result = body.messages.findLast((message: any) => message.role === 'tool' && message.tool_call_id === 'profile');
    const system = body.messages[0].content, revision = Number(system.match(/Current profile revision: (\d+)/)[1]);
    let tool;
    if (!result && mode !== 'no-save') {
      if (mode === 'escape') tool = { id: 'escape', type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'no.txt', text: 'Forbidden' }) } };
      else if (mode === 'ask' && !JSON.stringify(body.messages).includes('Research')) tool = { id: 'question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which role?', choices: ['Research', 'Writing'] }) } };
      else { edits++; tool = { id: 'profile', type: 'function', function: { name: 'edit_profile', arguments: JSON.stringify({ revision, name: 'Research partner', ...(mode === 'name-only' ? {} : { instructions: 'Compare sources and cite evidence.' }) }) } }; }
    }
    if (result && mode === 'hold') { continued = true; return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { tool_calls: [tool] } : { content: 'Profile setup checked.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  const command = () => ({ id: randomUUID(), name: 'Agent baru', model: 'fixture', instructions: 'I need an evidence-focused assistant.', setup: true });
  async function until(id: string, status: string) { for (let n = 0; n < 300; n++) { const rows = await request(`/api/agents/${id}/turns`); if (status === 'waiting' ? rows[0]?.paused === 1 && rows[0]?.questions?.length : rows[0]?.status === status) return rows[0]; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Missing ${status}`); }
  try {
    const input = command(); await request('/api/agents', input, 201); await until(input.id, 'done'); const before = calls;
    assert.equal((await request('/api/agents', input)).name, 'Research partner'); assert.equal(calls, before); assert.equal((await request(`/api/agents/${input.id}/turns`)).length, 1); assert((await request(`/api/agents/${input.id}/turns`))[0].text.includes(input.instructions));
    await request('/api/agents', { ...input, setup: false }, 409); await request('/api/agents', { ...input, instructions: 'Different' }, 409);
    const manual = { ...command(), setup: false }; await request('/api/agents', manual, 201); assert.equal((await request(`/api/agents/${manual.id}/turns`)).length, 0);
    const malformed = { ...command(), setup: 'yes' }; await request('/api/agents', malformed, 400);
    mode = 'escape'; const escaped = command(); await request('/api/agents', escaped, 201); const failed = await until(escaped.id, 'failed'); assert.equal(failed.generatedFiles.length, 0);
    mode = 'name-only'; const partial = command(); await request('/api/agents', partial, 201); await until(partial.id, 'failed');
    mode = 'no-save'; const empty = command(); await request('/api/agents', empty, 201); await until(empty.id, 'failed');
    mode = 'ask'; const question = command(); await request('/api/agents', question, 201); const waiting = await until(question.id, 'waiting');
    await request(`/api/agents/${question.id}/turns/${question.id}/questions/${waiting.questions[0].id}/answer`, { id: randomUUID(), text: 'Research' }); await until(question.id, 'done');
    mode = 'hold'; const held = command(); await request('/api/agents', held, 201);
    for (let n = 0; n < 300 && !continued; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(continued);
    await app.close(); app = await startApp(options); const count = edits; mode = 'normal';
    const stopped = await until(held.id, 'interrupted'); await request('/api/agents', held); assert.equal(edits, count);
    await request(`/api/agents/${held.id}/turns/${held.id}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true }); await until(held.id, 'done'); assert.equal(edits, count);
    await app.close(); app = await startApp({ database: options.database });
    const offline = command(); await request('/api/agents', offline, 503); assert(!(await request('/api/agents')).agents.some((a: any) => a.id === offline.id));
    await request('/api/agents', input); // Historical receipt survives provider removal.
    await app.close(); const db = new DatabaseSync(options.database); db.exec("CREATE TRIGGER reject_setup BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'synthetic setup fault'); END"); db.close();
    app = await startApp(options); const rollback = command(); await request('/api/agents', rollback, 500); assert(!(await request('/api/agents')).agents.some((a: any) => a.id === rollback.id));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
