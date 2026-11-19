import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('tested MCP updates bind origin/revision, rotate credentials and invalidate grants exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-mcp-update-')), oldToken = 'old-fixture-token', newToken = 'new-fixture-token';
  const headers: string[] = []; let description = 'Original', release: (() => void) | undefined, delay = false;
  const remote = createServer(async (req, res) => {
    headers.push(req.headers.authorization ?? '');
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const message = JSON.parse(raw);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.method === 'tools/list' && delay) { delay = false; await new Promise<void>(resolve => { release = resolve; }); }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } } : { tools: [{ name: 'tool', description, inputSchema: { type: 'object' } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve)); const address = remote.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite') }, url = `http://127.0.0.1:${address.port}/mcp`;
  let app = await startApp(options, { directory: dir, servers: [remote] });
  async function post(path: string, data: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); assert(!JSON.stringify(body).includes(oldToken)); assert(!JSON.stringify(body).includes(newToken)); return body;
  }
  const get = async (path: string) => { const response = await fetch(app.origin + path); assert(response.ok); return response.json(); };
  const probe = (connection: string, revision: number, extra: Record<string, unknown> = {}) => post('/api/mcp/test', { id: randomUUID(), connection, revision, name: 'Updated', ...extra });
  try {
    const a = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' }, 201);
    const b = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' }, 201);
    const initial = await post('/api/mcp/test', { id: randomUUID(), name: 'Original', url, token: oldToken });
    const row = await post('/api/mcp', { id: randomUUID(), test: initial.id }), path = `/api/mcp/${row.id}`, ag = `/api/agents/${a.id}/mcp/${row.id}`, bg = `/api/agents/${b.id}/mcp/${row.id}`;
    assert.equal((await get(path)).revision, 1);
    await post(ag, { id: randomUUID(), revision: 0, connectionRevision: 1, tools: ['tool'] }); await post(bg, { id: randomUUID(), revision: 0, connectionRevision: 1, tools: ['tool'] });
    await post('/api/mcp/test', { id: randomUUID(), connection: row.id, revision: 1, name: 'Hijack', url: url + '/other' }, 400);
    description = 'New definition'; headers.length = 0; const refresh = await probe(row.id, 1); assert.deepEqual([...new Set(headers)], [`Bearer ${oldToken}`]);
    await post('/api/mcp', { id: randomUUID(), test: refresh.id }, 400);
    const update = { id: randomUUID(), revision: 1, test: refresh.id };
    const changed = await post(path, update); assert.equal(changed.id, row.id); assert.equal(changed.revision, 2); assert.equal(changed.url, url);
    assert.equal((await get(path)).revision, 2);
    for (const agent of [a, b]) { const detail = await get(`${path}?agent=${agent.id}`); assert.deepEqual(detail.grant, { revision: 2, tools: [] }); assert.equal(detail.tools[0].description, description); }
    await post(ag, { id: randomUUID(), revision: 1, connectionRevision: 1, tools: ['tool'] }, 409);
    await post(ag, { id: randomUUID(), revision: 2, connectionRevision: 2, tools: ['tool'] });
    assert.deepEqual(await post(path, update), changed); assert.deepEqual((await get(`${path}?agent=${a.id}`)).grant.tools, ['tool']);
    await post(path, { id: randomUUID(), revision: 2, test: refresh.id }, 409);
    headers.length = 0; const rotate = await probe(row.id, 2, { token: newToken }); assert.deepEqual([...new Set(headers)], [`Bearer ${newToken}`]);
    const rotation = { id: randomUUID(), revision: 2, test: rotate.id }; await post(path, rotation);
    headers.length = 0; await probe(row.id, 3); assert.deepEqual([...new Set(headers)], [`Bearer ${newToken}`]);
    await app.close(); app = await startApp(options); assert.equal((await post(path, rotation)).revision, 3);
    const stale = await probe(row.id, 3); await post(path, { id: randomUUID(), revision: 3, enabled: false }); await post(path, { id: randomUUID(), revision: 4, test: stale.id }, 409);
    headers.length = 0; const cleared = await probe(row.id, 4, { token: '' }); assert.deepEqual([...new Set(headers)], ['']);
    const clearResult = await post(path, { id: randomUUID(), revision: 4, test: cleared.id }); assert.equal(clearResult.enabled, 0); assert.equal(clearResult.hasToken, false);
    // A delayed test cannot overwrite a newer connection revision or re-enable it.
    delay = true; const pending = post('/api/mcp/test', { id: randomUUID(), connection: row.id, revision: 5, name: 'Delayed' }, 502);
    for (let n = 0; n < 200 && !release; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(release);
    await post(path, { id: randomUUID(), revision: 5, enabled: false }); await pending; release(); release = undefined;
    assert.equal((await get(`${path}?agent=${a.id}`)).revision, 6);
  } finally { release?.(); await app.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
