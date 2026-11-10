import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { DatabaseSync } from 'node:sqlite';
import { captureAgentReplies, capturedAgentReplies } from './agent-messages.ts';

test('new user turns capture only ready same-scope group replies once across retries and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-reply-capture-'));
  const calls: any[] = [], release: (() => void)[] = [];
  let targets: string[] = [], holdGamma = true, failConsumer = true;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    const prompt = body.messages.filter((m: any) => m.role === 'user').at(-1).content;
    let answer;
    if (body.model === 'gamma') {
      if (holdGamma) await new Promise<void>(resolve => release.push(resolve)); answer = 'LATE_GAMMA';
    } else if (body.model === 'beta') answer = 'READY_BETA';
    else if (body.tools?.length && prompt === 'start group' && !body.messages.some((m: any) => m.role === 'tool')) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ recipients: targets, text: 'group request', expects_reply: true }) } }] } }] })); return;
    } else if (!body.tools?.length) answer = JSON.stringify({ action: 'assign', recipient: targets[2] });
    else if (prompt === 'use ready results' && failConsumer) { failConsumer = false; res.writeHead(503); res.end(); return; }
    else if (prompt === 'WITHDRAWN_REQUEST_DO_NOT_EXECUTE') { await new Promise<void>(resolve => release.push(resolve)); answer = 'Withdrawn reply'; }
    else answer = 'Caller complete';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: answer } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  const post = async (path: string, data: unknown, status = 200) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const get = async (path: string) => (await fetch(app.origin + path)).json();
  const until = async (path: string, id: string, check: (row: any) => boolean) => {
    for (let n = 0; n < 400; n++) { const row = (await get(path)).find((r: any) => r.id === id); if (row && check(row)) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timeout ${path} ${id}`);
  };
  const submit = async (path: string, text: string, extra = {}) => { const id = randomUUID(); await post(path, { id, text, ...extra }, 202); return id; };
  try {
    const alpha = await post('/api/agents', { id: randomUUID(), name: 'Alpha', model: 'alpha', instructions: 'Coordinate' }, 201);
    const beta = await post('/api/agents', { id: randomUUID(), name: 'Beta', model: 'beta', instructions: 'Help' }, 201);
    const gamma = await post('/api/agents', { id: randomUUID(), name: 'Gamma', model: 'gamma', instructions: 'Help' }, 201);
    targets = [beta.id, gamma.id];
    const path = `/api/agents/${alpha.id}/turns`;
    const group = await submit(path, 'start group'); const waiting = await until(path, group, row => row.agentMessages.some((item: any) => item.status === 'done'));
    const side = await post(`/api/agents/${alpha.id}/threads`, { id: randomUUID(), name: 'Other scope' });
    const sidePath = `/api/threads/${side.id}/turns`, separate = await submit(sidePath, 'other user message');
    assert.equal((await until(sidePath, separate, row => row.status === 'done')).receivedAgentReplies.length, 0);
    const consumer = { id: randomUUID(), text: 'use ready results' };
    await post(path, consumer, 202); const failed = await until(path, consumer.id, row => row.status === 'failed');
    assert.equal(failed.receivedAgentReplies.length, 1); assert.equal(failed.receivedAgentReplies[0].reply, 'READY_BETA');
    assert.equal(failed.receivedAgentReplies[0].source, group);
    const firstAttempt = calls.find(body => body.model === 'alpha' && body.messages.at(-1).content === consumer.text);
    assert(firstAttempt.messages.some((m: any) => typeof m.content === 'string' && m.content.startsWith('Teammate results available') && m.content.includes('READY_BETA')));
    await post(path, consumer, 202);
    const second = await submit(path, 'another message'); assert.equal((await until(path, second, row => row.status === 'done')).receivedAgentReplies.length, 0);
    await app.close(); release.splice(0).forEach(resolve => resolve()); holdGamma = false; app = await startApp(options);
    await post(path, consumer, 202);
    assert.deepEqual((await get(path)).find((r: any) => r.id === consumer.id).receivedAgentReplies, failed.receivedAgentReplies);
    await post(`${path}/${consumer.id}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true });
    await until(path, consumer.id, row => row.status === 'done');
    const attempts = calls.filter(body => body.model === 'alpha' && body.messages.at(-1).content === consumer.text);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].messages.find((m: any) => m.content?.startsWith?.('Teammate results available')), attempts[1].messages.find((m: any) => m.content?.startsWith?.('Teammate results available')));
    await until(path, group, row => row.status === 'done');
    const continuation = calls.find(body => body.model === 'alpha' && body.messages.at(-1).content?.startsWith('Some teammate results were attached'));
    assert(continuation); assert(continuation.messages.at(-1).content.includes(consumer.text));
    const receipt = JSON.parse(continuation.messages.find((m: any) => m.role === 'tool').content);
    assert(!receipt.replies.some((item: any) => item.id === waiting.agentMessages.find((item: any) => item.status === 'done').id));
    assert.equal(receipt.delivered_earlier[0].consumer, consumer.id);
    assert.equal(calls.filter(body => body.model === 'gamma').length, 1);
    // Empty captures stay empty even if more results become ready before a retry.
    holdGamma = true;
    const empty = await submit(path, 'empty snapshot'); await until(path, empty, row => row.status === 'done');
    const nextGroup = await submit(path, 'start group'); await until(path, nextGroup, row => row.agentMessages.some((item: any) => item.status === 'done'));
    await post(path, { id: empty, text: 'empty snapshot' }, 202); assert.equal((await get(path)).find((r: any) => r.id === empty).receivedAgentReplies.length, 0);
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Other channel', instructions: 'Coordinate', members: [alpha.id, beta.id, gamma.id], lead: alpha.id }, 201);
    const channelPath = `/api/channels/${channel.id}/turns`;
    const isolated = await submit(channelPath, 'channel isolated', { recipient: alpha.id }); assert.equal((await until(channelPath, isolated, row => row.status === 'done')).receivedAgentReplies.length, 0);
    const channelGroup = await submit(channelPath, 'start group', { recipient: alpha.id }); await until(channelPath, channelGroup, row => row.agentMessages.some((item: any) => item.status === 'done'));
    targets[2] = alpha.id;
    const routed = await submit(channelPath, 'automatic followup', { automatic: true }); const routedResult = await until(channelPath, routed, row => row.status === 'done');
    assert.equal(routedResult.receivedAgentReplies.length, 1); assert.equal(routedResult.receivedAgentReplies[0].source, channelGroup);
    const otherOwner = await submit(channelPath, 'different owner', { recipient: beta.id }); assert.equal((await until(channelPath, otherOwner, row => row.status === 'done')).receivedAgentReplies.length, 0);
    await post(`${path}/${nextGroup}/cancel`, { id: randomUUID() });
    await post(`${channelPath}/${channelGroup}/cancel`, { id: randomUUID() });
    release.splice(0).forEach(resolve => resolve());
    targets = [beta.id, gamma.id]; holdGamma = true;
    const cancelGroup = await submit(path, 'start group'); await until(path, cancelGroup, row => row.agentMessages.some((item: any) => item.status === 'done'));
    const withdrawn = await submit(path, 'WITHDRAWN_REQUEST_DO_NOT_EXECUTE'); await until(path, withdrawn, row => row.status === 'running');
    await post(`${path}/${withdrawn}/cancel`, { id: randomUUID() });
    const beforeFinish = calls.length; holdGamma = false; release.splice(0).forEach(resolve => resolve());
    await until(path, cancelGroup, row => row.status === 'done');
    const cancelledContext = calls.slice(beforeFinish).find(body => body.model === 'alpha' && body.messages.at(-1).content?.startsWith('Some teammate results were attached'));
    assert(cancelledContext);
    assert(!JSON.stringify(cancelledContext.messages).includes('WITHDRAWN_REQUEST_DO_NOT_EXECUTE'));
    const forwarded = JSON.parse(cancelledContext.messages.at(-1).content.split('Reference data: ')[1]);
    assert.equal(forwarded[0].status, 'cancelled'); assert.equal(forwarded[0].user_message, null);
    assert.equal(forwarded[0].recovery_result.reply, 'READY_BETA');
    assert.equal((await get(path)).find((row: any) => row.id === withdrawn).receivedAgentReplies[0].reply, 'READY_BETA');
  } finally {
    await app.close(); holdGamma = false; release.splice(0).forEach(resolve => resolve()); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});

