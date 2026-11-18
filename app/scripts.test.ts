import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';

test('local scripts require token and current agent grant, keep payload and retry identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-scripts-'));
  const token = randomBytes(32).toString('base64url'), prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), prompt = data.messages.at(-1).content; prompts.push(prompt);
    if (prompt.includes('HOLD')) return;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Script result' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, scriptToken: token };
  await assert.rejects(startApp({ ...options, scriptToken: 'short' }), /BRIEFSIP_SCRIPT_TOKEN/);
  let app = await startApp(options);
  async function request(path: string, body?: unknown, status = 200, headers?: Record<string, string>) {
    const response = await new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const req = httpRequest(app.origin + path, { method: body ? 'POST' : 'GET', headers: headers ?? { Origin: app.origin, 'Content-Type': 'application/json' } }, async res => {
        try { let text = ''; for await (const chunk of res) text += chunk; resolve({ status: res.statusCode, text }); } catch (error) { reject(error); }
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    const data = JSON.parse(response.text); assert.equal(response.status, status, JSON.stringify(data)); assert(!JSON.stringify(data).includes(token)); return data;
  }
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Script agent', model: 'fixture', instructions: 'Help.' }, 201);
    const permission = `/api/agents/${agent.id}/scripts`, list = `/api/agents/${agent.id}/routines`;
    assert.deepEqual(await request(permission), { enabled: 0, revision: 0, configured: true });
    const routine = await request(list, { id: randomUUID(), name: 'Script routine', prompt: 'Saved instruction', nextAt: Date.now() + 3600000, intervalSeconds: 60, enabled: false });
    const path = `/api/scripts/routines/${routine.id}/run`, runs = `/api/scripts/routines/${routine.id}/runs`;
    const body = { id: randomUUID(), revision: routine.revision, payload: 'Event data' };
    await request(path, body, 403, auth);
    const grant = { id: randomUUID(), revision: 0, enabled: true };
    await request(permission, grant, 403, auth);
    assert.deepEqual(await request(permission, grant), { enabled: 1, revision: 1 });
    assert.deepEqual(await request(permission, grant), { enabled: 1, revision: 1 });
    await request(permission, { ...grant, enabled: false }, 409);
    await request(path, body, 403, { 'Content-Type': 'application/json' });
    await request(path, body, 403, { ...auth, Authorization: 'Bearer wrong' });
    await request(path, body, 403, { ...auth, Origin: app.origin });
    await request(path, body, 403, { ...auth, Origin: 'null' });
    await request(path, body, 403, { ...auth, Host: 'evil.example' });
    await request(path, body, 403, { ...auth, 'Sec-Fetch-Site': 'cross-site' });
    await request(path, { ...body, payload: 'x'.repeat(16001) }, 400, auth);
    await request(path, { ...body, revision: routine.revision + 1 }, 409, auth);
    const result = await request(path, body, 200, auth);
    assert.deepEqual(await request(path, body, 200, auth), result);
    await request(path, { ...body, payload: 'Changed' }, 409, auth);
    await request(`/api/routines/${routine.id}/test`, { id: body.id, revision: routine.revision }, 409);
    let rows;
    for (let n = 0; n < 100; n++) { rows = await request(runs, undefined, 200, auth); if (rows[0]?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].status, 'done'); assert.equal(rows[0].source, 'script'); assert.equal(rows[0].scheduled_at, null);
    assert.equal(rows.length, 1); assert.deepEqual(prompts, ['Saved instruction\n\nScript input:\nEvent data']);
    assert.deepEqual((await request(list))[0], routine);
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length, 0);
    assert.equal((await request(`/api/scripts/agents/${agent.id}/routines`, undefined, 200, auth)).length, 1);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(path, body, 200, auth), result); assert.equal(prompts.length, 1);
    const otherAgent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'No script grant', model: 'fixture', instructions: 'Help.' }, 201);
    const otherRoutine = await request(`/api/agents/${otherAgent.id}/routines`, { id: randomUUID(), name: 'Private routine', prompt: 'Never execute', nextAt: Date.now() + 3600000, intervalSeconds: null, enabled: false });
    await request(`/api/scripts/routines/${otherRoutine.id}/run`, { ...body, id: randomUUID(), revision: otherRoutine.revision }, 403, auth);
    await request(`/api/scripts/routines/${otherRoutine.id}/runs`, undefined, 403, auth);
    await request(`/api/scripts/agents/${otherAgent.id}/routines`, undefined, 403, auth);
    const rotated = randomBytes(32).toString('base64url');
    await app.close(); app = await startApp({ ...options, scriptToken: rotated });
    await request(path, body, 403, auth);
    assert.deepEqual(await request(path, body, 200, { ...auth, Authorization: `Bearer ${rotated}` }), result);
    assert.equal(prompts.length, 1);
    await app.close(); app = await startApp(options);
    const held = await request(path, { ...body, id: randomUUID(), payload: 'HOLD' }, 200, auth);
    await request(path, { ...body, id: randomUUID() }, 409, auth);
    let finishBody!: () => void;
    const delayed = new Promise<number | undefined>((resolve, reject) => {
      const raw = JSON.stringify(body);
      const req = httpRequest(app.origin + path, { method: 'POST', headers: auth }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write(raw.slice(0, -1)); finishBody = () => req.end(raw.slice(-1));
    });
    const revoke = { id: randomUUID(), enabled: false, revision: 1 };
    assert.deepEqual(await request(permission, revoke), { enabled: 0, revision: 2 });
    finishBody(); assert.equal(await delayed, 403);
    await request(path, body, 403, auth); await request(runs, undefined, 403, auth);
    await request(`/api/scripts/agents/${agent.id}/routines`, undefined, 403, auth);
    await request(permission, { ...grant, id: randomUUID() }, 409);
    assert.equal((await request(permission)).enabled, 0);
    await request(`/api/threads/${held.thread}/turns/${held.turn}/cancel`, { id: randomUUID() });
    await app.close(); app = await startApp({ database: options.database });
    assert.equal((await request(permission)).configured, false);
    await request(permission, { ...grant, id: randomUUID(), revision: 2 }, 409);
    await request(path, body, 403, auth);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
