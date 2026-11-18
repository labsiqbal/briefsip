import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';

test('delegation isolates child context and durably wakes idle parent exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-delegation-'));
  let target = '', wakes = 0, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw), results = body.messages.filter((m: any) => m.role === 'tool');
    let message;
    if (body.model === 'child') {
      assert(!JSON.stringify(body.messages).includes('PRIVATE_HISTORY'));
      await held; message = { content: 'Child final result' };
    } else if (JSON.stringify(body.messages).includes('Delegated task completed')) {
      wakes++; message = { content: 'Parent received result' };
    } else if (!results.length) {
      assert(body.tools.some((tool: any) => tool.function.name === 'delegate_task'));
      message = { tool_calls: [{ id: 'delegate', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ agent: target, task: 'Isolated work', wait: false }) } }] };
    } else { assert.equal(JSON.parse(results.at(-1).content).status, 'queued'); message = { content: 'Child launched' }; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const until = async (path: string, predicate: (rows: any[]) => boolean): Promise<any[]> => {
    for (let i = 0; i < 400; i++) { const rows = await api(path); if (predicate(rows)) return rows; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Timed out waiting for delegation');
  };
  try {
    const child = await api('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Child', model: 'child', instructions: 'Help.' }); target = child.id;
    const parent = await api('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Parent', model: 'parent', instructions: 'Coordinate.' });
    const path = `/api/agents/${parent.id}/turns`, id = randomUUID();
    await api(path, { id, text: 'PRIVATE_HISTORY' });
    const rows = await until(path, rows => rows.some(row => row.id === id && row.status === 'done'));
    assert.equal(rows[0].agentMessages.length, 1);
    release(); await until(path, rows => rows.some(row => row.reply === 'Parent received result'));
    await app.close(); app = await startApp(options);
    assert.equal((await api(path)).filter((row: any) => row.reply === 'Parent received result').length, 1);
    assert.equal(wakes, 1);
  } finally { release(); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});


import { DatabaseSync } from 'node:sqlite';
import { enforceAgentRate, resolveAgentTarget, initializeDelegation, type AgentLimits } from './agent-delegation.ts';

import { sendAgentMessage } from './agent-messages.ts';