test('automation ancestry excludes nested result groups from user capture', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-capture-scope-')), database = join(directory, 'state.sqlite');
  const app = await startApp({ database }); await app.close();
  const db = new DatabaseSync(database);
  try {
    const a = randomUUID(), b = randomUUID(), root = randomUUID(), source = randomUUID(), child = randomUUID(), user = randomUUID(), routine = randomUUID(), group = randomUUID();
    for (const id of [a, b]) db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(id, id, 'fixture', 'Help');
    const insert = (id: string, agent: string, parent: string | null, status: string) => db.prepare('INSERT INTO turns(id,agent,parent,text,status,created,reply) VALUES (?,?,?,?,?,?,?)').run(id, agent, parent, 'fixture', status, new Date().toISOString(), status === 'done' ? 'EVIDENCE' : null);
    insert(root, a, null, 'queued'); insert(source, b, root, 'queued'); insert(child, a, source, 'done'); insert(user, b, null, 'queued');
    db.prepare('INSERT INTO routines(id,agent,name,prompt,next_at,enabled) VALUES (?,?,?,?,?,?)').run(routine, a, 'Automation', 'Run', Date.now(), 0);
    db.prepare('INSERT INTO routine_runs(routine,scheduled_at,turn,missed) VALUES (?,?,?,?)').run(routine, null, root, 0);
    db.prepare('INSERT INTO agent_requests(id,turn,call_id,expects_reply) VALUES (?,?,?,1)').run(group, source, 'call');
    db.prepare('INSERT INTO agent_deliveries VALUES (?,?)').run(group, child);
    db.exec('BEGIN'); captureAgentReplies(db, user); db.exec('COMMIT');
    assert.deepEqual(capturedAgentReplies(db, user), []);
    db.prepare('DELETE FROM routine_runs WHERE turn=?').run(root);
    const ordinary = randomUUID(); insert(ordinary, b, null, 'queued');
    db.exec('BEGIN'); captureAgentReplies(db, ordinary); db.exec('COMMIT');
    assert.equal(capturedAgentReplies(db, ordinary)[0].reply, 'EVIDENCE');
    captureAgentReplies(db, user); assert.deepEqual(capturedAgentReplies(db, user), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
