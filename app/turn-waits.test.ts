import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreWorkspace } from './backup.ts';
import { startApp } from './server.ts';

test('agent event waits release workers, survive restart, honor pause and accept once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-turn-events-'));
  const prompts: string[] = [];
  let continuations = 0, invalid = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    prompts.push(raw); const { messages } = JSON.parse(raw);
    const received = messages.some((m: any) => m.role === 'tool');
    const ordinary = messages.findLast((m: any) => m.role === 'user').content === 'ordinary';
    if (received) continuations++;
    res.end(JSON.stringify({ choices: [{ finish_reason: received || ordinary ? 'stop' : 'tool_calls', message: received || ordinary ? { content: 'Finished' } : { tool_calls: [{ id: 'wait', type: 'function', function: { name: 'wait_for_event', arguments: JSON.stringify({ event: 'ready', timeoutSeconds: invalid ? 0 : 3600 }) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected?: number) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); if (expected) assert.equal(res.status, expected, JSON.stringify(value)); else assert(res.ok, JSON.stringify(value)); return value;
  }
  async function until(path: string, id: string, predicate: (row: any) => boolean) {
    for (let n = 0; n < 200; n++) { const row = (await request(path)).find((r: any) => r.id === id); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Turn did not settle');
  }
  async function waiting(path: string) { const id = randomUUID(); await request(path, { id, text: id }); return until(path, id, row => row.events?.length); }
  async function send(connection: any, id = randomUUID(), expected = 200) {
    const body = JSON.stringify({ event: 'ready', payload: 'synthetic' }), time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', connection.secret).update(`${time}\n${id}\n${body}`).digest('hex');
    const res = await fetch(app.origin + new URL(connection.url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': signature }, body });
    const value = await res.json(); assert.equal(res.status, expected, JSON.stringify(value)); return value;
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const direct = `/api/agents/${a.id}/turns`;
    const first = await waiting(direct), connection = await request(`/api/turn-waits/${first.events[0].id}`);
    for (const [name, value] of [['Origin', 'https://foreign.test'], ['Sec-Fetch-Site', 'cross-site']]) {
      const headers = { [name]: value };
      const denied = await fetch(connection.url, { headers }); assert.equal(denied.status, 403); assert(!(await denied.text()).includes(connection.secret));
    }
    await send({ ...connection, secret: 'wrong' }, randomUUID(), 401);
    assert.equal(first.status, 'queued'); assert.equal(first.paused, 0); assert(!JSON.stringify(first).includes(connection.secret));
    const other = randomUUID(); await request(direct, { id: other, text: 'ordinary' }); await until(direct, other, row => row.status === 'done');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(`/api/turn-waits/${first.events[0].id}`), { ...connection, url: app.origin + new URL(connection.url).pathname });
    await request(`${direct}/${first.id}/pause`, { id: randomUUID(), revision: first.revision });
    const delivery = randomUUID(), receipt = await send(connection, delivery); assert.deepEqual(await send(connection, delivery), receipt);
    const still = (await request(direct)).find((r: any) => r.id === first.id); assert.equal(still.paused, 1); assert.equal(continuations, 0);
    await request(`${direct}/${first.id}/resume`, { id: randomUUID(), revision: still.revision }); await until(direct, first.id, row => row.status === 'done'); assert.equal(continuations, 1);
    assert(!prompts.join('').includes(connection.secret));
    await app.close(); app = await startApp(options); assert.deepEqual(await send(connection, delivery), receipt); assert.equal(continuations, 1);
    const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const sidePath = `/api/threads/${side.id}/turns`, sideTurn = await waiting(sidePath);
    assert(!(await request(direct)).some((r: any) => r.id === sideTurn.id));
    const sideConnection = await request(`/api/turn-waits/${sideTurn.events[0].id}`);
    await request(`${sidePath}/${sideTurn.id}/cancel`, { id: randomUUID() }); await send(sideConnection, randomUUID(), 409);
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Events', instructions: 'Help', lead: a.id, members: [a.id] });
    const channelPath = `/api/channels/${channel.id}/turns`, channelTurn = await waiting(channelPath);
    const channelConnection = await request(`/api/turn-waits/${channelTurn.events[0].id}`);
    await request(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: 1, name: 'Events', instructions: 'Help', members: [a.id], lead: a.id, archived: true });
    await send(channelConnection, randomUUID(), 409); await request(new URL(channelConnection.url).pathname, undefined, 404);
    const pending = await waiting(direct), pendingConnection = await request(`/api/turn-waits/${pending.events[0].id}`);
    const pausedPending = await request(`${direct}/${pending.id}/pause`, { id: randomUUID(), revision: pending.revision });
    await request(`${direct}/${pending.id}/resume`, { id: randomUUID(), revision: pausedPending.revision });
    await request(`${direct}/${pending.id}/reassign`, { id: randomUUID(), revision: pausedPending.revision + 1, recipient: a.id }, 409);
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(backup.status, 200); const backupPath = join(dir, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    await app.close(); app = await startApp({ ...options, database: restoreWorkspace(backupPath, join(dir, 'restored.sqlite')) });
    await request(new URL(pendingConnection.url).pathname, undefined, 404); await send(pendingConnection, randomUUID(), 409);
    const recovered = (await request(direct)).find((r: any) => r.id === pending.id); assert.equal(recovered.events[0].status, 'closed');
    await request(`${direct}/${pending.id}/resume`, { id: randomUUID(), revision: recovered.revision, acknowledgeUncertain: true });
    const resumedRestore = await until(direct, pending.id, row => ['done', 'failed'].includes(row.status));
    assert.equal(resumedRestore.status, 'done', resumedRestore.error);
    assert.equal(JSON.parse(JSON.parse(prompts.at(-1)!).messages.filter((m: any) => m.role === 'tool').at(-1).content).status, 'closed');
    await send(pendingConnection, randomUUID(), 409);

    await app.close(); app = await startApp(options);
    const expiring = await waiting(direct); await app.close();
    const db = new DatabaseSync(options.database); db.prepare('UPDATE turn_waits SET deadline=0 WHERE turn=?').run(expiring.id); db.close();
    app = await startApp(options); const expired = await until(direct, expiring.id, row => row.status === 'failed'); assert.equal(expired.events[0].status, 'expired');
    await app.close(); const legacy = new DatabaseSync(options.database);
    legacy.prepare('DELETE FROM flow_tool_calls WHERE turn=?').run(expired.id); legacy.close();
    app = await startApp(options); await app.close(); app = await startApp(options); await app.close();
    const repaired = new DatabaseSync(options.database);
    try { assert.equal(repaired.prepare('SELECT count(*) AS n FROM flow_tool_calls WHERE turn=?').get(expired.id)!.n, 1); } finally { repaired.close(); }
    app = await startApp(options);
    await request(`${direct}/${expired.id}/resume`, { id: randomUUID(), revision: expired.revision, acknowledgeUncertain: true });
    const resumedExpired = await until(direct, expired.id, row => ['done', 'failed'].includes(row.status));
    assert.equal(resumedExpired.status, 'done', resumedExpired.error);
    assert.equal(JSON.parse(JSON.parse(prompts.at(-1)!).messages.filter((m: any) => m.role === 'tool').at(-1).content).status, 'expired');
    invalid = true; const bad = randomUUID(); await request(direct, { id: bad, text: bad }); const failed = await until(direct, bad, row => row.status === 'failed'); assert.match(failed.error, /Invalid event name or wait limit/);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('routine waits preserve artifacts and reject events cancelled before upload completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-routine-events-'));
  let filesRequested = 0, completed = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { messages, tools } = JSON.parse(raw);
    assert(tools.some((tool: any) => tool.function.name === 'wait_for_event'));
    const calls = messages.flatMap((m: any) => m.tool_calls ?? []);
    const received = calls.some((call: any) => call.function.name === 'wait_for_event');
    let name = 'wait_for_event', id = 'wait', args: unknown = { event: 'ready', timeoutSeconds: 3600 };
    if (!calls.length) { filesRequested++; name = 'create_text_file'; id = 'artifact'; args = { name: 'before.txt', text: 'Evidence before event.' }; }
    if (received) {
      completed++;
      assert.deepEqual(calls.map((call: any) => call.function.name), ['create_text_file', 'wait_for_event']);
      assert.equal(JSON.parse(messages.filter((m: any) => m.role === 'tool').at(-1).content).payload, 'ready-data');
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: received ? 'stop' : 'tool_calls', message: received ? { content: 'Routine resumed.' } : { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected?: number) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); if (expected) assert.equal(response.status, expected, JSON.stringify(value)); else assert(response.ok, JSON.stringify(value)); return value;
  }
  async function until(path: string, predicate: (rows: any[]) => boolean) {
    for (let n = 0; n < 200; n++) { const rows = await request(path); if (predicate(rows)) return rows; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Routine event state did not settle');
  }
  const body = JSON.stringify({ event: 'ready', payload: 'ready-data' });
  function headers(secret: string, id: string) {
    const time = String(Math.floor(Date.now() / 1000));
    return { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': createHmac('sha256', secret).update(`${time}\n${id}\n${body}`).digest('hex') };
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Routine', model: 'fixture', instructions: 'Help' });
    const routine = await request(`/api/agents/${agent.id}/routines`, { id: randomUUID(), name: 'Event routine', prompt: 'Wait for event', nextAt: Date.now() + 3600000, intervalSeconds: null, enabled: false });
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision });
    const runsPath = `/api/routines/${routine.id}/runs`;
    const [run] = await until(runsPath, rows => rows.length === 1);
    const turnsPath = `/api/threads/${run.thread}/turns`;
    const [waiting] = await until(turnsPath, rows => rows[0]?.events?.length === 1);
    assert.equal(waiting.generatedFiles.length, 1); assert.equal(filesRequested, 1);
    const connectionPath = `/api/turn-waits/${waiting.events[0].id}`, connection = await request(connectionPath);
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision }, 409);
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
    await app.close(); app = await startApp(options);
    const delivery = randomUUID();
    const responses = await Promise.all([1, 2].map(() => fetch(app.origin + connectionPath, { method: 'POST', headers: headers(connection.secret, delivery), body })));
    assert(responses.every(response => response.status === 200)); assert.deepEqual(await responses[0].json(), await responses[1].json());
    const [done] = await until(turnsPath, rows => rows[0]?.status === 'done');
    assert.equal(completed, 2); assert.equal(filesRequested, 1); assert.deepEqual(done.generatedFiles, waiting.generatedFiles);
    const download = await fetch(`${app.origin}/api/threads/${run.thread}/files/${done.generatedFiles[0].id}`); assert.equal(await download.text(), 'Evidence before event.');
    assert.equal((await request(runsPath))[0].status, 'done');
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision });
    const [next] = await until(runsPath, rows => rows.length === 2);
    const nextPath = `/api/threads/${next.thread}/turns`, [nextWaiting] = await until(nextPath, rows => rows[0]?.events?.length === 1);
    const nextConnection = await request(`/api/turn-waits/${nextWaiting.events[0].id}`);
    const { request: httpRequest } = await import('node:http');
    let upload!: ReturnType<typeof httpRequest>;
    const response = new Promise<number | undefined>((resolve, reject) => {
      upload = httpRequest(nextConnection.url, { method: 'POST', headers: { ...headers(nextConnection.secret, randomUUID()), 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      upload.on('error', reject);
    });
    void response.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => upload.write(body.slice(0, 10), error => error ? reject(error) : resolve()));
      await request(`${nextPath}/${nextWaiting.id}/cancel`, { id: randomUUID() });
      upload.end(body.slice(10)); assert.equal(await response, 409);
    } finally { upload.destroy(); }
    assert.equal(completed, 2); assert.equal((await request(runsPath))[0].status, 'cancelled');
    assert.equal((await request(nextPath))[0].events[0].status, 'closed');
    const scheduled = await request(`/api/agents/${agent.id}/routines`, { id: randomUUID(), name: 'Scheduled wait', prompt: 'Wait from schedule', nextAt: Date.now() - 1, intervalSeconds: null, enabled: true });
    const scheduledRuns = `/api/routines/${scheduled.id}/runs`, [scheduledRun] = await until(scheduledRuns, rows => rows.length === 1);
    const scheduledTurns = `/api/threads/${scheduledRun.thread}/turns`;
    const [scheduledWait] = await until(scheduledTurns, rows => rows[0]?.events?.length === 1);
    await app.close(); const db = new DatabaseSync(options.database); db.prepare('UPDATE turn_waits SET deadline=0 WHERE turn=?').run(scheduledWait.id); db.close();
    app = await startApp(options);
    const [expiredRun] = await until(scheduledRuns, rows => rows[0]?.status === 'failed');
    assert.match(expiredRun.error, /Event wait timed out/); assert.equal(completed, 2);
    assert.equal((await request(scheduledTurns))[0].generatedFiles.length, 1);

  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

for (const boundary of ['workflow', 'channel', 'thread'] as const) test(`${boundary} cancellation closes waiting descendants of completed steps`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-child-wait-'));
  let recipient = '', childContinuations = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), resumed = data.messages.some((message: any) => message.role === 'tool');
    const source = data.model === 'source';
    if (!source && resumed) childContinuations++;
    res.end(JSON.stringify({ choices: [{ finish_reason: resumed ? 'stop' : 'tool_calls', message: resumed ? { content: 'Finished' } : { tool_calls: [{ id: 'call', type: 'function', function: { name: source ? 'send_message' : 'wait_for_event', arguments: JSON.stringify(source ? { recipients: [recipient], text: 'Wait for external event', expects_reply: false } : { event: 'ready', timeoutSeconds: 3600 }) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected?: number) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); if (expected) assert.equal(res.status, expected, JSON.stringify(value)); else assert(res.ok, JSON.stringify(value)); return value;
  }
  async function until(path: string, predicate: (value: any) => boolean) {
    for (let n = 0; n < 200; n++) { const value = await request(path); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Workflow child did not settle');
  }
  try {
    const owner = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Owner', model: 'source', instructions: 'Help' });
    const child = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Child', model: 'child', instructions: 'Help' }); recipient = child.id;
    let cancel: () => Promise<unknown>, verifyRoot: () => Promise<void>, restore: (() => Promise<unknown>) | undefined;
    if (boundary === 'workflow') {
      const graph = { entry: 'agent', maxSteps: 4, nodes: [{ id: 'agent', kind: 'agent', agent: owner.id, prompt: 'Notify child', next: 'wait' }, { id: 'wait', kind: 'wait', event: 'workflow-ready', timeoutSeconds: 3600, next: 'out' }, { id: 'out', kind: 'output' }] };
      const workflow = await request(`/api/agents/${owner.id}/workflows`, { id: randomUUID(), name: 'Child wait', revision: 0, graph });
      const run = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: workflow.revision, input: 'Start' });
      const state = await until(`/api/workflow-runs/${run.id}`, value => value.cursor === 'wait' && value.status === 'waiting');
      cancel = () => request(`/api/workflow-runs/${run.id}/cancel`, { id: randomUUID(), revision: state.revision });
      verifyRoot = async () => { assert.equal((await request(`/api/workflow-runs/${run.id}`)).steps[0].status, 'done'); };
    } else if (boundary === 'channel') {
      const channel = await request('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Help', members: [owner.id, child.id], lead: owner.id });
      const path = `/api/channels/${channel.id}/turns`, root = randomUUID();
      await request(path, { id: root, text: 'Notify child', recipient: owner.id });
      await until(path, rows => rows.find((row: any) => row.id === root)?.status === 'done');
      cancel = () => request(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: channel.revision, name: channel.name, instructions: channel.instructions, members: channel.members, lead: channel.lead, archived: true });
      restore = () => request(`/api/channels/${channel.id}/edit`, { id: randomUUID(), revision: channel.revision + 1, name: channel.name, instructions: channel.instructions, members: channel.members, lead: channel.lead, archived: false });
      verifyRoot = async () => { assert.equal((await request(path)).find((row: any) => row.id === root).status, 'done'); };
    } else {
      const side = await request(`/api/agents/${owner.id}/threads`, { id: randomUUID(), name: 'Source' });
      const path = `/api/threads/${side.id}/turns`, root = randomUUID();
      await request(path, { id: root, text: 'Notify child' });
      await until(path, rows => rows.find((row: any) => row.id === root)?.status === 'done');
      cancel = () => request(`/api/threads/${side.id}/edit`, { id: randomUUID(), revision: side.revision, name: side.name, archived: true });
      restore = () => request(`/api/threads/${side.id}/edit`, { id: randomUUID(), revision: side.revision + 1, name: side.name, archived: false });
      verifyRoot = async () => { assert.equal((await request(path)).find((row: any) => row.id === root).status, 'done'); };
    }
    const [thread] = await until(`/api/agents/${child.id}/threads`, value => value.length);
    const turns = `/api/threads/${thread.id}/turns`, [waiting] = await until(turns, value => value[0]?.events?.length);
    const connection = await request(`/api/turn-waits/${waiting.events[0].id}`);
    const unrelated = randomUUID(), direct = `/api/agents/${child.id}/turns`;
    await request(direct, { id: unrelated, text: 'Independent task' });
    await until(direct, rows => rows.find((row: any) => row.id === unrelated)?.events?.length);
    await cancel();
    const stopped = (await request(turns))[0]; assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.events[0].status, 'closed');
    await verifyRoot();
    const body = JSON.stringify({ event: 'ready' }), id = randomUUID(), time = String(Math.floor(Date.now() / 1000));
    const headers = { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': id, 'X-Briefsip-Signature': createHmac('sha256', connection.secret).update(`${time}\n${id}\n${body}`).digest('hex') };
    const send = () => fetch(app.origin + new URL(connection.url).pathname, { method: 'POST', headers, body });
    const denied = await send(); assert.equal(denied.status, 409); await denied.arrayBuffer();
    await app.close(); app = await startApp(options);
    await restore?.();
    assert.equal((await request(turns))[0].status, 'cancelled'); const stillDenied = await send(); assert.equal(stillDenied.status, 409); await stillDenied.arrayBuffer();
    assert.equal(childContinuations, 0);
    assert.equal((await request(direct)).find((row: any) => row.id === unrelated).status, 'queued');
    await request(`${turns}/${waiting.id}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true }, 409);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
