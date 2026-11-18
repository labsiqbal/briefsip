import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';

test('routine flow dispatch joins once, snapshots edits and recovers interrupted steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-flow-http-')), calls: { model: string; prompt: string }[] = [];
  let hold = false, failC = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls.push({ model: data.model, prompt: data.messages.at(-1).content });
    if (hold && data.model === 'c') return;
    if (failC && data.model === 'c') return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'report_failure', arguments: JSON.stringify({ reason: 'C cannot complete its step.' }) } }] } }] }));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `${data.model} result` + (data.model === 'd' ? 'x'.repeat(4000) : '') } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  async function until<T>(read: () => Promise<T>, ready: (data: T) => boolean) {
    for (let i = 0; i < 150; i++) { const data = await read(); if (ready(data)) return data; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('Flow state did not settle');
  }
  try {
    const agents = [];
    for (const model of ['a','b','c','d']) agents.push(await request('/api/agents', { runtime: 'api', id: randomUUID(), name: model, model, instructions: `${model} instruction` }, 201));
    const [a,b,c,d] = agents;
    const routine = await request(`/api/agents/${a.id}/routines`, { id: randomUUID(), name: 'Fan-in', prompt: 'Root job', nextAt: Date.now() + 3600000, intervalSeconds: null, enabled: false });
    const settings = `/api/routines/${routine.id}/flow`, runs = `/api/routines/${routine.id}/flow-runs`;
    assert.equal((await request(settings)).revision, 0);
    const links = [{ from: a.id, to: b.id }, { from: a.id, to: c.id }, { from: b.id, to: d.id }, { from: c.id, to: d.id }];
    const command = { id: randomUUID(), revision: 0, links };
    const saved = await request(settings, command); assert.deepEqual(await request(settings, command), saved);
    await request(settings, { ...command, links: [] }, 409);
    await request(settings, { id: randomUUID(), revision: 1, links: [{ from: a.id, to: 'missing' }] }, 400);
    await request(settings, { id: randomUUID(), revision: 1, links: [...links, { from: d.id, to: b.id }] }, 400);
    failC = true;
    const runRequest = { id: randomUUID(), revision: routine.revision };
    await request(`/api/routines/${routine.id}/test`, runRequest);
    const completed = await until(() => request(runs), data => data[0]?.steps.every((step: { status: string }) => ['done','failed','skipped'].includes(step.status)));
    assert.equal(completed.length, 1);
    const merge = calls.filter(call => call.model === 'd'); assert.equal(merge.length, 1); assert(merge[0].prompt.includes('b result')); assert(merge[0].prompt.includes('C cannot complete its step.'));
    const cStep = completed[0].steps.find((step: { agent: string }) => step.agent === c.id); assert.equal(cStep.status, 'failed');
    const dStep = completed[0].steps.find((step: { agent: string }) => step.agent === d.id);
    assert.equal(dStep.result.length, 1000); assert(dStep.result_length > 4000);
    assert((await request(`/api/threads/${dStep.thread}/turns`))[0].reply.length > 4000);
    const cTurn = (await request(`/api/threads/${cStep.thread}/turns`))[0];
    await request(`/api/threads/${cStep.thread}/turns/${cTurn.id}/resume`, { id: randomUUID(), revision: cTurn.revision, acknowledgeUncertain: true }, 409);
    for (const agent of agents) assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
    await app.close(); app = await startApp(options);
    await request(`/api/routines/${routine.id}/test`, runRequest); assert.equal((await request(runs)).length, 1); assert.equal(calls.length, 4);
    failC = false; hold = true;
    const next = await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision });
    await until(() => request(runs), data => data[0]?.steps.find((step: { agent: string }) => step.agent === c.id)?.task_status === 'running');
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision }, 409);
    const due = await request(`/api/routines/${routine.id}/edit`, { id: randomUUID(), revision: routine.revision, name: routine.name, prompt: routine.prompt, nextAt: Date.now() - 1, intervalSeconds: null, enabled: true });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await request(`/api/routines/${routine.id}/runs`)).length, 2, 'A due schedule must wait for its active downstream step');
    const disabled = await request(`/api/routines/${routine.id}/edit`, { id: randomUUID(), revision: due.revision, name: routine.name, prompt: routine.prompt, nextAt: due.next_at, intervalSeconds: null, enabled: false });
    routine.revision = disabled.revision;
    await request(settings, { id: randomUUID(), revision: 1, links: [] });
    await app.close(); hold = false; app = await startApp(options);
    const interrupted = (await request(runs)).find((run: { root_turn: string }) => run.root_turn === next.turn);
    const currentC = interrupted.steps.find((step: { agent: string }) => step.agent === c.id);
    assert.equal(currentC.task_status, 'interrupted'); assert.equal(currentC.status, 'queued');
    assert.equal(interrupted.steps.find((step: { agent: string }) => step.agent === d.id).status, 'waiting');
    const currentTurn = (await request(`/api/threads/${currentC.thread}/turns`))[0];
    await request(`/api/threads/${currentC.thread}/turns/${currentTurn.id}/resume`, { id: randomUUID(), revision: currentTurn.revision, acknowledgeUncertain: true });
    await until(() => request(runs), data => data.find((run: { root_turn: string }) => run.root_turn === next.turn)?.steps.every((step: { status: string }) => step.status === 'done'));
    assert.equal(calls.filter(call => call.model === 'd').length, 2);
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision });
    await until(() => request(`/api/routines/${routine.id}/runs`), data => data[0]?.status === 'done');
    assert.equal((await request(runs)).length, 2); assert.equal(calls.filter(call => call.model === 'd').length, 2);
    const configured = [routine.id];
    for (let i = 0; i < 20; i++) {
      const item = await request(`/api/agents/${b.id}/routines`, { id: randomUUID(), name: `Directory ${i}`, prompt: 'Not executed', nextAt: Date.now() + 3600000, intervalSeconds: null, enabled: false });
      await request(`/api/routines/${item.id}/flow`, { id: randomUUID(), revision: 0, links: [{ from: b.id, to: c.id }] });
      configured.push(item.id);
    }
    const first = await request('/api/flows'), second = await request(`/api/flows?after=${first.next_after}`);
    assert.equal(first.flows.length, 20); assert.equal(second.flows.length, 1); assert.equal(second.next_after, null);
    assert.deepEqual([...first.flows, ...second.flows].map(row => row.id), configured.sort());
    assert(first.flows.every((row: { owner_name: string; graph: { root: string }; agent: string; flow_revision: number }) => row.owner_name && row.graph.root === row.agent && row.flow_revision >= 1));
    await request('/api/flows?after=invalid', undefined, 400);
    await request('/api/flows?extra=1', undefined, 400);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
