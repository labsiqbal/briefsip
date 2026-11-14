import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { restoreWorkspace } from './backup.ts';
import { once } from 'node:events';

test('MCP tests before save, protects credentials/grants and journals success or uncertainty without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-mcp-')), token = 'test-secret-credential';
  let calls = 0, drift = false, lost = false, sse = false, hold = false, failProvider = false, repeat = false, connection = '', providerRaw = '', bearer = token, initialized = 0, deleted = 0, leakKey = false, paged = false;
  let held: (() => void) | undefined;
  const external = createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/mcp' }); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    assert.equal(req.headers.authorization, `Bearer ${bearer}`);
    if (req.method === 'DELETE') { deleted++; res.writeHead(200); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (!request.id && request.id !== 0) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') { initialized++; res.setHeader('Mcp-Session-Id', randomUUID()); result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; }
    else if (request.method === 'tools/list') result = { tools: [{ name: 'change', description: drift ? 'Changed tool' : `A tool ${bearer}`, inputSchema: { type: 'object', properties: { value: { type: 'string' }, count: { type: 'number', default: 1 }, ...(leakKey ? { [bearer]: { type: 'string' } } : {}) }, required: ['value'], additionalProperties: false } }] };
    else if (request.method === 'tools/call') {
      calls++; assert.equal(request.params.name, 'change');
      if (lost) { lost = false; res.destroy(); return; }
      result = { content: [{ type: 'text', text: `Saved ${request.params.arguments.value} ${token}` }], structuredContent: { [token]: 'masked key' } };
      if (hold) { await new Promise<void>(resolve => { held = resolve; external.emit('held'); }); held = undefined; }
    } else assert.fail(request.method);
    if (paged && request.method === 'tools/list') result = request.params?.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'change', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } }], nextCursor: 'next' };
    if (paged && request.method === 'tools/call') result = { content: [{ type: 'text', text: 'Invalid structured output' }], structuredContent: { count: 'invalid' } };
    const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    res.setHeader('Content-Type', sse ? 'text/event-stream' : 'application/json'); res.end(sse ? `event: message\ndata: ${message}\n\n` : message);
  });
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; providerRaw += raw;
    const data = JSON.parse(raw), result = data.messages.filter((message: any) => message.role === 'tool').at(-1), prompt = data.messages.filter((message: any) => message.role === 'user').at(-1).content;
    const offered = data.tools?.some((tool: any) => tool.function.name === 'call_mcp_tool');
    // Legacy channels are project sections: discovery is offered, but installation grants stay inaccessible.
    assert.equal(offered, true);
    if (result && failProvider) { failProvider = false; res.writeHead(503); res.end(); return; }
    const call = !result || repeat;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: prompt === 'list' ? 'list_mcp_tools' : 'call_mcp_tool', arguments: JSON.stringify(prompt === 'list' ? {} : { connection, name: 'change', arguments: { value: 'one' } }) } }] } : { content: result.content } }] }));
  });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve)); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = external.address(), pa = provider.address(); assert(address && typeof address !== 'string' && pa && typeof pa !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`, options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${pa.port}/v1` };
  let app = await startApp(options);
  const get = async (path: string) => { const response = await fetch(app.origin + path); assert(response.ok); return response.json(); };
  const post = async (path: string, body: unknown, status = 200) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); assert(!JSON.stringify(value).includes(token)); return value;
  };
  async function until(path: string, id: string, status: string) {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) { const row = (await get(path)).find((row: any) => row.id === id); if (row?.status === status) return row; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail(`Task ${id} did not become ${status} within 30s`);
  }
  async function run(path: string, text: string, status = 'done') { const id = randomUUID(); await post(path, { id, text }, 202); return until(path, id, status); }
  try {
    const a = await post('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Use MCP' }, 201), b = await post('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Use MCP' }, 201);
    const ap = `/api/agents/${a.id}/turns`, bp = `/api/agents/${b.id}/turns`;
    await post('/api/mcp', { id: randomUUID(), test: randomUUID() }, 409);
    for (const bad of ['http://example.com/mcp', url + '?token=secret', 'file:///etc/passwd', url.replace('127.0.0.1', 'user:pass@127.0.0.1')]) await post('/api/mcp/test', { id: randomUUID(), name: 'Bad', url: bad, token }, 400);
    await post('/api/mcp/test', { id: randomUUID(), name: 'Redirect', url: url.replace('/mcp', '/redirect'), token }, 502);
    for (bearer of ['name', '1']) { const short = await post('/api/mcp/test', { id: randomUUID(), name: 'Short token', url, token: bearer }); assert.equal(short.tools[0].name, 'change'); assert.equal(short.tools[0].inputSchema.properties.count.default, 1); }
    bearer = 'object'; await post('/api/mcp/test', { id: randomUUID(), name: 'Collision', url, token: bearer }, 400);
    bearer = token; leakKey = true; await post('/api/mcp/test', { id: randomUUID(), name: 'Leaked key', url, token }, 400); leakKey = false;
    assert.equal(initialized, deleted); bearer = token;
    const testCommand = { id: randomUUID(), name: 'Fixture', url, token };
    const tested = await post('/api/mcp/test', testCommand); assert.equal(tested.tools[0].description, 'A tool [REDACTED]'); assert.deepEqual(await post('/api/mcp/test', testCommand), tested);
    const save = { id: randomUUID(), test: tested.id }; connection = save.id;
    const saved = await post('/api/mcp', save); assert(saved.hasToken); assert.deepEqual(await post('/api/mcp', save), saved);
    await post(`/api/mcp/${connection}`, { id: randomUUID(), revision: 1, enabled: true, url: url + '/other' }, 400);
    assert.equal(calls, 0); await run(ap, 'call', 'failed'); assert.equal(calls, 0);
    const gp = `/api/agents/${a.id}/mcp/${connection}`, grant = { id: randomUUID(), revision: 0, connectionRevision: 1, tools: ['change'] };
    await post(gp, grant); assert.deepEqual(await post(gp, grant), { revision: 1, tools: ['change'] });
    await post(gp, { ...grant, id: randomUUID() }, 409);
    assert.equal(JSON.parse((await run(ap, 'list')).reply).connections[0].tools[0].name, 'change');
    await run(bp, 'call', 'failed'); assert.equal(calls, 0);
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Channel', instructions: 'Help', lead: a.id, members: [a.id] }, 201); await run(`/api/channels/${channel.id}/turns`, 'channel', 'failed'); assert.equal(calls, 0);
    sse = true; failProvider = true;
    const failed = await run(ap, 'call', 'failed'); assert.equal(calls, 1);
    await app.close(); assert(!readFileSync(options.database).includes(Buffer.from(token))); app = await startApp(options);
    await post(`${ap}/${failed.id}/resume`, { id: randomUUID(), revision: failed.revision, acknowledgeUncertain: true }); const done = await until(ap, failed.id, 'done'); assert.match(done.reply, /Saved one/); assert.equal(calls, 1);
    drift = true; await run(ap, 'call', 'failed'); assert.equal(calls, 1); drift = false;
    lost = true; const uncertain = await run(ap, 'call', 'failed'); assert.equal(calls, 2); assert.match(uncertain.error, /uncertain/);
    await app.close(); app = await startApp(options); repeat = true;
    await post(`${ap}/${uncertain.id}/resume`, { id: randomUUID(), revision: uncertain.revision, acknowledgeUncertain: true }); await until(ap, uncertain.id, 'failed'); assert.equal(calls, 2); repeat = false;
    const heldReady = once(external, 'held', { signal: AbortSignal.timeout(30000) });
    hold = true; const active = randomUUID(); await post(ap, { id: active, text: 'call' }, 202);
    await assert.doesNotReject(heldReady, 'MCP fixture did not receive held call within 30s'); assert(held);
    await post(gp, { id: randomUUID(), revision: 1, connectionRevision: 1, tools: [] }); await until(ap, active, 'failed'); held(); hold = false;
    await run(ap, 'call', 'failed'); assert.equal(calls, 3);
    assert(!providerRaw.includes(token)); assert(!JSON.stringify(await get(`/api/mcp/${connection}?agent=${a.id}`)).includes(token));
    const backup = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) }); assert(backup.ok);
    const backupPath = join(dir, 'backup.sqlite'); writeFileSync(backupPath, Buffer.from(await backup.arrayBuffer()));
    await app.close(); const restored = join(dir, 'restored.sqlite'); restoreWorkspace(backupPath, restored); app = await startApp({ ...options, database: restored });
    assert.equal((await get('/api/mcp')).items[0].enabled, 0);
    await post(`/api/mcp/${connection}`, { id: randomUUID(), revision: 2, enabled: true });
    await post(gp, { id: randomUUID(), revision: 2, connectionRevision: 3, tools: ['change'] }); const missingKey = await run(ap, 'call', 'failed'); assert.match(missingKey.error, /host key/); assert.equal(calls, 3);
    paged = true;
    const testedPages = await post('/api/mcp/test', { id: randomUUID(), name: 'Paged', url, token }); assert.equal(testedPages.tools.length, 2);
    const pages = await post('/api/mcp', { id: randomUUID(), test: testedPages.id }); connection = pages.id;
    await post(`/api/agents/${a.id}/mcp/${connection}`, { id: randomUUID(), revision: 0, connectionRevision: 1, tools: ['change'] });
    const invalidOutput = await run(ap, 'call', 'failed'); assert.match(invalidOutput.error, /uncertain/); assert.equal(calls, 4); assert(!providerRaw.includes('Invalid structured output'));
  } finally { held?.(); await app.close(); external.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise<void>(resolve => external.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]); rmSync(dir, { recursive: true, force: true }); }
});
