import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './server.ts';

test('model conditions choose one branch without tools and reject ambiguous answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-condition-'));
  let answer = 'yes'; const payloads: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    payloads.push(JSON.parse(raw));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: answer } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Condition', model: 'owner', instructions: 'Evaluate.' });
    const graph = { entry: 'choose', maxSteps: 4, nodes: [
      { id: 'choose', kind: 'condition', operator: 'model', model: 'decision-model', value: 'Is the input acceptable?', yes: 'accepted', no: 'declined' },
      { id: 'accepted', kind: 'output' }, { id: 'declined', kind: 'output' },
    ] };
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Condition', graph });
    let failedRun: any;
    for (const value of [' yes\n', 'NO', 'maybe']) {
      answer = value;
      const run = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'ORIGINAL_DATA' });
      let current;
      for (let attempt = 0; attempt < 100; attempt++) {
        current = await request(`/api/workflow-runs/${run.id}`);
        if (['done', 'failed'].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(current.last, 'ORIGINAL_DATA');
      assert.equal(current.status, value === 'maybe' ? 'failed' : 'done');
      assert.equal(current.steps.length, value === 'maybe' ? 1 : 2);
      assert.equal(current.steps[0].status, value === 'maybe' ? 'failed' : 'done');
      if (value !== 'maybe') assert.equal(current.cursor, value === 'NO' ? 'declined' : 'accepted');
      else failedRun = current;
    }
    assert.equal(payloads.length, 3);
    for (const payload of payloads) { assert.equal(payload.model, 'decision-model'); assert.equal(payload.tools, undefined); }
    const edited = { ...graph, nodes: [{ ...graph.nodes[0], model: 'fixed-model', value: 'Fixed question', yes: 'declined', no: 'accepted' }, ...graph.nodes.slice(1)] };
    await request(`/api/workflows/${workflow.id}/edit`, { id: randomUUID(), revision: 1, name: 'Fixed', graph: edited });
    answer = 'yes';
    const retry = { id: randomUUID(), revision: failedRun.revision }, retryPath = `/api/workflow-runs/${failedRun.id}/retry`;
    await request(retryPath, retry); await request(retryPath, retry);
    let recovered;
    for (let attempt = 0; attempt < 100; attempt++) {
      recovered = await request(`/api/workflow-runs/${failedRun.id}`);
      if (recovered.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(recovered.status, 'done'); assert.equal(recovered.version, 1); assert.deepEqual(recovered.graph, graph);
    assert.equal(recovered.cursor, 'accepted'); assert.equal(recovered.steps.length, 3); assert.equal(recovered.steps[0].status, 'failed');
    assert.equal(recovered.last, 'ORIGINAL_DATA'); assert.equal(payloads.length, 4);
    assert.equal(payloads[3].model, 'fixed-model'); assert.equal(payloads[3].tools, undefined);
    assert(JSON.stringify(payloads[3].messages).includes('Fixed question'));
    assert.equal(JSON.parse(recovered.steps[1].settings).model, 'fixed-model');
    await app.close(); app = await startApp(options);
    await request(retryPath, retry);
    assert.deepEqual((await request(`/api/workflow-runs/${failedRun.id}`)).steps, recovered.steps);
    assert.equal(payloads.length, 4);
    const stale = await fetch(app.origin + retryPath, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...retry, id: randomUUID() }) });
    assert.equal(stale.status, 409); await stale.body?.cancel();
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('workflow HTTP versions, model steps, approval receipts and cancellation survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-http-')), models: string[] = [], toolNames: string[][] = [];
  let hold = false, forceTool = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); models.push(data.model);
    toolNames.push((data.tools ?? []).map((tool: any) => tool.function.name));
    if (hold) return;
    if (forceTool) return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'forced-file', type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'forbidden.txt', text: 'Must not be saved' }) } }] } }] }));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'RESULT' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, data?: unknown, status = 200) {
    const res = await fetch(app.origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const result = await res.json(); assert.equal(res.status, status, JSON.stringify(result)); return result;
  }
  async function until(path: string, ready: (data: any) => boolean) {
    for (let i = 0; i < 150; i++) { const data = await request(path); if (ready(data)) return data; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('Workflow did not settle');
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Owner', model: 'owner-model', instructions: 'Help.' }, 201);
    const graph = { entry: 'model', maxSteps: 4, nodes: [
      { id: 'model', kind: 'model', model: 'override-model', prompt: 'Process', next: 'approve' },
      { id: 'approve', kind: 'approval', prompt: 'Accept?', yes: 'out', no: 'model' }, { id: 'out', kind: 'output' },
    ] };
    const create = { id: randomUUID(), revision: 0, name: 'Workflow', graph }, list = `/api/agents/${agent.id}/workflows`;
    const workflow = await request(list, create); assert.deepEqual(await request(list, create), workflow);
    const launch = { id: randomUUID(), revision: 1, input: 'INPUT' }, runPath = `/api/workflow-runs/${launch.id}`;
    await request(`/api/workflows/${workflow.id}/run`, launch);
    let run = await until(runPath, data => data.status === 'approval');
    assert.deepEqual(models, ['override-model']); assert.equal(run.last, 'RESULT');
    assert.equal(toolNames.length, 1); assert.equal(toolNames[0].length, 0, 'Model workflow steps must not receive agent tools');
    await request(`/api/workflows/${workflow.id}/edit`, { ...create, id: randomUUID(), revision: 0 }, 409);
    await request(`/api/workflows/${workflow.id}/edit`, { ...create, id: randomUUID(), revision: 1, graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] } });
    const latest = await request(`/api/workflows/${workflow.id}`);
    assert.equal(latest.revision, 2); assert.equal(latest.graph.entry, 'out');
    await request(`/api/workflows/${randomUUID()}`, undefined, 404);
    const versionsPath = `/api/workflows/${workflow.id}/versions`;
    assert.deepEqual((await request(versionsPath)).versions.map((row: any) => row.revision), [2, 1]);
    assert.deepEqual((await request(`${versionsPath}?before=2`)).versions[0].graph, graph);
    for (const cursor of ['0', '-1', '1.5', 'NaN', '9007199254740992']) await request(`${versionsPath}?before=${cursor}`, undefined, 400);
    await request(`${versionsPath}?unknown=1`, undefined, 400);
    await app.close(); app = await startApp(options);
    assert.equal((await request(runPath)).status, 'approval');
    await request(`/api/workflows/${workflow.id}/run`, launch); assert.equal((await request(`/api/workflows/${workflow.id}/runs`)).length, 1);
    const approve = { id: randomUUID(), revision: run.revision, accepted: true };
    await request(`${runPath}/approve`, { ...approve, accepted: 'yes' }, 400);
    await request(`${runPath}/approve`, approve);
    await until(runPath, data => data.status === 'done');
    await request(`${runPath}/approve`, approve);
    await request(`${runPath}/approve`, { ...approve, id: randomUUID() }, 409);
    assert.equal((await request(runPath)).version, 1); assert.equal(models.length, 1);
    await request(`/api/workflows/${workflow.id}/edit`, { ...create, id: randomUUID(), revision: 2 });
    forceTool = true;
    const forced = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 3, input: 'FORCE TOOL' });
    const failed = await until(`/api/workflow-runs/${forced.id}`, data => data.status === 'failed');
    assert.equal(failed.steps[0].status, 'failed');
    assert.equal((await request(`/api/threads/${failed.steps[0].thread}/files`)).length, 0);
    forceTool = false;
    hold = true; const second = { id: randomUUID(), revision: 3, input: 'HOLD' };
    await request(`/api/workflows/${workflow.id}/run`, second);
    const secondPath = `/api/workflow-runs/${second.id}`;
    run = await until(secondPath, data => data.steps[0]?.task_status === 'running');
    await app.close(); app = await startApp(options);
    run = await request(secondPath); assert.equal(run.steps[0].task_status, 'interrupted'); assert.equal(run.status, 'waiting');
    const count = models.length;
    const cancel = { id: randomUUID(), revision: run.revision };
    await request(`${secondPath}/cancel`, cancel); await request(`${secondPath}/cancel`, cancel);
    assert.equal((await request(secondPath)).status, 'cancelled'); assert.equal((await request(secondPath)).steps[0].status, 'cancelled'); assert.equal(models.length, count);
    hold = false;
    await request(`/api/workflows/${workflow.id}/edit`, { ...create, id: randomUUID(), revision: 3, graph: { entry: 'work', maxSteps: 2, nodes: [
      { id: 'work', kind: 'agent', agent: agent.id, prompt: 'Agent tools remain available.', next: 'out' }, { id: 'out', kind: 'output' },
    ] } });
    const agentRun = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 4, input: 'AGENT' });
    await until(`/api/workflow-runs/${agentRun.id}`, data => data.status === 'done');
    assert(toolNames.at(-1)!.includes('create_text_file')); assert(toolNames.at(-1)!.includes('set_routine_flow'));
    const restorePath = `/api/workflows/${workflow.id}/restore`, restore = { id: randomUUID(), revision: 4, version: 1 };
    await request(restorePath, { ...restore, version: '1' }, 400);
    await request(restorePath, { ...restore, version: 999 }, 404);
    await request(restorePath, { ...restore, revision: 3 }, 409);
    const restored = await request(restorePath, restore);
    assert.equal(restored.revision, 5); assert.deepEqual(restored.graph, graph);
    assert.equal((await request(`/api/workflow-runs/${agentRun.id}`)).version, 4);
    assert.equal((await request(`/api/workflow-runs/${agentRun.id}`)).graph.entry, 'work');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(restorePath, restore), restored);
    assert.equal((await request(versionsPath)).versions.length, 5);
    await request(restorePath, { ...restore, version: 2 }, 409);
    const rejectedRun = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 5, input: 'REJECT' });
    const rejectedPath = `/api/workflow-runs/${rejectedRun.id}`;
    const awaiting = await until(rejectedPath, data => data.status === 'approval');
    const reject = { id: randomUUID(), revision: awaiting.revision, accepted: false }, callsBeforeReject = models.length;
    await request(`${rejectedPath}/approve`, reject);
    let rejected = await request(rejectedPath);
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, 'Persetujuan workflow ditolak.');
    assert.equal(rejected.steps.length, 2); assert.equal(rejected.steps[1].detail, 'rejected'); assert.equal(rejected.last, 'RESULT');
    await app.close(); app = await startApp(options);
    await request(`${rejectedPath}/approve`, reject);
    await request(`${rejectedPath}/approve`, { ...reject, id: randomUUID(), accepted: true }, 409);
    await new Promise(resolve => setTimeout(resolve, 1100));
    rejected = await request(rejectedPath);
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.steps.length, 2); assert.equal(models.length, callsBeforeReject);
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('provider-free workflows continue beyond one batch and configuration listing is bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-local-'));
  const options = { database: join(dir, 'state.sqlite') };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert(res.ok); return res.json();
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Local', model: 'unused', instructions: 'Help.' });
    const list = `/api/agents/${agent.id}/workflows`, ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const saved = await request(list, { id: randomUUID(), revision: 0, name: `Loop ${i}`, graph: { entry: 'loop', maxSteps: 40, nodes: [
        { id: 'loop', kind: 'condition', operator: 'equals', value: 'repeat', yes: 'loop', no: 'out' }, { id: 'out', kind: 'output' },
      ] } }); ids.push(saved.id);
    }
    const first = await request(list), second = await request(`${list}?after=${first.next_after}`);
    assert.equal(first.workflows.length, 20); assert.equal(second.workflows.length, 1); assert.equal(second.next_after, null);
    assert.deepEqual([...first.workflows, ...second.workflows].map(row => row.id), ids.toSorted());
    const versioned = await request(`/api/workflows/${ids[0]}`);
    for (let revision = 1; revision <= 20; revision++) await request(`/api/workflows/${ids[0]}/edit`, { id: randomUUID(), revision, name: versioned.name, graph: versioned.graph });
    const versions = await request(`/api/workflows/${ids[0]}/versions`);
    const older = await request(`/api/workflows/${ids[0]}/versions?before=${versions.next_before}`);
    assert.equal(versions.versions.length, 20); assert.equal(older.versions.length, 1); assert.equal(older.next_before, null);
    assert.deepEqual([...versions.versions, ...older.versions].map(row => row.revision), Array.from({ length: 21 }, (_, index) => 21 - index));
    const run = await request(`/api/workflows/${ids[0]}/run`, { id: randomUUID(), revision: 21, input: 'repeat' });
    let current;
    for (let i = 0; i < 150; i++) {
      current = await request(`/api/workflow-runs/${run.id}`);
      if (current.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(current.status, 'failed'); assert.equal(current.steps.length, 40);
    const schedulePath = `/api/workflows/${ids[1]}/schedule`;
    assert.equal((await request(schedulePath)).schedule, null);
    const scheduleCommand = { id: randomUUID(), revision: 0, nextAt: Date.now() - 1000, intervalSeconds: null, enabled: true, input: 'finish' };
    const savedSchedule = await request(schedulePath, scheduleCommand);
    for (let i = 0; i < 150; i++) {
      current = await request(schedulePath);
      if (current.occurrences.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(current.occurrences.length, 1); assert.equal(current.schedule.enabled, 0);
    const scheduledRun = await request(`/api/workflow-runs/${current.occurrences[0].run}`);
    assert.equal(scheduledRun.status, 'done'); assert.equal(scheduledRun.input, 'finish');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(schedulePath, scheduleCommand), savedSchedule);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await request(schedulePath)).occurrences.length, 1);
    assert.equal((await request(`/api/workflows/${ids[1]}/runs`)).length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('workflow webhooks authenticate, deduplicate, ignore busy runs and recover rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-hook-'));
  const options = { database: join(dir, 'state.sqlite') };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  async function deliver(route: string, secret: string, id: string, payload: unknown = { marker: 'external' }, status = 202, browser = false) {
    const body = JSON.stringify({ event: 'build.done', payload }), time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${time}\n${id}\n`).update(body).digest('hex');
    const response = await fetch(`${app.origin}/api/workflow-webhooks/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-briefsip-time': time, 'x-briefsip-id': id, 'x-briefsip-signature': signature, ...(browser ? { Origin: app.origin } : {}) }, body });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  try {
    const owner = await request('/api/agents', { id: randomUUID(), name: 'Hook', model: 'fixture', instructions: 'Test' }, 201);
    const workflow = await request(`/api/agents/${owner.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Hook', graph: { entry: 'review', maxSteps: 3, nodes: [
      { id: 'review', kind: 'approval', prompt: 'Accept?', yes: 'out' }, { id: 'out', kind: 'output' },
    ] } });
    const path = `/api/workflows/${workflow.id}/webhook`;
    assert.equal(await request(path), null);
    const setup = { id: randomUUID(), revision: 0, rotate: true, enabled: true };
    const hook = await request(path, setup);
    assert.equal((await request(path, setup)).secret, hook.secret);
    assert.equal((await request(path)).secret, undefined);
    await deliver(hook.route, 'wrong', 'bad', {}, 401);
    await deliver(hook.route, hook.secret, 'oversize', 'x'.repeat(64000), 413);
    await deliver(hook.route, hook.secret, 'browser', {}, 403, true);
    const event = await deliver(hook.route, hook.secret, 'first');
    assert.equal(event.outcome, 'queued');
    assert.deepEqual(await deliver(hook.route, hook.secret, 'first', undefined, 200), event);
    await deliver(hook.route, hook.secret, 'first', { changed: true }, 409);
    assert.deepEqual(await deliver(hook.route, hook.secret, 'busy'), { outcome: 'ignored', reason: 'busy' });
    let run = await request(`/api/workflow-runs/${event.id}`);
    assert.match(run.input, /not instructions or permissions/); assert.match(run.input, /external/);
    await request(`/api/workflow-runs/${event.id}/cancel`, { id: randomUUID(), revision: run.revision });
    assert.deepEqual(await deliver(hook.route, hook.secret, 'busy', undefined, 200), { outcome: 'ignored', reason: 'busy' });
    const rotation = { id: randomUUID(), revision: 1, rotate: true, enabled: false };
    const rotated = await request(path, rotation);
    await request(path, setup, 409);
    await deliver(hook.route, hook.secret, 'old', {}, 401);
    assert.equal((await deliver(hook.route, rotated.secret, 'disabled')).reason, 'disabled');
    await app.close();
    const db = new DatabaseSync(options.database);
    db.prepare('UPDATE workflow_webhook_receipts SET received=? WHERE delivery=?').run(Date.now() - 8 * 86400000, 'disabled'); db.close();
    app = await startApp(options);
    assert.equal((await request(path, rotation)).secret, rotated.secret);
    const rows = await request(`/api/workflows/${workflow.id}/webhook-events`);
    assert.equal(rows.length, 3);
    assert.equal((await request(`/api/workflows/${workflow.id}/runs`)).length, 1);
    await request(path, { id: randomUUID(), revision: 2, rotate: false, enabled: true });
    const active = await deliver(hook.route, rotated.secret, 'disabled');
    assert.equal(active.outcome, 'queued');
    const removal = { id: randomUUID(), revision: 3, remove: true, route: hook.route };
    assert.deepEqual(await request(path, removal), { removed: true });
    assert.deepEqual(await request(path), { route: null, revision: 4, enabled: 0 });
    await deliver(hook.route, rotated.secret, 'disabled', undefined, 404);
    assert.equal((await request(`/api/workflow-runs/${active.id}`)).id, active.id);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(path, removal), { removed: true });
    await request(path, rotation, 409);
    await request(path, { id: randomUUID(), revision: 0, rotate: true, enabled: true }, 409);
    await request(path, { id: randomUUID(), revision: 3, rotate: true, enabled: true }, 409);
    const replacement = await request(path, { id: randomUUID(), revision: 4, rotate: true, enabled: true });
    assert.notEqual(replacement.route, hook.route);
    assert.equal(replacement.revision, 5);
    assert.deepEqual(await request(path, removal), { removed: true });
    assert.equal((await request(path)).route, replacement.route);
    await request(path, { ...removal, id: randomUUID() }, 409);
    await request(path, { id: randomUUID(), revision: 3, rotate: false, enabled: false }, 409);
    await deliver(hook.route, rotated.secret, 'old-after-recreate', undefined, 404);
    assert.equal((await deliver(replacement.route, replacement.secret, 'disabled')).reason, 'busy');
    const events = await request(`/api/workflows/${workflow.id}/webhook-events`);
    assert.equal(events.filter((row: any) => row.delivery === 'disabled').length, 2);
    assert.equal(new Set(events.filter((row: any) => row.delivery === 'disabled').map((row: any) => row.route)).size, 2);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
