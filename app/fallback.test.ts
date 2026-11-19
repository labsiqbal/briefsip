import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { parseAgentTemplate, templateCommand } from './shared/agent-template.ts';

test('backup model is opt-in, bounded, durable and never replays after activity or uncertainty', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-fallback-'));
  const calls: { model: string; mode: string }[] = [];
  let mode = 'success', resumed = false;
  const timeout = new AbortController(), realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => mode === 'timeout' ? timeout.signal : realTimeout(ms));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push({ model: body.model, mode });
    const reject = (status: number) => { res.writeHead(status); res.end('private upstream detail'); };
    const text = () => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Answer from ' + body.model } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    const tool = (name: string, args: unknown) => res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
    if (mode === 'after-tool') {
      if (body.messages.at(-1).role === 'tool') return reject(503);
      return tool('create_text_file', { name: 'saved.txt', text: 'Saved once' });
    }
    if (mode === 'truncated') { res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] })); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    // Expire only the timeout scenario, after dispatch is observed.
    if (mode === 'timeout') { timeout.abort(new DOMException('Fixture deadline elapsed', 'TimeoutError')); return; }
    if (mode === 'hold') return;
    if (mode === 'forbidden') return reject(403);
    if (mode === 'double-failure') return reject(503);
    if (body.model === 'primary') return reject(mode === 'rate-limit' ? 429 : 503);
    if (mode === 'backup-hold') return;
    if (mode === 'question' && !resumed) return tool('ask_user', { question: 'Proceed?', choices: ['Yes'] });
    if (mode === 'backup-tools' && body.messages.at(-1).role !== 'tool') return tool('read_history', {});
    text();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, timeout: 2000 };
  let app = await startApp(options, { directory, servers: [provider] });
  async function request(path: string, body?: unknown, status?: number) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); if (status) assert.equal(response.status, status, JSON.stringify(result)); else assert(response.ok, JSON.stringify(result)); return result;
  }
  async function until(path: string, id: string, paused = false) {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      const row = (await request(path)).find((row: any) => row.id === id);
      if (row && (paused ? row.paused : ['done', 'failed', 'cancelled'].includes(row.status))) return row;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Task ${id} did not settle within 30s`);
  }
  try {
    const create = { id: randomUUID(), name: 'Fallback', model: 'primary', backupModel: 'backup', instructions: 'Test' };
    let agent = await request('/api/agents', { ...create, runtime: 'api' });
    assert.equal(agent.backup_model, 'backup'); assert.equal((await request('/api/agents', { ...create, runtime: 'api' })).id, agent.id);
    await request('/api/agents', { runtime: 'api', ...create, backupModel: 'other' }, 409);
    for (const backupModel of [null, 1, 'primary', ' primary ', 'x'.repeat(161), 'bad\nmodel']) await request('/api/agents', { runtime: 'api', ...create, id: randomUUID(), backupModel }, 400);
    const path = `/api/agents/${agent.id}/turns`;
    for (const scenario of ['success', 'rate-limit', 'backup-tools', 'double-failure', 'forbidden', 'truncated', 'malformed', 'disconnect', 'timeout', 'after-tool']) {
      mode = scenario; const start = calls.length, id = randomUUID(), body = { id, text: scenario };
      await request(path, body); const row = await until(path, id);
      const expected = ['success', 'rate-limit', 'backup-tools'].includes(mode) ? 'done' : 'failed';
      assert.equal(row.status, expected, mode);
      const models = calls.slice(start).map(call => call.model);
      assert.deepEqual(models, mode === 'backup-tools' ? ['primary', 'backup', 'backup'] : ['success', 'rate-limit', 'double-failure'].includes(mode) ? ['primary', 'backup'] : mode === 'after-tool' ? ['primary', 'primary'] : ['primary'], mode);
      if (expected === 'done') assert.equal(row.answer_model, 'backup');
      if (mode === 'after-tool') assert.equal(row.generatedFiles.length, 1);
      await request(path, body); assert.equal(calls.length, start + models.length);
      const usage = (await request('/api/usage')).calls.filter((call: any) => call.turn === id);
      assert.equal(usage.length, models.length); assert(!JSON.stringify(usage).includes('private upstream detail'));
    }
    mode = 'question'; const waiting = randomUUID(); await request(path, { id: waiting, text: 'Ask then restart' });
    const question = await until(path, waiting, true); assert.equal(question.answer_model, 'backup');
    await app.close(); app = await startApp(options); resumed = true;
    assert.equal((await request('/api/agents')).agents.find((a: any) => a.id === agent.id).backup_model, 'backup');
    const start = calls.length;
    await request(`${path}/${waiting}/questions/${question.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
    assert.equal((await until(path, waiting)).answer_model, 'backup'); assert.deepEqual(calls.slice(start).map(call => call.model), ['backup']);
    mode = 'success';
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Test', members: [agent.id], lead: agent.id });
    const thread = await request(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' });
    for (const scope of [`/api/channels/${channel.id}/turns`, `/api/threads/${thread.id}/turns`]) {
      const id = randomUUID(), start = calls.length;
      await request(scope, { id, text: 'Scoped fallback', ...(scope.includes('channels') ? { recipient: agent.id } : {}) });
      assert.equal((await until(scope, id)).answer_model, 'backup');
      assert.deepEqual(calls.slice(start).map(call => call.model), ['primary', 'backup']);
      assert(!(await request(path)).some((row: any) => row.id === id));
    }
    const graph = { entry: 'choose', maxSteps: 4, nodes: [{ id: 'choose', kind: 'condition', operator: 'model', model: 'primary', value: 'Accept?', yes: 'end', no: 'end' }, { id: 'end', kind: 'output' }] };
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Explicit model', graph });
    const wfStart = calls.length;
    const run = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Test' });
    let current: any;
    const workflowDeadline = performance.now() + 30000;
    while (performance.now() < workflowDeadline) { current = await request(`/api/workflow-runs/${run.id}`); if (current.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(current.status, 'failed'); assert.deepEqual(calls.slice(wfStart).map(call => call.model), ['primary']);
    mode = 'hold'; const cancelled = randomUUID(), cancelStart = calls.length;
    await request(path, { id: cancelled, text: 'Cancel active' });
    const dispatchDeadline = performance.now() + 30000;
    while (performance.now() < dispatchDeadline && calls.length === cancelStart) await new Promise(resolve => setTimeout(resolve, 25));
    await request(`${path}/${cancelled}/cancel`, { id: randomUUID() });
    assert.equal((await until(path, cancelled)).status, 'cancelled'); assert.equal(calls.length, cancelStart + 1);
    mode = 'disconnect'; const uncertain = randomUUID(); await request(path, { id: uncertain, text: 'Uncertain' });
    await until(path, uncertain); await app.close(); app = await startApp(options);
    mode = 'success'; const retryStart = calls.length, failed = (await request(path)).find((row: any) => row.id === uncertain);
    await request(`${path}/${uncertain}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true });
    assert.equal((await until(path, uncertain)).status, 'failed'); assert.deepEqual(calls.slice(retryStart).map(call => call.model), ['primary']);
    mode = 'backup-hold'; const held = randomUUID(), heldStart = calls.length;
    await request(path, { id: held, text: 'Restart during backup' });
    const backupDeadline = performance.now() + 30000;
    while (performance.now() < backupDeadline && calls.length < heldStart + 2) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(calls.slice(heldStart).map(call => call.model), ['primary', 'backup']);
    await app.close(); app = await startApp(options); mode = 'success';
    const stopped = (await request(path)).find((row: any) => row.id === held), heldResume = calls.length;
    assert(['interrupted', 'failed'].includes(stopped.status));
    await request(`${path}/${held}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true });
    assert.equal((await until(path, held)).answer_model, 'backup'); assert.deepEqual(calls.slice(heldResume).map(call => call.model), ['backup']);
    const exported = await request(`/api/agents/${agent.id}/template`);
    assert.equal(parseAgentTemplate(exported).backupModel, 'backup');
    const imported = await request('/api/agents', { ...templateCommand(exported, randomUUID()), runtime: 'api' }); assert.equal(imported.backup_model, 'backup');
    assert.throws(() => parseAgentTemplate({ ...exported, backupModel: 'primary' }));
    const edit = { id: randomUUID(), revision: agent.revision, name: agent.name, model: agent.model, instructions: agent.instructions, backupModel: '' };
    agent = await request(`/api/agents/${agent.id}/edit`, edit); assert.equal(agent.backup_model, '');
    assert.deepEqual(await request(`/api/agents/${agent.id}/edit`, edit), agent);
    mode = 'success'; const disabled = randomUUID(), before = calls.length;
    await request(path, { id: disabled, text: 'No fallback' }); assert.equal((await until(path, disabled)).status, 'failed'); assert.equal(calls.length, before + 1);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
