import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { startApp } from './test-bridge.ts';
import type { ProviderFamily } from './test-support/provider-endpoint.ts';

const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3 } } };
const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const blockStop = { type: 'content_block_stop', index: 0 };
const messageDelta = (stop_reason = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 4 } });
const messageStop = { type: 'message_stop' };
test('Rust rejects invalid provider stream termination settings', async () => {
  await assert.rejects(startApp({ database: ':memory:', streamTermination: 'unknown' }), /stream termination|MINARBOT_STREAM_TERMINATION/i);
  await assert.rejects(startApp({ database: ':memory:', provider: 'anthropic', streamTermination: 'finish-reason' }), /only supported/);
});

for (const family of ['openai-compatible', 'anthropic'] as ProviderFamily[]) test(`${family} streaming persists partial text, gates tools, cancels and resumes without replay`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-stream-'));
  let mode = 'text', calls = 0, wrongTypeClosed = false, release: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls++; assert.equal(body.stream, true);
    if (family === 'openai-compatible') assert.deepEqual(body.stream_options, { include_usage: true });
    if (family === 'openai-compatible' && body.messages.some((message: any) => message.tool_calls?.some((call: any) => call.extra_content?.google?.thought_signature !== 'stream-signature'))) { res.writeHead(400); res.end('Missing streamed signature'); return; }
    if (mode === 'wrong-type') { res.on('close', () => { wrongTypeClosed = true; }); res.setHeader('Content-Type', 'application/json'); res.write('{}'); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    const send = (value: unknown) => res.write(sse(value));
    const finish = () => { if (family === 'anthropic') { send(blockStop); send(messageDelta()); send(messageStop); } else { send(chunk({}, 'stop')); send({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }); send('[DONE]'); } res.end(); };
    const last = body.messages.at(-1), toolResult = family === 'anthropic' ? last.content.some((block: any) => block.type === 'tool_result') : last.role === 'tool';
    if (family === 'anthropic') send(start);
    if (['tool', 'tool-hold', 'broken-tool'].includes(mode) && !toolResult) {
      const id = 'stream-tool', args = JSON.stringify({ name: 'stream.txt', text: 'Exactly once' });
      if (family === 'anthropic') {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'create_text_file', input: {} } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, 10) } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(10) } });
        send(blockStop); send(messageDelta('tool_use')); if (mode !== 'broken-tool') send(messageStop);
      } else {
        send(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'create_text_file', arguments: args.slice(0, 10) } }] }));
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] })); send(chunk({ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'stream-signature' } } }] })); send(chunk({}, 'tool_calls')); if (mode !== 'broken-tool') send('[DONE]');
      }
      res.end(); return;
    }
    if (family === 'anthropic') { send(blockStart); send(textDelta('Partial ')); } else send(chunk({ content: 'Partial ' }));
    if (mode === 'hold' || mode === 'tool-hold') { release = finish; return; }
    if (mode === 'broken') { res.end(); return; }
    if (family === 'anthropic') send(textDelta('complete')); else send(chunk({ content: 'complete' }));
    finish();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), provider: family, stream: true, baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory, servers: [provider] });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  }
  async function until(path: string, id: string, predicate = (row: any) => ['done', 'failed', 'cancelled'].includes(row.status)) {
    for (let n = 0; n < 150; n++) { const row = (await request(path)).find((row: any) => row.id === id); if (row && predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail('Task did not settle');
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Stream', model: 'primary', backupModel: 'backup', instructions: 'Help' }), path = `/api/agents/${agent.id}/turns`;
    for (const scenario of ['text', 'broken', 'tool', 'broken-tool', 'wrong-type']) {
      mode = scenario; const id = randomUUID(), before = calls;
      await request(path, { id, text: scenario }); const row = await until(path, id);
      assert.equal(row.status, ['text', 'tool'].includes(mode) ? 'done' : 'failed', mode);
      assert.equal(calls - before, mode === 'tool' ? 3 : 1, mode);
      assert.equal(row.generatedFiles.length, mode === 'tool' ? 1 : 0);
      if (mode === 'broken') { assert.equal(row.reply, null); assert.equal(row.partial.text, 'Partial '); }
      if (row.status === 'done') assert.equal(row.reply, 'Partial complete');
      const usage = (await request('/api/usage')).calls.find((call: any) => call.turn === id);
      if (mode === 'text') assert.equal(usage.total_tokens, 9);
      if (mode === 'broken') assert.equal(usage.total_tokens, null);
      if (mode === 'wrong-type') {
        for (let n = 0; n < 50 && !wrongTypeClosed; n++) await new Promise(resolve => setTimeout(resolve, 5));
        assert(wrongTypeClosed, 'Rejected MIME must cancel upstream body');
      }
    }
    mode = 'tool-hold'; const signed = randomUUID(); await request(path, { id: signed, text: 'Resume signed tool' });
    const signedLive = await until(path, signed, row => row.generatedFiles.length === 1 && !!row.partial?.text);
    await app.close(); app = await startApp(options); mode = 'text';
    const signedRestored = (await request(path)).find((row: any) => row.id === signed), signedCalls = calls;
    await request(`${path}/${signed}/resume`, { id: randomUUID(), revision: signedRestored.revision, acknowledgeUncertain: true });
    const signedDone = await until(path, signed); assert.equal(signedDone.status, 'done'); assert.deepEqual(signedDone.generatedFiles, signedLive.generatedFiles); assert.equal(calls - signedCalls, 2);
    mode = 'hold'; const cancelled = randomUUID(); await request(path, { id: cancelled, text: 'Cancel stream' });
    await until(path, cancelled, row => !!row.partial?.text); await request(`${path}/${cancelled}/cancel`, { id: randomUUID() });
    const cancelledRow = await until(path, cancelled); assert.equal(cancelledRow.status, 'cancelled'); assert.equal(cancelledRow.partial.text, 'Partial ');
    const interrupted = randomUUID(); release = undefined; await request(path, { id: interrupted, text: 'Restart stream' });
    await until(path, interrupted, row => !!row.partial?.text);
    await app.close(); app = await startApp(options);
    const restored = (await request(path)).find((row: any) => row.id === interrupted); assert.equal(restored.partial.text, 'Partial '); assert(['failed', 'interrupted'].includes(restored.status));
    mode = 'text'; const before = calls;
    await request(`${path}/${interrupted}/resume`, { id: randomUUID(), revision: restored.revision, acknowledgeUncertain: true });
    assert.equal((await until(path, interrupted)).reply, 'Partial complete'); assert.equal(calls - before, 1);
    const completed = randomUUID(); mode = 'hold'; release = undefined;
    await request(path, { id: completed, text: 'Visible while streaming' }); const live = await until(path, completed, row => !!row.partial?.text);
    assert.equal(live.status, 'running'); assert.equal(live.reply, null); release!(); assert.equal((await until(path, completed)).reply, 'Partial ');
    if (family === 'openai-compatible') {
      await app.close(); app = await startApp({ ...options, streamTermination: 'finish-reason' });
      mode = 'broken-tool'; const compatible = randomUUID(), before = calls;
      await request(path, { id: compatible, text: 'Tool with finish-reason EOF' }); const result = await until(path, compatible);
      assert.equal(result.status, 'done'); assert.equal(result.generatedFiles.length, 1); assert.equal(calls - before, 3);
    }
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL preserves committed stream text without automatic provider replay', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-stream-crash-')); let calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _part of req) { /* Wait for complete request. */ }
    calls++; res.setHeader('Content-Type', 'text/event-stream'); res.write(sse(chunk({ content: 'Survives crash' })));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), stream: true, baseURL: `http://127.0.0.1:${address.port}/v1` };
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {startApp} from ${JSON.stringify(new URL('./test-bridge.ts', import.meta.url).href)};const app=await startApp(JSON.parse(process.env.MINARBOT_TEST_OPTIONS));console.log(app.origin);`], { env: { ...process.env, MINARBOT_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'), output = createInterface({ input: child.stdout }); child.stderr.resume();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    let [origin] = await Promise.race([once(output, 'line'), exited.then(() => { throw new Error('Child exited before startup'); })]);
    async function request(path: string, body?: unknown) {
      const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const result = await response.json(); assert(response.ok); return result;
    }
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Crash', model: 'fixture', instructions: 'Test' }), path = `/api/agents/${agent.id}/turns`, id = randomUUID();
    await request(path, { id, text: 'Crash' }); let observed = false;
    for (let n = 0; n < 100; n++) { if ((await request(path))[0]?.partial?.text === 'Survives crash') { observed = true; break; } await new Promise(resolve => setTimeout(resolve, 15)); }
    assert(observed); child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    app = await startApp(options); origin = app.origin;
    const row = (await request(path))[0]; assert.equal(row.status, 'interrupted'); assert.equal(row.partial.text, 'Survives crash'); assert.equal(row.partial.status, 'interrupted');
    await request(path, { id, text: 'Crash' });
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, 1);
    const usage = await request('/api/usage'); assert.equal(usage.calls[0].status, 'interrupted'); assert.equal(usage.calls[0].total_tokens, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    output.close(); await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});
