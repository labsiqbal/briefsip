import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from './test-bridge.ts';

test('workflow SIGKILL preserves uncertain step without replay across two restarts', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workflow-crash-'));
  let calls = 0, accepted!: () => void;
  const providerAccepted = new Promise<void>(resolve => { accepted = resolve; });
  const provider = createServer(async req => { for await (const _chunk of req) { /* Consume the complete request before killing the client. */ } calls++; accepted(); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {startApp} from ${JSON.stringify(new URL('./test-bridge.ts', import.meta.url).href)}; const app=await startApp(JSON.parse(process.env.BRIEFSIP_TEST_OPTIONS)); console.log(app.origin);`],
  { env: { ...process.env, BRIEFSIP_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); child.stderr.resume();
  const output = createInterface({ input: child.stdout });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    let [origin] = await Promise.race([once(output, 'line'), exited.then(() => { throw Error('Fixture process exited before startup'); })]);
    async function request(path: string, body?: unknown) {
      const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
    }
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Crash workflow', model: 'fixture', instructions: 'Execute.' });
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), name: 'Crash probe', revision: 0, graph: { entry: 'work', maxSteps: 3, nodes: [
      { id: 'work', kind: 'agent', agent: agent.id, prompt: 'Hold until cancelled.', next: 'approve' },
      { id: 'approve', kind: 'approval', prompt: 'Continue?', yes: 'out', no: 'out' }, { id: 'out', kind: 'output' },
    ] } });
    const command = { id: randomUUID(), revision: 1, input: 'Synthetic input' }, path = `/api/workflow-runs/${command.id}`;
    await request(`/api/workflows/${workflow.id}/run`, command); await providerAccepted;
    child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    let turn: string | undefined;
    for (let restart = 0; restart < 2; restart++) {
      app = await startApp(options); origin = app.origin;
      const run = await request(path);
      assert.equal(run.status, 'waiting'); assert.equal(run.steps.length, 1);
      assert.equal(run.steps[0].task_status, 'interrupted'); assert.equal(run.steps[0].status, 'waiting');
      if (turn) assert.equal(run.steps[0].turn, turn); else turn = run.steps[0].turn;
      await request(`/api/workflows/${workflow.id}/run`, command);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(calls, 1); assert.equal((await request(path)).steps.length, 1);
      assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
      const usage = await request('/api/usage');
      assert.equal(usage.summary.calls, 1); assert.equal(usage.summary.interrupted, 1);
      assert.equal(usage.summary.total_tokens, null); assert.equal(usage.calls[0].turn, turn);
      if (restart === 1) {
        await request(`${path}/cancel`, { id: randomUUID(), revision: run.revision });
        assert.equal((await request(path)).status, 'cancelled');
      }
      await app.close(); app = undefined;
    }
  } finally {
    output.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited;
    await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL after delegated provider acceptance does not replay parent or child', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-crash-'));
  let calls = 0, accepted!: () => void;
  const childAccepted = new Promise<void>(resolve => { accepted = resolve; });
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls++;
    if (data.messages.at(-1).content === 'child') { accepted(); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'child-call', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ recipient: data.tools[0].function.parameters.properties.recipient.enum[0], task: 'child' }) } }],
    } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  const source = new URL('./test-bridge.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {startApp} from ${JSON.stringify(source)}; const app=await startApp(JSON.parse(process.env.BRIEFSIP_TEST_OPTIONS)); console.log(app.origin);`],
  { env: { ...process.env, BRIEFSIP_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stderr.resume();
  const output = createInterface({ input: child.stdout });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const [origin] = await Promise.race([once(output, 'line'), exited.then(() => { throw Error('Fixture process exited before startup'); })]);
    async function post(path: string, data: unknown) {
      const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      assert(response.ok); return response.json();
    }
    const alpha = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Alpha', model: 'fixture', instructions: 'Delegate.' });
    const beta = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Beta', model: 'fixture', instructions: 'Execute.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Crash check', instructions: 'Coordinate.', members: [alpha.id, beta.id], lead: alpha.id });
    const path = `/api/channels/${channel.id}/turns`, id = randomUUID();
    await post(path, { id, text: 'root', recipient: alpha.id }); await childAccepted;
    child.kill('SIGKILL');
    assert.equal((await exited)[1], 'SIGKILL');
    app = await startApp(options);
    const rows = await (await fetch(app.origin + path)).json();
    assert.equal(rows.length, 2);
    const parent = rows.find((row: { id: string }) => row.id === id);
    const delegated = rows.find((row: { parent: string }) => row.parent === id);
    assert.equal(parent.status, 'interrupted'); assert.equal(delegated.status, 'interrupted');
    assert.equal(parent.agent, alpha.id); assert.equal(delegated.agent, beta.id);
    assert.equal(parent.coordination.length, 1); assert.equal(parent.coordination[0].child, delegated.id);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(calls, 2);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (app) await app.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
