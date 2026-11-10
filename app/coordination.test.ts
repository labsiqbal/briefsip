import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from './server.ts';

test('coordination: durable delegation, transfer, cancellation, rejection and recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-coordination-'));
  const calls: { model: string; task: string }[] = [];
  let releaseSavedChild: (() => void) | undefined;
  let parallelCount = 0;
  let releaseParallel!: () => void;
  const parallelGate = new Promise<void>(resolve => { releaseParallel = resolve; });
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    const task = data.messages.findLast((m: { role: string }) => m.role === 'user').content;
    calls.push({ model: data.model, task });
    const toolResult = data.messages.at(-1).role === 'tool' ? JSON.parse(data.messages.at(-1).content) : null;
    if (task === 'child-hang' || task === 'block-parent') return;
    if (task === 'saved-child') await new Promise<void>(resolve => { releaseSavedChild = resolve; });
    if (task === 'parallel-delegate' && !toolResult) { parallelCount++; if (parallelCount === 4) releaseParallel(); await parallelGate; }
    const shouldCall = !toolResult && ['save-result', 'parallel-delegate', 'nested', 'nested-child', 'delegate', 'transfer', 'cancel-tree', 'restart-tree', 'outsider', 'cycle'].includes(task) || task === 'cycle';
    if (shouldCall) {
      const recipient = task === 'outsider' ? randomUUID() : data.tools[0].function.parameters.properties.recipient.enum[0];
      const name = task === 'transfer' || task === 'cycle' ? 'transfer_task' : 'delegate_task';
      const childTask = ['cancel-tree', 'restart-tree'].includes(task) ? 'child-hang' : task === 'save-result' ? 'saved-child' : task === 'nested' ? 'nested-child' : 'child-work';
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify({ recipient, task: childTask }) } }] } }] }));
    } else {
      const content = toolResult ? `parent:${toolResult.reply ?? toolResult.status}` : 'child-result';
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function post(path: string, body: unknown) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `HTTP ${response.status}`); return response.json();
  }
  async function rows(path: string) { return (await fetch(app.origin + path)).json(); }
  async function waitTurn(path: string, id: string, status: string) {
    for (let i = 0; i < 150; i++) {
      const turn = (await rows(path)).find((row: { id: string }) => row.id === id);
      if (turn?.status === status) return turn;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${status}`);
  }
  try {
    const alpha = await post('/api/agents', { id: randomUUID(), name: 'Alpha', model: 'alpha', instructions: 'Coordinate.' });
    const beta = await post('/api/agents', { id: randomUUID(), name: 'Beta', model: 'beta', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Collaborate.', members: [alpha.id, beta.id], lead: alpha.id });
    const path = `/api/channels/${channel.id}/turns`;
    const delegated = { id: randomUUID(), text: 'delegate', recipient: alpha.id };
    await post(path, delegated); await post(path, delegated);
    const parent = await waitTurn(path, delegated.id, 'done');
    assert.equal(parent.agent, alpha.id); assert.equal(parent.reply, 'parent:child-result');
    let child = (await rows(path)).find((row: { parent: string }) => row.parent === parent.id);
    assert.equal(child.agent, beta.id); assert.equal(child.status, 'done');
    assert.equal((await rows(path)).length, 2);
    assert.equal(calls.filter(call => call.task === 'child-work').length, 1);
    assert.deepEqual(await rows(`/api/agents/${beta.id}/turns`), []);
    const transfer = { id: randomUUID(), text: 'transfer', recipient: alpha.id };
    await post(path, transfer);
    const moved = await waitTurn(path, transfer.id, 'done');
    assert.equal(moved.agent, beta.id); assert.equal(moved.reply, 'parent:transferred');
    assert.equal((await rows(path)).length, 3);
    await post(path, transfer);
    assert.equal((await rows(path)).length, 3);
    const outsider = { id: randomUUID(), text: 'outsider', recipient: alpha.id };
    const before = calls.length; await post(path, outsider);
    assert.match((await waitTurn(path, outsider.id, 'failed')).error, /anggota/);
    assert.equal(calls.length, before + 1);
    const cycle = { id: randomUUID(), text: 'cycle', recipient: alpha.id };
    await post(path, cycle);
    assert.match((await waitTurn(path, cycle.id, 'failed')).error, /Batas koordinasi/);
    const cancellation = { id: randomUUID(), text: 'cancel-tree', recipient: alpha.id };
    await post(path, cancellation);
    for (let i = 0; i < 100; i++) {
      child = (await rows(path)).find((row: { parent: string }) => row.parent === cancellation.id);
      if (child?.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(child.status, 'running');
    await post(`${path}/${cancellation.id}/cancel`, { id: randomUUID() });
    const cancelledParent = await waitTurn(path, cancellation.id, 'cancelled');
    assert.match(cancelledParent.error, /sudah dikirim/);
    assert(!cancelledParent.error.includes('sebelum dikirim'));
    await waitTurn(path, child.id, 'cancelled');
    assert.equal((await waitTurn(path, parent.id, 'done')).reply, 'parent:child-result');
    const restart = { id: randomUUID(), text: 'restart-tree', recipient: alpha.id };
    await post(path, restart);
    for (let i = 0; i < 100; i++) {
      child = (await rows(path)).find((row: { parent: string }) => row.parent === restart.id);
      if (child?.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(child.status, 'running');
    await app.close(); app = await startApp(options);
    await waitTurn(path, restart.id, 'interrupted'); await waitTurn(path, child.id, 'interrupted');
    assert.equal(calls.filter(call => call.task === 'restart-tree').length, 1);
    assert.equal(calls.filter(call => call.task === 'child-hang').length, 2);
    assert.equal((await waitTurn(path, parent.id, 'done')).reply, 'parent:child-result');
    const nested = { id: randomUUID(), text: 'nested', recipient: alpha.id };
    await post(path, nested);
    assert.equal((await waitTurn(path, nested.id, 'done')).reply, 'parent:parent:child-result');
    const nestedChild = (await rows(path)).find((row: { parent: string }) => row.parent === nested.id);
    const grandchild = (await rows(path)).find((row: { parent: string }) => row.parent === nestedChild.id);
    assert.equal(grandchild.agent, alpha.id); assert.equal(grandchild.status, 'done');
    const parallel: { path: string; id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const lead = await post('/api/agents', { id: randomUUID(), name: `Parallel ${i}`, model: `parallel-${i}`, instructions: 'Coordinate.' });
      const room = await post('/api/channels', { id: randomUUID(), name: `Parallel ${i}`, instructions: 'Work.', members: [lead.id, beta.id], lead: lead.id });
      const target = `/api/channels/${room.id}/turns`, id = randomUUID();
      parallel.push({ path: target, id });
      await post(target, { id, text: 'parallel-delegate' });
    }
    for (const item of parallel) assert.equal((await waitTurn(item.path, item.id, 'done')).reply, 'parent:child-result');
    assert.equal(parallelCount, 4);
    const saved = { id: randomUUID(), text: 'save-result', recipient: alpha.id };
    await post(path, saved);
    for (let i = 0; !releaseSavedChild && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(releaseSavedChild);
    const alphaPath = `/api/agents/${alpha.id}/turns`, blocked = randomUUID();
    await post(alphaPath, { id: blocked, text: 'block-parent' });
    await waitTurn(alphaPath, blocked, 'running');
    releaseSavedChild();
    const savedChild = (await rows(path)).find((row: { parent: string }) => row.parent === saved.id);
    await waitTurn(path, savedChild.id, 'done');
    assert.equal((await waitTurn(path, saved.id, 'queued')).waiting_for, null);
    await app.close(); app = await startApp(options);
    assert.equal((await waitTurn(path, saved.id, 'done')).reply, 'parent:child-result');
    assert.equal(calls.filter(call => call.task === 'saved-child').length, 1);
    assert.equal(calls.filter(call => call.task === 'save-result').length, 2);
    for (let i = 0; i < 101; i++) await post(path, { id: randomUUID(), text: `later-${i}`, recipient: beta.id });
    const latest = await rows(path);
    assert.equal(latest.length, 100); assert(!latest.some((row: { id: string }) => row.id === parent.id));
    const family = await rows(`${path}?focus=${parent.id}`);
    assert.equal(family.length, 2);
    assert.equal(family[0].id, parent.id); assert.equal(family[1].parent, parent.id);
    assert.equal((await rows(`${path}?focus=${family[1].id}`))[0].id, parent.id);
    const foreign = parallel[0].id;
    assert.equal((await fetch(app.origin + `${path}?focus=${foreign}`)).status, 404);

  } finally {
    await app.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
