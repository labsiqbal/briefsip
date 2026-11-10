import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicRequest, anthropicChoice, anthropicTokens, providerFamily, providerURL } from './provider.ts';
import { discoverModels } from './models.ts';
import { startApp } from './server.ts';

test('Anthropic translation preserves message roles, tools and honest usage', () => {
  const body = anthropicRequest('model', [
    { role: 'system', content: 'System' }, { role: 'system', content: 'Summary' },
    { role: 'user', content: 'Question' }, { role: 'user', content: 'Other participant' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call', function: { name: 'lookup', arguments: '{"query":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call', content: 'Result' },
  ], [{ function: { name: 'lookup', description: 'Read', parameters: { type: 'object' } } }], 2048);
  assert.equal(body.max_tokens, 2048); assert.equal(body.stream, false);
  assert.deepEqual(body.system, [{ type: 'text', text: 'System' }, { type: 'text', text: 'Summary' }]);
  assert.equal(body.messages.length, 3); assert.equal(body.messages[0].content.length, 2);
  assert.deepEqual(body.messages[1].content, [{ type: 'tool_use', id: 'call', name: 'lookup', input: { query: 'x' } }]);
  assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call', content: 'Result' }]);
  assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(anthropicTokens({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 }), [14, 4, 18]);
  assert.deepEqual(anthropicTokens({ input_tokens: 0, output_tokens: 0 }), [0, 0, 0]);
  assert.deepEqual(anthropicTokens({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: '6' }), [null, 4, null]);
  assert.deepEqual(anthropicTokens(null), [null, null, null]);
  for (const value of [false, {}, { type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] }, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: [] }] }]) assert.throws(() => anthropicChoice(value));
  assert.equal(providerFamily(undefined), 'openai-compatible'); assert.throws(() => providerFamily('typo'));
  for (const base of ['http://public.example/v1', 'https://key:secret@example.com/v1', 'https://example.com/v1?key=secret']) assert.throws(() => providerURL(base, '/messages'));
});

