import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';

test('profile tool preserves authority, revision conflicts, execution snapshot and durable results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-profile-tool-'));
  let args: unknown = {}, hold = false, continued = false, result: any, advertised = false, answerOnly = false;
  let before: (() => Promise<unknown>) | undefined;
  const systems: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); systems.push(body.messages[0].content);
    advertised = body.tools.some((tool: any) => tool.function.name === 'edit_profile');
    const last = body.messages.findLast((message: any) => message.role === 'tool');
    if (last) { result = JSON.parse(last.content); continued = true; if (hold) return; }
    else if (before) { const action = before; before = undefined; await action(); }
    const done = last || answerOnly;
    res.end(JSON.stringify({ choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { content: 'Profile result checked.' } : { tool_calls: [{ id: 'profile', type: 'function', function: { name: 'edit_profile', arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  }
  async function waitFor(check: () => Promise<any>) { for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out'); }
  async function until(path: string, id: string, status = 'done') { return waitFor(async () => (await request(path + '/turns')).find((row: any) => row.id === id && row.status === status)); }
  async function run(path: string, status = 'done') { const id = randomUUID(); const command = { id, text: 'Change your profile' }; await request(path + '/turns', command); await until(path, id, status); await request(path + '/turns', command); return id; }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Original', model: 'fixture', instructions: 'Original instructions.' });
    const other = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Other', model: 'fixture', instructions: 'Other instructions.' });
    const path = `/api/agents/${agent.id}`;
    const profile = async () => (await request('/api/agents')).agents.find((item: any) => item.id === agent.id);
    const side = await request(path + '/threads', { id: randomUUID(), name: 'Side' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', members: [agent.id], lead: agent.id });
    args = { revision: 1, name: 'Renamed', role: ' Orchestration agent ', instructions: 'Updated instructions.' }; await run(path);
    assert(advertised); assert.equal(result.revision, 2); assert.equal(result.name, 'Renamed'); assert.equal(result.role, 'Orchestration agent');
    assert(systems.slice(-2).every(text => text.startsWith('<runtime_info>') && text.includes('\n\nOriginal instructions.')));
    assert.equal((await profile()).instructions, 'Updated instructions.');
    answerOnly = true; await run(path); answerOnly = false; assert(systems.at(-1)!.includes('\n\nUpdated instructions.'));
    args = { revision: 2, role: '' }; await run(`/api/threads/${side.id}`); assert.equal(result.revision, 3); assert.equal((await profile()).role, ''); assert.equal((await profile()).instructions, 'Updated instructions.');
    for (const bad of [{ revision: 2, name: 'stale' }, { revision: 3 }, { revision: 3, name: '' }, ...[null, 1, 'x'.repeat(61), 'bad\nrole', 'bad\u0085role', 'bad\u2028role'].map(role => ({ revision: 3, role })), { revision: 3, instructions: 'x'.repeat(8001) }, { revision: 3, name: 'x', model: 'elsewhere' }, { revision: 3, name: 'x', providerAccount: 'secret' }, { revision: 3, name: 'x', agent: other.id }]) {
      args = bad; await run(path); assert([400,409].includes(result.status)); assert.equal((await profile()).revision, 3);
    }
    args = { revision: 3, instructions: 'Channel cannot edit' }; await run(`/api/channels/${room.id}`, 'failed'); assert.equal(advertised, false); assert.equal((await profile()).revision, 3);
    args = { revision: 3, instructions: 'Persisted before restart.' }; hold = true; continued = false;
    const interrupted = randomUUID(); await request(path + '/turns', { id: interrupted, text: 'Change instructions' }); await waitFor(async () => continued);
    assert.equal((await profile()).revision, 4);
    await app.close(); app = await startApp(options); hold = false;
    const edit = { id: randomUUID(), revision: 4, name: 'User choice', model: 'fixture', instructions: 'User instructions.' };
    await request(path + '/edit', edit);
    const stopped = await until(path, interrupted, 'interrupted');
    await request(`${path}/turns/${interrupted}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true }); await until(path, interrupted);
    assert.equal(result.revision, 4); assert.equal(result.instructions, 'Persisted before restart.'); assert.equal((await profile()).name, 'User choice'); assert.equal((await profile()).revision, 5);
    args = { revision: 5, name: 'Cancelled' }; const cancelled = randomUUID(); before = () => request(`${path}/turns/${cancelled}/cancel`, { id: randomUUID() });
    await request(path + '/turns', { id: cancelled, text: 'Cancel' }); await until(path, cancelled, 'cancelled'); assert.equal((await profile()).revision, 5);
    assert.equal((await request('/api/agents')).agents.find((item: any) => item.id === other.id).revision, 1);
    await app.close(); const db = new DatabaseSync(options.database); db.exec("CREATE TRIGGER reject_profile_journal BEFORE INSERT ON flow_tool_calls BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END"); db.close();
    app = await startApp(options); await run(path, 'failed'); assert.equal((await profile()).revision, 5); assert.equal((await profile()).name, 'User choice');
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
