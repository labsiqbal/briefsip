import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';
import { visibilityCommand } from './agent-visibility.ts';
import { messageAgents } from './agent-messages.ts';

test('hidden agents finish active work, hold queue across restart, reject new work and skip missed schedules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-visibility-'));
  let held: ServerResponse | undefined; const calls: string[] = [];
  const finish = (res: ServerResponse) => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Finished' } }] }));
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const text = JSON.parse(raw).messages.at(-1).content; calls.push(text);
    if (text === 'WAIT') return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'wait', type: 'function', function: { name: 'wait_for_event', arguments: JSON.stringify({ event: 'ready', timeoutSeconds: 3600 }) } }] } }] }));
    if (text === 'HOLD') held = res; else finish(res);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 1 };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status?: number): Promise<any> {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); if (status) assert.equal(res.status, status, JSON.stringify(value)); else assert(res.ok, JSON.stringify(value)); return value;
  }
  async function until(check: () => Promise<boolean>) { for (let n = 0; n < 150; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Timed out'); }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' });
    const direct = `/api/agents/${a.id}/turns`, visibility = `/api/agents/${a.id}/visibility`;
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Help', lead: a.id, members: [a.id, b.id] });
    const routine = await request(`/api/agents/${a.id}/routines`, { id: randomUUID(), name: 'Timer', prompt: 'Timer', nextAt: Date.now() + 3600000, intervalSeconds: 60, enabled: true });
    const waitingId = randomUUID(), channelPath = `/api/channels/${channel.id}/turns`;
    await request(channelPath, { id: waitingId, text: 'WAIT', recipient: a.id });
    await until(async () => (await request(channelPath)).find((turn: any) => turn.id === waitingId)?.events?.length > 0);
    const active = randomUUID(), queued = randomUUID();
    await request(direct, { id: active, text: 'HOLD' }); await until(async () => !!held);
    await request(direct, { id: queued, text: 'QUEUED' });
    const channelQueued = randomUUID();
    await request(`/api/channels/${channel.id}/turns`, { id: channelQueued, text: 'CHANNEL QUEUED', recipient: a.id });
    const c = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'C', model: 'fixture', instructions: 'Help' });
    const group = await request('/api/channels', { id: randomUUID(), name: 'Group', instructions: 'Help', lead: a.id, members: [a.id, b.id, c.id] });
    const groupPath = `/api/channels/${group.id}/turns`, released = randomUUID();
    await request(groupPath, { id: released, text: 'REASSIGNED', recipient: a.id });
    const hide = { id: randomUUID(), revision: 0, hidden: true };
    const result = await request(visibility, hide);
    assert.equal((await request(`/api/channels/${channel.id}/turns`)).find((turn: any) => turn.id === channelQueued).agent, b.id); assert.deepEqual(await request(visibility, hide), result);
    const suspended = (await request(channelPath)).find((turn: any) => turn.id === waitingId);
    assert.equal(suspended.agent, a.id); assert.notEqual(suspended.routing, 'released');
    const waiting = (await request(groupPath)).find((turn: any) => turn.id === released); assert.equal(waiting.routing, 'released');
    await request(`${groupPath}/${released}/pause`, { id: randomUUID(), revision: waiting.revision });
    const paused = (await request(groupPath)).find((turn: any) => turn.id === released);
    await request(`${groupPath}/${released}/reassign`, { id: randomUUID(), revision: paused.revision, recipient: b.id });
    assert.equal((await request(groupPath)).find((turn: any) => turn.id === released).routing, 'assigned');
    await request(visibility, { ...hide, hidden: false }, 409);
    await request(visibility, { ...hide, id: randomUUID() }, 409);
    for (const path of [direct, `/api/threads/${side.id}/turns`, `/api/channels/${channel.id}/turns`]) await request(path, { id: randomUUID(), text: 'Denied', ...(path.includes('channels') ? { recipient: a.id } : {}) }, 409);
    await request(`/api/channels/${channel.id}/turns`, { id: randomUUID(), text: 'Hidden lead' }, 202);
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision }, 409);
    const workflow = await request(`/api/agents/${a.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Workflow', graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] } });
    await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Denied' }, 409);
    await request(`/api/workflows/${workflow.id}/schedule`, { id: randomUUID(), revision: 0, nextAt: Date.now() - 1000, intervalSeconds: null, input: 'skip', enabled: true });
    const once = await request(`/api/agents/${a.id}/routines`, { id: randomUUID(), name: 'Once', prompt: 'Never run', nextAt: Date.now() - 1000, intervalSeconds: null, enabled: true });
    finish(held!); await until(async () => (await request(direct)).find((t: any) => t.id === active)?.status === 'done');
    assert.equal((await request(direct)).find((t: any) => t.id === queued).status, 'queued');
    await until(async () => (await request(`/api/channels/${channel.id}/turns`)).find((turn: any) => turn.id === channelQueued)?.status === 'done');
    await until(async () => (await request(groupPath)).find((turn: any) => turn.id === released)?.status === 'done');
    await app.close(); app = await startApp(options);
    assert.equal((await request('/api/agents')).agents.find((agent: any) => agent.id === a.id).hidden, true);
    assert.equal((await request(direct)).find((t: any) => t.id === queued).status, 'queued');
    await app.close();
    const db = new DatabaseSync(options.database);
    try {
      const source = randomUUID(); db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES (?,?,'source','done','2026-11-11T00:00:00Z')").run(source, b.id);
      assert(!messageAgents(db, source).some(agent => agent.id === a.id));
      db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(Date.now() - 180000, routine.id);
    } finally { db.close(); }
    app = await startApp(options);
    const restore = { id: randomUUID(), revision: 1, hidden: false };
    await request(visibility, restore); await request(visibility, restore);
    await until(async () => (await request(direct)).find((t: any) => t.id === queued)?.status === 'done');
    await until(async () => (await request(`/api/channels/${channel.id}/turns`)).find((turn: any) => turn.id === channelQueued)?.status === 'done');
    assert.equal(calls.filter(text => text === 'CHANNEL QUEUED').length, 1);
    assert.equal(calls.filter(text => text === 'QUEUED').length, 1);
    assert.equal(calls.length, 6);
    await app.close();
    const check = new DatabaseSync(options.database);
    try {
      assert(Number(check.prepare('SELECT next_at FROM routines WHERE id=?').get(routine.id)!.next_at) > Date.now());
      assert.equal(check.prepare('SELECT count(*) AS n FROM agent_visibility_skips').get()!.n, 2);
      assert.equal(check.prepare('SELECT enabled FROM routines WHERE id=?').get(once.id)!.enabled, 0);
      assert.equal(check.prepare('SELECT enabled FROM workflow_schedules WHERE workflow=?').get(workflow.id)!.enabled, 0);
      assert.equal(check.prepare('SELECT reason FROM workflow_occurrences WHERE workflow=?').get(workflow.id)!.reason, 'hidden');
      assert.equal(check.prepare('SELECT count(*) AS n FROM workflow_runs WHERE workflow=?').get(workflow.id)!.n, 0);
    } finally { check.close(); app = await startApp(options); }
    assert.deepEqual(visibilityCommand(hide), hide);
    for (const bad of [null, [], {}, { ...hide, revision: -1 }, { ...hide, hidden: 1 }, { ...hide, extra: true }]) assert.throws(() => visibilityCommand(bad));
  } finally { await app.close().catch(() => {}); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
