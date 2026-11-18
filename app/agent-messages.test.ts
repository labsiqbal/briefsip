import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('teammate messages correlate groups, isolate context, persist receipts and bound delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-messages-'));
  const calls: any[] = [], held: (() => void)[] = [];
  let targets: string[] = [], sender = '', mode = 'group', failContinuation = false;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    const tool = (name: string, args: unknown) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    const text = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
    const results = body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    let output;
    if (body.model === 'alpha' && body.messages.filter((m: any) => m.role === 'user').at(-1)?.content === 'user bypass') output = text('independent reply');
    else if (body.model === 'alpha' && !results.length) output = tool('list_agents', {});
    else if (body.model === 'alpha' && results.at(-1)?.agents) {
      assert(results.at(-1).agents.every((agent: any) => agent.id !== sender));
      assert.equal(results.at(-1).agents.find((agent: any) => agent.name === 'Beta').role, 'Personal agent');
      assert.equal(results.at(-1).agents.find((agent: any) => agent.name === 'Beta').description, 'Help.');
      output = tool('send_message', { recipients: mode === 'self' ? [sender] : mode === 'duplicate' ? [targets[0], targets[0]] : targets, text: mode === 'loop' ? 'loop' : 'shared task', expects_reply: mode !== 'notify' });
    } else if (body.model === 'alpha') {
      if (failContinuation) { failContinuation = false; res.writeHead(503); res.end(); return; }
      output = text(JSON.stringify(results.at(-1)));
    }
    else {
      if (body.messages[0].content.includes('Message from teammate')) assert(!JSON.stringify(body.messages).includes('PRIVATE_MAIN_HISTORY'));
      if (mode === 'loop') output = tool('send_message', { recipients: [sender], text: 'ack', expects_reply: true });
      else if (mode === 'channel') {
        assert(!JSON.stringify(body.messages).includes('PRIVATE_MEMORY'));
        assert(body.messages[0].content.includes('SHARED_MEMORY'));
        assert(!body.tools.some((tool: any) => ['list_routines', 'read_routine', 'set_routine_flow', 'list_skills', 'read_skill'].includes(tool.function.name)));
        if (!results.length) output = tool('search_memory', {});
        else { assert.deepEqual(results[0].items.map((row: any) => row.text), ['SHARED_MEMORY']); output = text('channel scoped'); }
      } else {
        if (['hold', 'restart', 'cancel', 'pause'].includes(mode) && body.model === 'gamma') {
          await new Promise<void>(resolve => {
            held.push(resolve);
            if (mode === 'restart') provider.emit('restart-request-held');
          });
        }
        if (mode === 'archive') await new Promise<void>(resolve => held.push(resolve));
        if (mode === 'notify') assert(!body.tools.some((tool: any) => tool.function.name === 'send_message'));
        output = text(mode === 'long' ? 'x'.repeat(20000) : `${body.model} result`);
      }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 2 };
  let app = await startApp(options);
  const post = async (path: string, data: unknown, status = 200) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const rows = async (path: string) => (await fetch(app.origin + path)).json();
  const until = async (path: string, id: string, predicate: (row: any) => boolean) => {
    for (let i = 0; i < 400; i++) { const row = (await rows(path)).find((row: any) => row.id === id); if (row && predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timeout: ${path} ${id}`);
  };
  try {
    const alpha = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Alpha', model: 'alpha', instructions: 'Coordinate.' }, 201); sender = alpha.id;
    const beta = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Beta', role: 'Personal agent', model: 'beta', instructions: 'Help.' }, 201);
    const gamma = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Gamma', role: 'Research agent', model: 'gamma', instructions: 'Help.' }, 201); targets = [beta.id, gamma.id];
    const path = `/api/agents/${alpha.id}/turns`;
    // Recipient's main history must never enter a new delivery conversation.
    const prior = { id: randomUUID(), text: 'PRIVATE_MAIN_HISTORY' };
    await post(`/api/agents/${beta.id}/turns`, prior, 202); await until(`/api/agents/${beta.id}/turns`, prior.id, row => row.status === 'done');
    mode = 'hold';
    const request = { id: randomUUID(), text: 'ask both' }; await post(path, request, 202);
    const waiting = await until(path, request.id, row => row.agentMessages?.length === 2 && row.agentMessages.some((item: any) => item.status === 'done'));
    assert.equal(waiting.status, 'queued'); assert.equal(waiting.reply, null);
    assert.equal((await rows(`/api/agents/${beta.id}/threads`)).find((thread: any) => thread.id === waiting.agentMessages.find((message: any) => message.agent === beta.id).thread).name, 'Alpha asked: shared task');
    assert.equal(calls.filter(call => call.model === 'alpha').length, 2);
    assert.equal((await rows(`/api/agents/${beta.id}/turns`)).length, 1);
    const bypass = randomUUID(); await post(path, { id: bypass, text: 'user bypass' }, 202);
    assert.equal((await until(path, bypass, row => row.status === 'done')).reply, 'independent reply');
    assert.equal((await rows(path)).find((row: any) => row.id === request.id).status, 'queued');
    while (!held.length) await new Promise(resolve => setTimeout(resolve, 10)); held.shift()!();
    const done = await until(path, request.id, row => row.status === 'done');
    const result = JSON.parse(done.reply); assert.equal(result.status, 'completed');
    assert.deepEqual(result.replies.map((r: any) => r.reply), ['gamma result']);
    assert.equal(result.delivered_earlier.length, 1);
    assert.equal(result.delivered_earlier[0].consumer, bypass);
    assert.equal((await rows(path)).find((row: any) => row.id === bypass).receivedAgentReplies[0].reply, 'beta result');
    assert.equal(done.agentMessages.length, 2);
    const before = calls.length; await post(path, request, 202); await app.close(); app = await startApp(options);
    assert.equal((await rows(path)).find((r: any) => r.id === request.id).agentMessages.length, 2); assert.equal(calls.length, before);
    for (const invalid of ['self', 'duplicate', 'loop']) {
      mode = invalid; const id = randomUUID(); await post(path, { id, text: invalid }, 202);
      const row = await until(path, id, row => ['done', 'failed'].includes(row.status));
      if (invalid === 'loop') { assert.equal(row.status, 'done'); assert(row.agentMessages.every((item: any) => item.status === 'failed')); }
      else { assert.equal(row.status, 'failed'); assert.equal(row.agentMessages.length, 0); }
    }
    mode = 'loop'; failContinuation = true;
    const retry = randomUUID(); await post(path, { id: retry, text: 'failed parent continuation' }, 202);
    const failed = await until(path, retry, row => row.status === 'failed');
    assert(failed.agentMessages.every((item: any) => item.status === 'failed' && item.settled));
    mode = 'group'; await post(`${path}/${retry}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true });
    const resumed = await until(path, retry, row => row.status === 'done');
    assert.deepEqual(resumed.agentMessages.map((item: any) => item.id), failed.agentMessages.map((item: any) => item.id));
    mode = 'notify'; const notification = randomUUID(); await post(path, { id: notification, text: 'FYI' }, 202);
    const notified = await until(path, notification, row => row.status === 'done' && row.agentMessages.every((item: any) => item.status === 'done'));
    assert.equal(JSON.parse(notified.reply).status, 'sent');
    mode = 'restart'; const restart = randomUUID();
    await Promise.all([
      once(provider, 'restart-request-held', { signal: AbortSignal.timeout(30_000) }),
      post(path, { id: restart, text: 'restart group' }, 202)
        .then(() => until(path, restart, row => row.agentMessages?.some((item: any) => item.agent === gamma.id && item.status === 'running'))),
    ]);
    const count = calls.filter(call => call.model === 'gamma').length;
    await app.close(); held.splice(0).forEach(release => release()); app = await startApp(options);
    const recovered = await until(path, restart, row => row.status === 'done');
    const interrupted = recovered.agentMessages.find((item: any) => item.agent === gamma.id);
    assert.equal(interrupted?.status, 'interrupted');
    assert.equal(calls.filter(call => call.model === 'gamma').length, count);
    const child = (await rows(`/api/threads/${interrupted.thread}/turns`))[0];
    await post(`/api/threads/${interrupted.thread}/turns/${child.id}/resume`, { id: randomUUID(), revision: child.revision, acknowledgeUncertain: true }, 409);
    mode = 'cancel'; const cancel = randomUUID(); await post(path, { id: cancel, text: 'cancel group' }, 202);
    await until(path, cancel, row => row.agentMessages?.some((item: any) => item.agent === gamma.id && item.status === 'running'));
    await post(`${path}/${cancel}/cancel`, { id: randomUUID() });
    const cancelled = await until(path, cancel, row => row.status === 'cancelled' && row.agentMessages.every((item: any) => ['done', 'cancelled'].includes(item.status)));
    assert.equal(cancelled.status, 'cancelled'); held.splice(0).forEach(release => release());
    mode = 'pause'; const pause = randomUUID(); await post(path, { id: pause, text: 'pause group' }, 202);
    const pausing = await until(path, pause, row => row.agentMessages?.some((item: any) => item.agent === gamma.id && item.status === 'running'));
    await post(`${path}/${pause}/pause`, { id: randomUUID(), revision: pausing.revision });
    held.splice(0).forEach(release => release()); await app.close(); app = await startApp({ ...options, concurrency: 1 });
    const paused = (await rows(path)).find((item: any) => item.id === pause); assert.equal(paused.paused, 1);
    assert(paused.agentMessages.some((item: any) => item.paused && !item.settled));
    mode = 'group'; await post(`${path}/${pause}/resume`, { id: randomUUID(), revision: paused.revision, acknowledgeUncertain: true });
    const unpaused = await until(path, pause, row => row.status === 'done');
    assert.deepEqual(unpaused.agentMessages.map((item: any) => item.id), paused.agentMessages.map((item: any) => item.id));
    mode = 'group'; targets = [gamma.id];
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Restricted', instructions: 'Alpha and Beta only', members: [alpha.id, beta.id], lead: alpha.id }, 201);
    const outside = randomUUID(); const channelPath = `/api/channels/${channel.id}/turns`;
    await post(channelPath, { id: outside, text: 'outside', recipient: alpha.id }, 202);
    const rejected = await until(channelPath, outside, row => row.status === 'failed');
    assert.equal(rejected.agentMessages.length, 0); assert.match(rejected.error, /Recipient/);
    const memory = (text: string) => ({ id: randomUUID(), entry: randomUUID(), revision: 0, text, essential: true, remove: false });
    await post(`/api/agents/${beta.id}/memory`, memory('PRIVATE_MEMORY'));
    await post(`/api/channels/${channel.id}/memory`, memory('SHARED_MEMORY'));
    mode = 'channel'; targets = [beta.id]; const scoped = randomUUID();
    await post(channelPath, { id: scoped, text: 'channel context', recipient: alpha.id }, 202);
    const scopedResult = await until(channelPath, scoped, row => row.status === 'done');
    assert.equal(scopedResult.agentMessages[0].reply, 'channel scoped');
    const deliveryRow = (await rows(`/api/threads/${scopedResult.agentMessages[0].thread}/turns`))[0];
    assert.equal(deliveryRow.messageOrigin.channel, channel.id);
    mode = 'long'; const long = randomUUID(); await post(path, { id: long, text: 'long result' }, 202);
    const longResult = await until(path, long, row => row.status === 'done');
    assert.equal(JSON.parse(longResult.reply).replies[0].reply.length, 16000);
    assert.equal(JSON.parse(longResult.reply).replies[0].truncated, true);
    assert.equal(longResult.agentMessages[0].reply.length, 1000);
    assert.equal(longResult.agentMessages[0].truncated, true);
    mode = 'archive'; const archive = randomUUID();
    await post(channelPath, { id: archive, text: 'archive while waiting', recipient: alpha.id }, 202);
    await until(channelPath, archive, row => row.agentMessages?.some((item: any) => item.status === 'running'));
    await post(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: channel.revision, name: channel.name, instructions: channel.instructions, members: [alpha.id, beta.id], lead: alpha.id, archived: true });
    await until(channelPath, archive, row => row.status === 'cancelled' && row.agentMessages.every((item: any) => item.status === 'cancelled'));
    held.splice(0).forEach(release => release());
  } finally {
    await app.close(); held.splice(0).forEach(release => release()); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
