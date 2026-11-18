import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { startApp } from './test-bridge.ts';
import { restoreWorkspace } from './backup.ts';
import { validateWorkflow, validateWorkflowDraft, workflowEdges, workflowTransition } from './workflows.ts';

test('event wait validates bounded graph settings and preserves draft links', () => {
  const wait = { id: 'wait', kind: 'wait' as const, event: 'ready', timeoutSeconds: 60, next: 'out' };
  const graph = { entry: 'wait', maxSteps: 3, nodes: [wait, { id: 'out', kind: 'output' }] };
  assert.deepEqual(validateWorkflow(graph, new Set()).nodes[0], wait);
  assert.deepEqual(workflowEdges(wait), ['out']); assert.equal(workflowTransition(wait, ''), 'out');
  for (const timeoutSeconds of [0, -1, .5, 604801, NaN, '60', null]) assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...wait, timeoutSeconds }, graph.nodes[1]] }, new Set()));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...wait, event: '' }, graph.nodes[1]] }, new Set()));
  assert.equal(validateWorkflowDraft({ ...graph, nodes: [{ ...wait, event: '', next: '' }, graph.nodes[1]] }).nodes[0].kind, 'wait');
  assert.equal(validateWorkflowDraft({ ...graph, nodes: [{ ...wait, timeoutSeconds: 0 }, graph.nodes[1]] }).nodes[0].kind, 'wait');
});

