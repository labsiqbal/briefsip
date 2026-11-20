import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { testDatabase } from './test-support/database.ts';

test('caller interruption cancels only owned deliveries, journals notice and preserves other work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-interrupt-'));
  const captures: any[] = [], releases: (() => void)[] = [];
  let recipient = '', callerId = '', nestedRecipient = '', hold = true, failInterruptReply = true, injectFailure = false;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); captures.push(body);
    const prompt = body.messages.filter((m: any) => m.role === 'user').at(-1).content;
    const results = body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    const tool = (name: string, args: unknown) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    const text = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
    let answer;
    if (body.model === 'gamma' && prompt === 'NESTED_CHILD') {
      if (hold) await new Promise<void>(resolve => releases.push(resolve)); answer = text('Nested result');
    } else if (body.model === 'beta') {
      if (prompt === 'NESTED_TASK' && !results.length) answer = tool('send_message', { recipients: [nestedRecipient], text: 'NESTED_CHILD', expects_reply: true });
      else if (prompt === 'ANCESTOR_TASK') answer = tool('interrupt_agent', { recipient: callerId, reason: 'Cannot stop requester' });
      else if (prompt.startsWith('The work I asked for')) {
        assert(!body.tools.some((t: any) => ['send_message', 'interrupt_agent'].includes(t.function.name)));
        answer = text('Notice recorded');
      } else { if (hold) await new Promise<void>(resolve => releases.push(resolve)); answer = text('Work finished'); }
    } else if (!results.length && prompt === 'inspect') answer = tool('list_agents', {});
    else if (!results.length && prompt === 'stop') answer = tool('interrupt_agent', { recipient, reason: injectFailure ? 'fixture failure check' : 'User changed priorities' });
    else if (!results.length && prompt === 'self') answer = tool('interrupt_agent', { recipient: callerId, reason: 'Invalid target' });
    else if (!results.length) answer = tool('send_message', { recipients: [recipient], text: prompt, expects_reply: true });
    else if (results.at(-1).status === 'interrupted' && failInterruptReply) { failInterruptReply = false; res.writeHead(503); res.end(); return; }
    else answer = text(JSON.stringify(results.at(-1)));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 4 };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  await app.close();
  const setup = testDatabase(options.database);
  setup.exec("CREATE TRIGGER reject_interrupt_notice BEFORE INSERT ON turns WHEN NEW.text LIKE 'The work I asked for%fixture failure check%' BEGIN SELECT RAISE(ABORT,'fixture notice failure'); END");
  setup.close(); app = await startApp(options, { directory: dir, servers: [provider] });
  const post = async (path: string, data: unknown, expected = 200) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const get = async (path: string) => (await fetch(app.origin + path)).json();
  const until = async (path: string, id: string, predicate: (row: any) => boolean) => {
    for (let i = 0; i < 400; i++) { const row = (await get(path)).find((r: any) => r.id === id); if (row && predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timed out: ${id}`);
  };
  const send = async (path: string, text: string, extra = {}) => { const id = randomUUID(); await post(path, { id, text, ...extra }, 202); return id; };
  try {
    const alpha = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Alpha', model: 'alpha', instructions: 'Coordinate' }, 201);
    callerId = alpha.id;
    const beta = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Beta', model: 'beta', instructions: 'Work', threadLimit: 1 }, 201); recipient = beta.id;
    const gamma = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Gamma', model: 'gamma', instructions: 'Coordinate' }, 201);
    nestedRecipient = gamma.id;
    const a = `/api/agents/${alpha.id}/turns`, b = `/api/agents/${beta.id}/turns`, g = `/api/agents/${gamma.id}/turns`;
    const user = await send(b, 'USER_TASK'); await until(b, user, r => r.status === 'running');
    const first = await send(a, 'FIRST_OWN'); await until(a, first, r => r.agentMessages.some((m: any) => m.status === 'running'));
    const second = await send(a, 'SECOND_OWN'); await until(a, second, r => r.agentMessages.some((m: any) => m.status === 'queued'));
    const foreign = await send(g, 'FOREIGN_TASK'); await until(g, foreign, r => r.agentMessages.length === 1);
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Shared', instructions: 'Shared work', members: [alpha.id, beta.id], lead: alpha.id }, 201);
    const c = `/api/channels/${channel.id}/turns`;
    const channelTask = await send(c, 'CHANNEL_TASK', { recipient: alpha.id }); await until(c, channelTask, r => r.agentMessages.length === 1);
    const inspect = await send(a, 'inspect'); const inspected = await until(a, inspect, r => r.status === 'done');
    const listed = JSON.parse(inspected.reply).agents.find((agent: any) => agent.id === beta.id);
    assert.equal(listed.status, 'working'); assert.equal(listed.queuedMessages, 2);
    const stop = await send(a, 'stop'); const failed = await until(a, stop, r => r.status === 'failed');
    assert.equal(failed.agentMessages.length, 1);
    const noticeId = failed.agentMessages[0].id;
    const firstDone = await until(a, first, r => r.status === 'done'); const secondDone = await until(a, second, r => r.status === 'done');
    assert.equal(firstDone.agentMessages[0].status, 'cancelled'); assert.equal(secondDone.agentMessages[0].status, 'cancelled');
    assert.equal((await get(b)).find((r: any) => r.id === user).status, 'running');
    assert(['queued', 'running'].includes((await get(g)).find((r: any) => r.id === foreign).agentMessages[0].status));
    assert.equal((await get(c)).find((r: any) => r.id === channelTask).agentMessages[0].status, 'queued');
    assert.equal(captures.filter(body => body.model === 'beta' && body.messages.filter((m: any) => m.role === 'user').at(-1).content === 'SECOND_OWN').length, 0);
    await post(a, { id: stop, text: 'stop' }, 202);
    hold = false; releases.splice(0).forEach(release => release());
    await until(g, foreign, r => r.status === 'done'); await until(c, channelTask, r => r.status === 'done');
    await until(a, stop, r => r.agentMessages.every((m: any) => m.status === 'done'));
    await app.close(); app = await startApp(options);
    await post(`${a}/${stop}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true });
    const retried = await until(a, stop, r => r.status === 'done');
    assert.equal(retried.agentMessages[0].id, noticeId);
    const receipt = JSON.parse(retried.reply); assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.cancelled.length, 2);
    assert.equal(captures.filter(body => body.model === 'beta' && body.messages.filter((m: any) => m.role === 'user').at(-1).content.startsWith('The work I asked for')).length, 1);
    assert.equal((await get(b)).find((r: any) => r.id === user).status, 'done');
    const noOwn = await send(a, 'stop'); assert.match((await until(a, noOwn, r => r.status === 'failed')).error, /no active work/);
    const self = await send(a, 'self'); assert.match((await until(a, self, r => r.status === 'failed')).error, /You can only stop/);
    const forbidden = await send(c, 'stop', { recipient: alpha.id });
    await until(c, forbidden, r => r.status === 'failed');
    const channelCall = captures.find(body => body.model === 'alpha' && body.messages[0].content.includes('Shared') && body.messages.filter((m: any) => m.role === 'user').at(-1).content === 'stop');
    assert(channelCall); assert(!channelCall.tools.some((t: any) => t.function.name === 'interrupt_agent'));
    hold = true;
    const rollback = await send(a, 'ROLLBACK_WORK'); await until(a, rollback, r => r.agentMessages.some((m: any) => m.status === 'running'));
    injectFailure = true;
    const rejected = await send(a, 'stop'); await until(a, rejected, r => r.status === 'failed');
    const stillRunning = (await get(a)).find((r: any) => r.id === rollback);
    assert.equal(stillRunning.agentMessages[0].status, 'running');
    assert.equal((await get(a)).find((r: any) => r.id === rejected).agentMessages.length, 0);
    injectFailure = false;
    const child = stillRunning.agentMessages[0], childPath = `/api/threads/${child.thread}/turns`;
    const liveChild = (await get(childPath))[0];
    await post(`${childPath}/${child.id}/pause`, { id: randomUUID(), revision: liveChild.revision });
    await until(childPath, child.id, r => r.paused === 1);
    releases.splice(0).forEach(release => release());
    hold = false;
    const stopPaused = await send(a, 'stop'); const stopped = await until(a, stopPaused, r => r.status === 'done');
    assert(JSON.parse(stopped.reply).cancelled.includes(child.id));
    assert.equal((await until(a, rollback, r => r.status === 'done')).agentMessages[0].status, 'cancelled');
    const ancestor = await send(a, 'ANCESTOR_TASK'); const ancestorResult = await until(a, ancestor, r => r.status === 'done');
    assert.equal(ancestorResult.agentMessages[0].status, 'failed'); assert.match(ancestorResult.agentMessages[0].error, /You can only stop/);
    hold = true;
    const nested = await send(a, 'NESTED_TASK'); const nesting = await until(a, nested, r => r.agentMessages.length === 1);
    const nestedBeta = nesting.agentMessages[0], nestedPath = `/api/threads/${nestedBeta.thread}/turns`;
    const nestedWaiting = await until(nestedPath, nestedBeta.id, r => r.agentMessages.some((m: any) => m.status === 'running'));
    const nestedGamma = nestedWaiting.agentMessages[0];
    const stopTree = await send(a, 'stop'); const treeStopped = await until(a, stopTree, r => r.status === 'done');
    assert.deepEqual(JSON.parse(treeStopped.reply).cancelled.sort(), [nestedBeta.id, nestedGamma.id].sort());
    assert.equal((await get(`/api/threads/${nestedGamma.thread}/turns`))[0].status, 'cancelled');
    hold = false; releases.splice(0).forEach(release => release());
  } finally {
    await app.close(); hold = false; releases.splice(0).forEach(release => release()); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
