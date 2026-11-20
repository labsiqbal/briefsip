import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFlow } from './src/flows.ts';
import { startApp } from './test-bridge.ts';

test('routine flow graph rejects cycles, foreign agents and disconnected branches', () => {
  const agents = new Set(['a', 'b', 'c', 'd']);
  assert.deepEqual(validateFlow([], 'a', agents), { root: 'a', nodes: ['a'], links: [] });
  const graph = validateFlow([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }], 'a', agents);
  assert.deepEqual(graph.nodes, ['a', 'b', 'c', 'd']);
  for (const links of [null, [{ from: 'a', to: 'x' }], [{ from: 'a', to: 'a' }], [{ from: 'b', to: 'a' }], [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }], [{ from: 'c', to: 'd' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }], [{ from: 'a', to: 'b', unexpected: true }]]) assert.throws(() => validateFlow(links, 'a', agents));
  const many = new Set(Array.from({ length: 33 }, (_, i) => String(i)));
  assert.throws(() => validateFlow([...many].slice(1).map(to => ({ from: '0', to })), '0', many), /32/);
});

test('routine flow fan-in waits for every input and settles all-failed branches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-flow-fan-in-'));
  let releaseRoot!: () => void, releaseBranch!: () => void;
  const rootGate = new Promise<void>(resolve => { releaseRoot = resolve; });
  const branchGate = new Promise<void>(resolve => { releaseBranch = resolve; });
  const calls: { model: string; prompt: string }[] = [];
  let failBoth = false;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { model, messages } = JSON.parse(raw);
    calls.push({ model, prompt: messages.at(-1).content });
    if (model === 'a') await rootGate;
    if (model === 'c') await branchGate;
    const fails = model === 'c' || (model === 'b' && failBoth);
    const message = fails ? { tool_calls: [{
      id: randomUUID(), type: 'function',
      function: { name: 'report_failure', arguments: JSON.stringify({ reason: `${model} failed` }) },
    }] } : { content: `${model} result` };
    res.end(JSON.stringify({ choices: [{ finish_reason: fails ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  type Step = { agent: string; status: string; task_status: string | null; result: string; thread: string | null };
  type Run = { root_turn: string; steps: Step[] };
  async function request(path: string, body?: unknown, status = 200) {
    assert(app);
    const response = await fetch(app.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  try {
    app = await startApp(options);
    const agents = [];
    for (const model of ['a', 'b', 'c', 'd']) {
      const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: model, model, instructions: 'Run a flow step.' }, 201);
      agents.push(agent.id as string);
    }
    const [a, b, c, d] = agents;
    const routine = await request(`/api/agents/${a}/routines`, {
      id: randomUUID(), name: 'Fan-in', prompt: 'Root job', nextAt: Date.now() + 3600000, intervalSeconds: null, enabled: false,
    });
    await request(`/api/routines/${routine.id}/flow`, {
      id: randomUUID(), revision: 0, links: [{ from: a, to: b }, { from: a, to: c }, { from: b, to: d }, { from: c, to: d }],
    });
    const path = `/api/routines/${routine.id}/flow-runs`;
    const start = async () => (await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision })).turn;
    async function until(id: string, ready: (steps: Step[]) => boolean) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const run = (await request(path) as Run[]).find(run => run.root_turn === id);
        if (run && ready(run.steps)) return run.steps;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Flow state did not settle');
    }
    function inputs(model: string) {
      const prompt = calls.find(call => call.model === model)?.prompt;
      const line = prompt?.split('\n').find(line => line.startsWith('[{'));
      assert(line, prompt);
      return (JSON.parse(line) as { agent: string; status: string; text: string }[]).map(({ agent, status, text }) => ({ agent, status, text }));
    }
    const first = await start();
    const initial = await until(first, steps => steps.some(step => step.agent === a && step.task_status === 'running'));
    const downstream = initial.filter(step => step.agent !== a);
    assert.deepEqual(downstream.map(step => step.agent), [b, c].sort().concat(d));
    assert(downstream.every(step => step.status === 'waiting' && step.thread === null));
    assert(calls.every(call => call.model === 'a'));
    releaseRoot();
    const active = await until(first, steps => steps.some(step => step.agent === b && step.status === 'done')
      && steps.some(step => step.agent === c && step.task_status === 'running')
      && calls.some(call => call.model === 'c'));
    for (const model of ['b', 'c']) assert.deepEqual(inputs(model), [{ agent: a, status: 'done', text: 'a result' }]);
    assert.equal(active.find(step => step.agent === d)?.status, 'waiting');
    assert(!calls.some(call => call.model === 'd'));
    releaseBranch();
    await until(first, steps => steps.some(step => step.agent === d && step.status === 'done'));
    assert.deepEqual(inputs('d'), [{ agent: b, status: 'done', text: 'b result' }, { agent: c, status: 'failed', text: 'c failed' }]);

    failBoth = true;
    const second = await start();
    const skipped = await until(second, steps => steps.some(step => step.agent === d && step.status === 'skipped'));
    assert.deepEqual(Object.fromEntries(skipped.map(step => [step.agent, step.status])), { [a]: 'done', [b]: 'failed', [c]: 'failed', [d]: 'skipped' });
    assert.match(skipped.find(step => step.agent === d)!.result, /No successful input/);
    assert.equal(skipped.find(step => step.agent === d)?.thread, null);
    await app.close();
    app = await startApp(options);
    assert.deepEqual(await until(second, () => true), skipped);
    assert.deepEqual(calls.map(call => call.model).sort(), ['a', 'a', 'b', 'b', 'c', 'c', 'd']);
  } finally {
    releaseRoot();
    releaseBranch();
    await app?.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