test('signed workflow events are scoped, durable, once-only, expiring and cancel-safe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-waits-'));
  const calls: string[] = [];
  const provider = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; calls.push(raw); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Processed event.' } }] })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options), restored: Awaited<ReturnType<typeof startApp>> | undefined;
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  async function state(id: string, status: string) {
    for (let attempt = 0; attempt < 200; attempt++) { const result = await request(`/api/workflow-runs/${id}`); if (result.status === status) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail(`run did not reach ${status}`);
  }
  async function send(path: string, secret: string, body: string, id = randomUUID(), expected = 200, time = Math.floor(Date.now() / 1000)) {
    const signature = createHmac('sha256', secret).update(`${time}\n${id}\n`).update(body).digest('hex');
    const response = await fetch(app.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': String(time), 'X-Briefsip-Id': id, 'X-Briefsip-Signature': signature }, body });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Events', model: 'fixture', instructions: 'Process' }, 201);
    const graph = { entry: 'event', maxSteps: 4, nodes: [{ id: 'event', kind: 'wait', event: 'invoice.paid', timeoutSeconds: 3600, next: 'process' }, { id: 'process', kind: 'agent', agent: agent.id, prompt: 'Read event', next: 'out' }, { id: 'out', kind: 'output' }] };
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), name: 'Events', revision: 0, graph });
    const run = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Invoice' });
    const waiting = await state(run.id, 'waiting'); assert.equal(waiting.steps.length, 1); assert.equal(calls.length, 0);
    const path = `/api/workflow-waits/${run.id}/1`, connection = await request(path);
    assert.equal(connection.event, 'invoice.paid'); assert.equal(connection.secret.length, 64);
    assert(!JSON.stringify(waiting).includes(connection.secret));
    const disclosed = await fetch(app.origin + path);
    assert.equal(disclosed.headers.get('cache-control'), 'no-store');
    assert.equal(disclosed.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(disclosed.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(disclosed.headers.get('access-control-allow-origin'), null);
    await disclosed.arrayBuffer();
    const foreign = await fetch(app.origin + path, { headers: { Origin: 'https://foreign.test' } }); assert.equal(foreign.status, 403);
    for (const [name, value] of [['Origin', 'null'], ['Sec-Fetch-Site', 'cross-site']]) {
      const headers = { [name]: value };
      const denied = await fetch(app.origin + path, { headers }); assert.equal(denied.status, 403, JSON.stringify(headers));
      assert(!(await denied.text()).includes(connection.secret));
    }
    const wrongHost = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = httpRequest(app.origin + path, { headers: { Host: 'attacker.test' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject);
      }); req.on('error', reject); req.end();
    });
    assert.equal(wrongHost.status, 403); assert(!wrongHost.body.includes(connection.secret));
    const body = JSON.stringify({ event: 'invoice.paid', payload: { invoice: 'SYNTHETIC-123' } }), delivery = randomUUID();
    const signatureTime = String(Math.floor(Date.now() / 1000)), signature = createHmac('sha256', connection.secret).update(`${signatureTime}\n${delivery}\n`).update(body).digest('hex');
    const signedHeaders = { 'Content-Type': 'application/json', 'X-Briefsip-Time': signatureTime, 'X-Briefsip-Id': delivery, 'X-Briefsip-Signature': signature };
    for (const headers of [{ ...signedHeaders, Origin: app.origin }, { ...signedHeaders, Origin: 'null' }, { ...signedHeaders, 'Content-Type': 'text/plain' }, { ...signedHeaders, 'X-Briefsip-Signature': signature.slice(1) }, { ...signedHeaders, 'X-Briefsip-Id': 'other-delivery' }]) {
      const denied = await fetch(app.origin + path, { method: 'POST', headers, body }); assert([401, 403].includes(denied.status));
      assert(!(await denied.text()).includes(connection.secret));
    }
    await send(path, connection.secret, JSON.stringify({ event: 'invoice.paid', payload: 'x'.repeat(65536) }), randomUUID(), 413);
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    const invalidSignature = createHmac('sha256', connection.secret).update(`${signatureTime}\n${delivery}\n`).update(invalidUtf8).digest('hex');
    const invalidResponse = await fetch(app.origin + path, { method: 'POST', headers: { ...signedHeaders, 'X-Briefsip-Signature': invalidSignature }, body: invalidUtf8 });
    assert.equal(invalidResponse.status, 400); await invalidResponse.arrayBuffer();
    await send(path, 'wrong', body, randomUUID(), 401);
    await send(path, connection.secret, body, randomUUID(), 401, Math.floor(Date.now() / 1000) - 301);
    await send(path, connection.secret, JSON.stringify({ event: 'other' }), randomUUID(), 409);
    await send(path, connection.secret, '{}', randomUUID(), 400);
    assert.equal((await request(`/api/workflow-runs/${run.id}`)).status, 'waiting');
    const other = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Other' });
    await state(other.id, 'waiting'); const otherPath = `/api/workflow-waits/${other.id}/1`;
    await send(otherPath, connection.secret, body, randomUUID(), 401);
    await app.close(); app = await startApp(options);
    const reopened = await request(path); assert.equal(reopened.secret, connection.secret); assert.equal(reopened.deadline, connection.deadline);
    const [first, duplicate] = await Promise.all([send(path, connection.secret, body, delivery), send(path, connection.secret, body, delivery)]);
    assert.deepEqual(duplicate, first);
    const done = await state(run.id, 'done'); assert.equal(done.last, 'Processed event.'); assert.equal(calls.length, 1); assert(calls[0].includes('SYNTHETIC-123')); assert(!calls[0].includes(connection.secret));
    assert.deepEqual(await send(path, connection.secret, body, delivery), first);
    await send(path, connection.secret, JSON.stringify({ event: 'invoice.paid', payload: 2 }), delivery, 409);
    await request(path, undefined, 404);
    const otherConnection = await request(otherPath), beforeCancel = await request(`/api/workflow-runs/${other.id}`);
    await request(`/api/workflow-runs/${other.id}/cancel`, { id: randomUUID(), revision: beforeCancel.revision });
    await send(otherPath, otherConnection.secret, body, randomUUID(), 409);
    await request(otherPath, undefined, 404);
    const short = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Expire', graph: { entry: 'event', maxSteps: 2, nodes: [{ id: 'event', kind: 'wait', event: 'ready', timeoutSeconds: 1, next: 'out' }, { id: 'out', kind: 'output' }] } });
    const expiring = await request(`/api/workflows/${short.id}/run`, { id: randomUUID(), revision: 1, input: '' });
    await state(expiring.id, 'waiting'); const expiringPath = `/api/workflow-waits/${expiring.id}/1`, expiringConnection = await request(expiringPath);
    await app.close(); await new Promise(resolve => setTimeout(resolve, 1100)); app = await startApp(options);
    const expired = await state(expiring.id, 'failed'); assert.equal(expired.steps[0].status, 'failed'); assert.match(expired.error, /Event wait timed out/);
    await send(expiringPath, expiringConnection.secret, JSON.stringify({ event: 'ready' }), randomUUID(), 409);
    const loopGraph = { entry: 'event', maxSteps: 6, nodes: [{ id: 'event', kind: 'wait', event: 'tick', timeoutSeconds: 60, next: 'check' }, { id: 'check', kind: 'condition', operator: 'contains', value: '"stop":true', yes: 'out', no: 'event' }, { id: 'out', kind: 'output' }] };
    const looping = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Loop', graph: loopGraph });
    const loop = await request(`/api/workflows/${looping.id}/run`, { id: randomUUID(), revision: 1, input: '' }); await state(loop.id, 'waiting');
    const loopPath = `/api/workflow-waits/${loop.id}/1`, loopConnection = await request(loopPath), loopDelivery = randomUUID(), loopBody = JSON.stringify({ event: 'tick', payload: { stop: false } });
    const loopReceipt = await send(loopPath, loopConnection.secret, loopBody, loopDelivery);
    const secondWait = await state(loop.id, 'waiting'); assert.equal(secondWait.steps.at(-1).seq, 3);
    const secondPath = `/api/workflow-waits/${loop.id}/3`, secondConnection = await request(secondPath); assert.notEqual(loopConnection.secret, secondConnection.secret);
    assert.deepEqual(await send(loopPath, loopConnection.secret, loopBody, loopDelivery), loopReceipt);
    assert.equal((await request(`/api/workflow-runs/${loop.id}`)).steps.length, 3);
    await send(secondPath, loopConnection.secret, loopBody, randomUUID(), 401);
    await send(secondPath, secondConnection.secret, JSON.stringify({ event: 'tick', payload: { stop: true } }));
    const loopDone = await state(loop.id, 'done'); assert.equal(loopDone.steps.length, 5);
    assert.equal(calls.length, 1);
    const active = await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Backup' }); await state(active.id, 'waiting');
    const activePath = `/api/workflow-waits/${active.id}/1`, activeConnection = await request(activePath);
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) }); assert.equal(backup.status, 200);
    const backupPath = join(directory, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    restored = await startApp({ database: restoreWorkspace(backupPath, join(directory, 'restored.sqlite')) });
    assert.equal((await fetch(restored.origin + activePath)).status, 404);
    assert.equal((await (await fetch(restored.origin + `/api/workflow-runs/${active.id}`)).json()).status, 'failed');
    assert.equal(calls.length, 1);
    assert(activeConnection.secret);
  } finally { await restored?.close(); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