type Script = (body: any) => Promise<{ name: string; args: unknown } | string> | { name: string; args: unknown } | string;
async function fixture(script: Script, agentLimits?: Partial<AgentLimits>) {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-delegation-')), calls: any[] = [];
  const provider = createServer({ keepAliveTimeout: 0 }, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push(body);
    try {
      const result = await script(body), message = typeof result === 'string' ? { content: result } : { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: result.name, arguments: JSON.stringify(result.args) } }] };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: typeof result === 'string' ? 'stop' : 'tool_calls', message }] }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 12, agentLimits };
  let app = await startApp(options), stopped = false;
  const stop = async () => { if (!stopped) { await app.close(); stopped = true; } };
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json', Connection: 'close' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const until = async (path: string, predicate: (rows: any[]) => boolean): Promise<any[]> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { const rows = await api(path); if (predicate(rows)) return rows; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`Timed out: ${path} ${JSON.stringify(await api(path))}`);
  };
  const agent = async (name: string) => api('/api/agents', { runtime: 'api', id: randomUUID(), name, model: name, instructions: `${name} role` });
  return { api, until, agent, calls, database: options.database, stop, restart: async () => { await stop(); app = await startApp(options); stopped = false; }, close: async () => { await stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
const results = (body: any) => body.messages.filter((row: any) => row.role === 'tool').map((row: any) => JSON.parse(row.content));
const gate = () => { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

for (const mode of ['complete', 'timeout', 'restart-wait', 'restart-child', 'delegate-wait']) test(`durable task wait: ${mode}`, async () => {
  let target = ''; const child = gate(); let childCalls = 0;
  const f = await fixture(async body => {
    if (body.model === 'Child') {
      childCalls++;
      if (mode === 'restart-wait' && !results(body).length) return { name: 'ask_user', args: { question: 'Finish child?', choices: ['Yes'] } };
      await child.promise; return 'Child result';
    }
    if (body.messages.filter((row: any) => row.role === 'user').at(-1)?.content.startsWith('Delegated task completed')) return 'Late result received';
    const rs = results(body);
    if (!rs.length) return { name: 'delegate_task', args: { agent: target, task: 'Child work', wait: mode === 'delegate-wait' } };
    if (rs.at(-1).taskId && rs.at(-1).status === 'queued') return { name: 'wait_task', args: { taskId: rs.at(-1).taskId, timeoutSeconds: mode === 'timeout' ? 1 : 600 } };
    return JSON.stringify(rs.at(-1));
  });
  try {
    target = (await f.agent('Child')).id; const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`, id = randomUUID();
    await f.api(path, { id, text: 'Start task' });
    const waiting = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'queued' && row.agentMessages.length))).find(row => row.id === id);
    assert.equal(waiting.reply, null);
    if (mode === 'timeout') {
      const done = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
      assert.equal(JSON.parse(done.reply).timedOut, true); child.release();
      await f.until(path, rows => rows.some(row => row.text.startsWith('Delegated task completed') && row.status === 'done'));
    } else {
      if (mode === 'restart-wait') {
        const item = waiting.agentMessages[0], childPath = `/api/threads/${item.thread}/turns`;
        const row = (await f.until(childPath, rows => rows[0]?.questions?.length))[0];
        assert.equal((await f.api(path)).find((row: any) => row.id === id).agentMessages[0].status, 'waiting');
        await f.restart(); child.release();
        await f.api(`${childPath}/${item.id}/questions/${row.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
      } else { if (mode === 'restart-child') { await f.until(`/api/threads/${waiting.agentMessages[0].thread}/turns`, rows => rows[0]?.status === 'running'); await f.restart(); } child.release(); }
      const done = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id), result = JSON.parse(done.reply);
      assert.equal(result.status, mode === 'restart-child' ? 'uncertain' : 'done');
      if (mode !== 'restart-child') assert.equal(result.result, 'Child result');
      assert.equal(childCalls, mode === 'restart-wait' ? 2 : 1);
      await f.restart(); assert.equal((await f.api(path)).filter((row: any) => row.text.startsWith('Delegated task completed')).length, 0);
    }
  } finally { child.release(); await f.close(); }
});

for (const limit of ['depth', 'children', 'size']) test(`backend delegation limit: ${limit}`, async () => {
  const ids: string[] = [], child = gate();
  const f = await fixture(async body => {
    const rs = results(body);
    if (limit === 'depth') {
      if (rs.length) return JSON.stringify(rs.at(-1));
      const next = Number(body.model.slice(1)) + 1;
      return { name: 'delegate_task', args: { agent: ids[next], task: 'Nested task', wait: true } };
    }
    if (body.model !== 'Parent') { await child.promise; return 'Child result'; }
    if (limit === 'size') return rs.length ? JSON.stringify(rs.at(-1)) : { name: 'delegate_task', args: { agent: ids[0], task: 'x'.repeat(16001) } };
    if (rs.length >= 8) return JSON.stringify(rs.at(-1));
    return { name: 'send_message', args: { recipients: ids, text: 'Child work', expects_reply: false } };
  });
  try {
    if (limit === 'depth') {
      for (let i = 0; i < 5; i++) ids.push((await f.agent(`A${i}`)).id);
      const path = `/api/agents/${ids[0]}/turns`, id = randomUUID(); await f.api(path, { id, text: 'Start' });
      const done = (await f.until(path, rows => rows[0]?.status === 'done'))[0];
      assert.match(done.reply, /depth/);
      assert.equal(f.calls.filter(call => call.model === 'A4').length, 0);
    } else {
      for (let i = 0; i < (limit === 'children' ? 8 : 1); i++) ids.push((await f.agent(`Child${i}`)).id);
      const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`; await f.api(path, { id: randomUUID(), text: 'Start' });
      if (limit === 'children') {
        const done = (await f.until(path, rows => rows[0]?.status === 'failed'))[0];
        assert.match(done.error, /Concurrent child/); assert.equal(done.agentMessages.length, 8);
      } else {
        const done = (await f.until(path, rows => rows[0]?.status === 'done'))[0]; assert.match(done.reply, /16,000/); assert.equal(done.agentMessages.length, 0);
      }
    }
  } finally { child.release(); await f.close(); }
});

test('rate budget and cooldown survive reopen, then admit after cooldown', async () => {
  const f = await fixture(() => 'Done');
  try {
    const agent = await f.agent('Rate'); await f.stop(); const db = new DatabaseSync(f.database);
    assert.equal(resolveAgentTarget('Rate', db)?.kind, 'local');
    for (let i = 0; i < 20; i++) enforceAgentRate(db, agent.id);
    assert.throws(() => enforceAgentRate(db, agent.id), /rate limit reached/);
    assert.throws(() => enforceAgentRate(db, agent.id), /cooling down/); db.close();
    await f.restart(); await f.stop(); const reopened = new DatabaseSync(f.database);
    try {
      assert.throws(() => enforceAgentRate(reopened, agent.id), /cooling down/);
      reopened.exec('UPDATE agent_message_events SET created=0; UPDATE agent_message_cooldowns SET until=0');
      assert.doesNotThrow(() => enforceAgentRate(reopened, agent.id));
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('delegated task authority denies unrelated caller; cancel stops entire mixed-message tree', async () => {
  let beta = '', gamma = '', rootTask = ''; const held = gate();
  const f = await fixture(async body => {
    const rs = results(body);
    if (body.model === 'Other') return rs.length >= 2 ? JSON.stringify(rs) : { name: rs.length ? 'cancel_task' : 'task_status', args: { taskId: rootTask } };
    if (body.model === 'Gamma') { await held.promise; return 'Late result'; }
    if (body.model === 'Beta') return rs.length ? 'Beta result' : { name: 'send_message', args: { recipients: [gamma], text: 'Grandchild work', expects_reply: true } };
    if (!rs.length) return { name: 'delegate_task', args: { agent: beta, task: 'Child work' } };
    rootTask = rs[0].taskId;
    if (rs.length === 1) return { name: 'ask_user', args: { question: 'Cancel tree?', choices: ['Yes'] } };
    if (rs.length === 2) return { name: 'cancel_task', args: { taskId: rootTask } };
    return JSON.stringify(rs.at(-1));
  });
  try {
    beta = (await f.agent('Beta')).id; gamma = (await f.agent('Gamma')).id;
    const parent = await f.agent('Parent'), other = await f.agent('Other'), path = `/api/agents/${parent.id}/turns`, id = randomUUID(); await f.api(path, { id, text: 'Start' });
    const waiting = (await f.until(path, rows => rows[0]?.questions?.length))[0], item = waiting.agentMessages[0], childPath = `/api/threads/${item.thread}/turns`;
    const nested = (await f.until(childPath, rows => rows[0]?.agentMessages.some((row: any) => row.status === 'running')))[0];
    const otherPath = `/api/agents/${other.id}/turns`;
    await f.api(otherPath, { id: randomUUID(), text: 'Try unrelated task' });
    const denied = (await f.until(otherPath, rows => rows[0]?.status === 'done'))[0];
    const deniedResults = JSON.parse(denied.reply); assert.equal(deniedResults.length, 2); assert(deniedResults.every((result: any) => result.status === 403));
    await f.api(`${path}/${id}/questions/${waiting.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
    const done = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
    assert.equal(JSON.parse(done.reply).status, 'cancelled');
    assert.equal((await f.api(childPath))[0].status, 'cancelled');
    assert.equal((await f.api(`/api/threads/${nested.agentMessages[0].thread}/turns`))[0].status, 'cancelled');
  } finally { held.release(); await f.close(); }
});

test('team awareness refreshes role and bounded roster on next provider request', async () => {
  const advance = gate(); let first = '', second = '';
  const f = await fixture(async body => {
    if (!results(body).length) { first = body.messages[0].content; await advance.promise; return { name: 'list_agents', args: {} }; }
    second = body.messages[0].content; return 'Refreshed';
  });
  try {
    const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`; await f.api(path, { id: randomUUID(), text: 'Roster' });
    for (let i = 0; i < 300 && !first; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert(first.includes('Messaging other agents'));
    const teammate = await f.agent('New teammate');
    await f.api(`/api/agents/${teammate.id}/edit`, { id: randomUUID(), revision: teammate.revision, name: teammate.name, role: 'Research agent', model: teammate.model, instructions: teammate.instructions });
    advance.release(); await f.until(path, rows => rows[0]?.status === 'done');
    assert(!first.includes('New teammate')); assert(second.includes('New teammate - Research agent')); assert.notEqual(first.match(/Capability epoch: ([a-f0-9]+)/)?.[1], second.match(/Capability epoch: ([a-f0-9]+)/)?.[1]);
    assert(second.length < 5000);
  } finally { advance.release(); await f.close(); }
});

for (const messageTool of ['delegate_task', 'send_message']) test(`${messageTool} receives actionable rate error across conversations, restart and cooldown`, async () => {
  let target = '';
  const f = await fixture(body => {
    const rs = results(body); if (body.model !== 'Parent') return 'Child result';
    if (body.messages.filter((row: any) => row.role === 'user').at(-1)?.content.startsWith('Delegated task completed')) return 'Received';
    return rs.length ? JSON.stringify(rs.at(-1)) : messageTool === 'delegate_task' ? { name: messageTool, args: { agent: target, task: 'Work' } } : { name: messageTool, args: { recipients: [target], text: 'Work', expects_reply: false } };
  }, { rate: 2, rateWindowMs: 300000, cooldownMs: 600000 });
  try {
    target = (await f.agent('Child')).id; const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`;
    const side = await f.api(`/api/agents/${parent.id}/threads`, { id: randomUUID(), name: 'Other conversation' });
    for (let index = 0; index < 4; index++) {
      const workPath = index < 2 ? path : `/api/threads/${side.id}/turns`;
      const id = randomUUID(); await f.api(workPath, { id, text: `Work ${index}` });
      const row = (await f.until(workPath, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
      const result = JSON.parse(row.reply); if (index < 2) assert.equal(result.status, messageTool === 'delegate_task' ? 'queued' : 'sent'); else assert.match(result.error, index === 2 ? /rate limit reached/ : /cooling down/);
      if (index === 2) await f.restart();
    }
    await f.stop(); const db = new DatabaseSync(f.database); db.exec('UPDATE agent_message_events SET created=0; UPDATE agent_message_cooldowns SET until=0'); db.close(); await f.restart();
    const id = randomUUID(); await f.api(path, { id, text: 'After cooldown' }); const row = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id); assert.equal(JSON.parse(row.reply).status, messageTool === 'delegate_task' ? 'queued' : 'sent');
  } finally { await f.close(); }
});

for (const cancel of [false, true]) test(`nested async children: ${cancel ? 'cancel completed root with running descendants' : 'wait includes completion follow-up'}`, async () => {
  let childId = '', grandchildId = ''; const held = gate();
  const f = await fixture(async body => {
    const rs = results(body), input = body.messages.filter((row: any) => row.role === 'user').at(-1)?.content;
    if (body.model === 'Grandchild') { await held.promise; return 'Grandchild final'; }
    if (body.model === 'Child') {
      if (input.startsWith('Delegated task completed')) return 'Combined nested result';
      return rs.length ? 'Nested task launched' : { name: 'delegate_task', args: { agent: grandchildId, task: 'Nested task' } };
    }
    if (cancel && rs.length === 1) return { name: 'ask_user', args: { question: 'Cancel nested work?', choices: ['Yes'] } };
    if (cancel && rs.length === 2) return { name: 'cancel_task', args: { taskId: rs[0].taskId } };
    return rs.length ? JSON.stringify(rs.at(-1)) : { name: 'delegate_task', args: { agent: childId, task: 'Gather nested result', wait: !cancel } };
  });
  try {
    childId = (await f.agent('Child')).id; grandchildId = (await f.agent('Grandchild')).id;
    const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`; await f.api(path, { id: randomUUID(), text: 'Nested request' });
    const parentRow = (await f.until(path, rows => rows[0]?.agentMessages.length))[0];
    const childPath = `/api/threads/${parentRow.agentMessages[0].thread}/turns`;
    await f.until(childPath, rows => rows[0]?.status === 'done');
    assert.equal((await f.api(path))[0].status, 'queued');
    if (cancel) {
      const waiting = (await f.until(path, rows => rows[0]?.questions?.length))[0];
      assert.equal(waiting.agentMessages[0].status, 'waiting');
      await f.api(`${path}/${waiting.id}/questions/${waiting.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
    } else held.release();
    const done = (await f.until(path, rows => rows[0]?.status === 'done'))[0];
    if (cancel) {
      assert.equal(JSON.parse(done.reply).status, 'cancelled');
      await f.restart(); assert.equal((await f.api(childPath)).length, 1);
      assert.equal((await f.api(childPath))[0].status, 'cancelled');
    } else assert.equal(JSON.parse(done.reply).result, 'Combined nested result');
  } finally { held.release(); await f.close(); }
});


test('owner later turns can inspect and wait without a duplicate completion wake', async () => {
  let target = '', taskId = ''; const held = gate();
  const f = await fixture(async body => {
    if (body.model === 'Child') { await held.promise; return 'Later-turn result'; }
    const rs = results(body), input = body.messages.filter((row: any) => row.role === 'user').at(-1)?.content;
    if (input.startsWith('Delegated task completed')) return 'Unexpected wake';
    if (rs.length) { if (input === 'Start') taskId = rs[0].taskId; return JSON.stringify(rs.at(-1)); }
    if (input === 'Inspect') return { name: 'task_status', args: { taskId } };
    if (input === 'Wait') return { name: 'wait_task', args: { taskId, timeoutSeconds: 600 } };
    return { name: 'delegate_task', args: { agent: target, task: 'Work' } };
  });
  try {
    target = (await f.agent('Child')).id; const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`;
    for (const text of ['Start', 'Inspect']) {
      const id = randomUUID(); await f.api(path, { id, text });
      const row = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
      assert.equal(JSON.parse(row.reply).status, text === 'Start' ? 'queued' : 'running');
    }
    const id = randomUUID(); await f.api(path, { id, text: 'Wait' });
    await f.until(path, rows => rows.some(row => row.id === id && row.waiting_for)); held.release();
    const row = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
    assert.equal(JSON.parse(row.reply).result, 'Later-turn result');
    await f.restart(); assert.equal((await f.api(path)).length, 3);
  } finally { held.release(); await f.close(); }
});

test('completion wakes a parent waiting for user input and preserves its pending question', async () => {
  let target = ''; const held = gate();
  const f = await fixture(async body => {
    if (body.model === 'Child') { await held.promise; return 'Result while waiting'; }
    const input = body.messages.filter((row: any) => row.role === 'user').at(-1)?.content;
    if (input.startsWith('Delegated task completed')) return 'Completion received';
    return results(body).length ? { name: 'ask_user', args: { question: 'Choose next work?', choices: ['Later'] } } : { name: 'delegate_task', args: { agent: target, task: 'Work' } };
  });
  try {
    target = (await f.agent('Child')).id; const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`, id = randomUUID();
    await f.api(path, { id, text: 'Start' }); await f.until(path, rows => rows[0]?.questions?.length); held.release();
    await f.until(path, rows => rows.some(row => row.reply === 'Completion received'));
    await f.restart(); const rows = await f.api(path);
    assert.equal(rows.filter((row: any) => row.text.startsWith('Delegated task completed')).length, 1);
    const waiting = rows.find((row: any) => row.id === id); assert.equal(waiting.paused, 1); assert.equal(waiting.questions[0].answer, null);
  } finally { held.release(); await f.close(); }
});

test('concurrent child limit counts tasks still waiting on their async descendants', async () => {
  let childId = '', spareId = '', grandchildId = ''; const held = gate();
  const f = await fixture(async body => {
    const rs = results(body);
    if (body.model === 'Grandchild') { await held.promise; return 'Grandchild result'; }
    if (body.model === 'Child') return rs.length ? 'Waiting for nested result' : { name: 'delegate_task', args: { agent: grandchildId, task: 'Nested work' } };
    if (body.model === 'Spare') assert.fail('Concurrent task must not start');
    if (!rs.length) return { name: 'delegate_task', args: { agent: childId, task: 'Work' } };
    if (rs.length === 1) return { name: 'ask_user', args: { question: 'Start second child?', choices: ['Yes'] } };
    return rs.length === 2 ? { name: 'delegate_task', args: { agent: spareId, task: 'More work' } } : JSON.stringify(rs.at(-1));
  }, { concurrentChildren: 1 });
  try {
    childId = (await f.agent('Child')).id; spareId = (await f.agent('Spare')).id; grandchildId = (await f.agent('Grandchild')).id;
    const parent = await f.agent('Parent'), path = `/api/agents/${parent.id}/turns`, id = randomUUID();
    await f.api(path, { id, text: 'Start' }); const parentRow = (await f.until(path, rows => rows[0]?.questions?.length))[0];
    await f.until(`/api/threads/${parentRow.agentMessages[0].thread}/turns`, rows => rows[0]?.status === 'done');
    assert.equal((await f.api(path)).find((row: any) => row.id === id).agentMessages[0].status, 'waiting');
    await f.api(`${path}/${id}/questions/${parentRow.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
    const done = (await f.until(path, rows => rows.some(row => row.id === id && row.status === 'done'))).find(row => row.id === id);
    assert.match(JSON.parse(done.reply).error, /Concurrent child limit.*1 children/); assert.equal(done.agentMessages.length, 1);
  } finally { held.release(); await f.close(); }
});

test('concurrent child budget follows owner completion turns', async () => {
  const f = await fixture(() => 'Done');
  try {
    const parent = await f.agent('Parent'), child = await f.agent('Child'), spare = await f.agent('Spare');
    await f.stop(); const db = new DatabaseSync(f.database);
    try {
      initializeDelegation(db, { concurrentChildren: 1 });
      const root = randomUUID(), active = randomUUID(), continuation = randomUUID();
      const insert = db.prepare('INSERT INTO turns(id,agent,parent,text,status,created) VALUES (?,?,?,?,?,?)');
      insert.run(root, parent.id, null, 'Original task', 'done', new Date().toISOString());
      insert.run(active, child.id, root, 'Still working', 'queued', new Date().toISOString());
      insert.run(continuation, parent.id, root, 'Completion input', 'running', new Date().toISOString());
      assert.throws(() => sendAgentMessage(db, continuation, { id: randomUUID(), function: { name: 'send_message', arguments: JSON.stringify({ recipients: [spare.id], text: 'More work', expects_reply: false }) } }, 0), /Concurrent child limit/);
      assert.equal(db.prepare('SELECT count(*) n FROM turns').get()!.n, 3);
    } finally { db.close(); }
  } finally { await f.close(); }
});