test('native Anthropic messages, catalog, tools, resume, cancellation and fallback use one explicit provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-anthropic-'));
  const payloads: any[] = []; let mode = 'text', catalogMode = 'ok', catalogCalls = 0;
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'fixture-anthropic'); assert.equal(req.headers['anthropic-version'], '2023-06-01'); assert.equal(req.headers.authorization, undefined);
    if (req.url?.startsWith('/v1/models')) {
      catalogCalls++;
      if (catalogMode === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(); return; }
      if (catalogMode === 'cycle') { res.end(JSON.stringify({ data: [{ id: 'same' }], has_more: true, last_id: 'same' })); return; }
      if (catalogMode === 'bad') { res.end(JSON.stringify({ data: [{ id: 'invalid\n' }], has_more: false })); return; }
      res.end(JSON.stringify(req.url.includes('after_id=first') ? { data: [{ id: 'second' }], has_more: false, last_id: 'second' } : { data: [{ id: 'first' }], has_more: true, last_id: 'first' })); return;
    }
    assert.equal(req.url, '/v1/messages');
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); payloads.push(body);
    assert.equal(body.stream, false); assert.equal(body.max_tokens, 2048); assert(Array.isArray(body.system));
    assert(body.messages.every((message: any) => ['user', 'assistant'].includes(message.role) && Array.isArray(message.content)));
    assert.equal(body.parallel_tool_calls, undefined);
    if (body.tools) { assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true }); assert(body.tools.every((tool: any) => tool.input_schema && !tool.function)); }
    const reply = (stop: string, content: unknown[]) => res.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: stop, content, usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 } }));
    const tool = (name: string, input: unknown) => reply('tool_use', [{ type: 'tool_use', id: randomUUID(), name, input }]);
    const blocks = body.messages.at(-1).content;
    if (mode === 'hold') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    if (mode === 'overloaded' && body.model !== 'backup') { res.writeHead(529); res.end('secret failure'); return; }
    if (mode === 'partial') return reply('max_tokens', [{ type: 'text', text: 'Partial answer' }]);
    if (mode === 'unknown') return reply('tool_use', [{ type: 'tool_use', id: 'bad', name: 'shell', input: { command: 'no' } }]);
    if (mode === 'multiple') return reply('tool_use', [{ type: 'tool_use', id: 'a', name: 'read_history', input: {} }, { type: 'tool_use', id: 'b', name: 'read_history', input: {} }]);
    if (mode === 'question' && !blocks.some((block: any) => block.type === 'tool_result')) return tool('ask_user', { question: 'Continue?', choices: ['Yes'] });
    if (mode === 'artifact' && !blocks.some((block: any) => block.type === 'tool_result')) return tool('create_text_file', { name: 'native.txt', text: 'Native artifact' });
    if (['delegate', 'transfer'].includes(mode) && body.model === 'primary' && !blocks.some((block: any) => block.type === 'tool_result')) {
      const name = mode === 'delegate' ? 'delegate_task' : 'transfer_task';
      return tool(name, { recipient: body.tools.find((tool: any) => tool.name === name).input_schema.properties.recipient.enum[0], task: 'Native subtask' });
    }
    if (body.system.some((block: any) => block.text.startsWith('Choose exactly one channel member'))) {
      assert.equal(body.tools, undefined);
      const input = JSON.parse(blocks.at(-1).text);
      return reply('end_turn', [{ type: 'text', text: JSON.stringify({ action: 'assign', recipient: input.members[0].id }) }]);
    }
    return reply('end_turn', [{ type: 'text', text: 'Native' }, { type: 'text', text: 'answer' }]);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), provider: 'anthropic' as const, baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-anthropic', maxTokens: 2048 };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  }
  async function until(path: string, id: string, paused = false) {
    for (let n = 0; n < 150; n++) { const row = (await request(path)).find((row: any) => row.id === id); if (row && (paused ? row.paused : ['done', 'failed', 'cancelled'].includes(row.status))) return row; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail('Task did not settle');
  }
  try {
    assert.deepEqual((await request('/api/models')).models, ['first', 'second']); assert.equal(catalogCalls, 2);
    for (catalogMode of ['bad', 'cycle', 'redirect']) await assert.rejects(discoverModels(options.baseURL, options.apiKey, 'anthropic'), /Daftar model/);
    const a = await request('/api/agents', { id: randomUUID(), name: 'Native', model: 'primary', backupModel: 'backup', instructions: 'Use native tools' });
    const path = `/api/agents/${a.id}/turns`;
    for (const scenario of ['text', 'artifact', 'partial', 'unknown', 'multiple', 'overloaded', 'redirect', 'malformed']) {
      mode = scenario; const id = randomUUID(), start = payloads.length, body = { id, text: scenario };
      await request(path, body); const row = await until(path, id);
      assert.equal(row.status, ['partial', 'unknown', 'multiple', 'redirect', 'malformed'].includes(mode) ? 'failed' : 'done', mode);
      if (row.status === 'done') assert.equal(row.reply, 'Native\nanswer');
      if (mode === 'artifact') { assert.equal(row.generatedFiles.length, 1); assert.equal(payloads.length - start, 2); const result = payloads.at(-1).messages.at(-1).content[0]; assert.equal(result.type, 'tool_result'); assert.equal(result.tool_use_id, payloads.at(-1).messages.at(-2).content[0].id); }
      if (mode === 'overloaded') assert.deepEqual(payloads.slice(start).map(body => body.model), ['primary', 'backup']);
      const count = payloads.length; await request(path, body); assert.equal(payloads.length, count);
    }
    mode = 'question'; const id = randomUUID(); await request(path, { id, text: 'Ask' }); const waiting = await until(path, id, true);
    await app.close(); app = await startApp(options);
    await request(`${path}/${id}/questions/${waiting.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' }); assert.equal((await until(path, id)).status, 'done');
    mode = 'text';
    const b = await request('/api/agents', { id: randomUUID(), name: 'Other', model: 'other', instructions: 'Help' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Route', members: [a.id, b.id], lead: a.id });
    const workflow = await request(`/api/agents/${a.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Empty output', graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output', channel: channel.id }] } });
    const emptyRun = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: '' });
    assert.equal((await request(`/api/workflow-runs/${emptyRun.id}`)).status, 'done');
    const afterEmpty = randomUUID();
    await request(`/api/channels/${channel.id}/turns`, { id: afterEmpty, recipient: a.id, text: 'Reply after empty workflow output' });
    assert.equal((await until(`/api/channels/${channel.id}/turns`, afterEmpty)).status, 'done');
    const routed = randomUUID(), channelPath = `/api/channels/${channel.id}/turns`;
    await request(channelPath, { id: routed, text: 'Route me', automatic: true }); assert.equal((await until(channelPath, routed)).status, 'done');
    for (const scenario of ['delegate', 'transfer']) {
      mode = scenario; const id = randomUUID(), start = payloads.length;
      await request(channelPath, { id, text: scenario, recipient: a.id }); const row = await until(channelPath, id);
      assert.equal(row.status, 'done');
      assert.deepEqual(payloads.slice(start).map(body => body.model), mode === 'delegate' ? ['primary', 'other', 'primary'] : ['primary', 'other']);
      assert.equal(row.coordination.length, 1);
    }
    mode = 'hold'; const cancelled = randomUUID(), start = payloads.length; await request(path, { id: cancelled, text: 'Cancel' });
    for (let n = 0; n < 100 && payloads.length === start; n++) await new Promise(resolve => setTimeout(resolve, 5));
    await request(`${path}/${cancelled}/cancel`, { id: randomUUID() }); assert.equal((await until(path, cancelled)).status, 'cancelled');
    const usage = await request('/api/usage'); assert(usage.calls.every((call: any) => call.family === 'anthropic'));
    const received = usage.calls.find((call: any) => call.status === 'received'); assert.deepEqual([received.input_tokens, received.output_tokens, received.total_tokens], [14, 4, 18]);
    assert(!JSON.stringify(usage).includes('fixture-anthropic')); assert(!JSON.stringify(usage).includes('secret failure'));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
