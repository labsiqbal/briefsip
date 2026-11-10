import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
  const app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Condition', model: 'owner', instructions: 'Evaluate.' });
    const graph = { entry: 'choose', maxSteps: 2, nodes: [
      { id: 'choose', kind: 'condition', operator: 'model', model: 'decision-model', value: 'Is the input acceptable?', yes: 'accepted', no: 'declined' },
      { id: 'accepted', kind: 'output' }, { id: 'declined', kind: 'output' },
    ] };
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Condition', graph });
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
    }
    assert.equal(payloads.length, 3);
    for (const payload of payloads) { assert.equal(payload.model, 'decision-model'); assert.equal(payload.tools, undefined); }
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
