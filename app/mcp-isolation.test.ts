import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a hostile MCP output schema cannot block HTTP, exceed the worker deadline or resist cancellation', { timeout: 40000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-mcp-isolation-'));
  let connection = '', effects = 0;
  const external = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const request = JSON.parse(raw);
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'hostile-schema-fixture', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'slow', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } } } }] };
    else { effects++; result = { content: [{ type: 'text', text: 'done' }], structuredContent: { text: 'a'.repeat(32) + '!' } }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {} res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'call_mcp_tool', arguments: JSON.stringify({ connection, name: 'slow', arguments: {} }) } }] } }] }));
  });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve)); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const ea = external.address(), pa = provider.address(); assert(ea && typeof ea !== 'string' && pa && typeof pa !== 'string');
  const options = { database: join(dir, 'test.sqlite'), baseURL: `http://127.0.0.1:${pa.port}/v1` };
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { startApp } from './server.ts'; const app = await startApp(${JSON.stringify(options)}); console.log(app.origin);`], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const origin = await new Promise<string>((resolve, reject) => { let raw = ''; child.stdout.on('data', chunk => { raw += chunk; if (raw.includes('\n')) resolve(raw.trim()); }); child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before ready'))); });
    async function post(path: string, body: unknown) { const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }); assert(response.ok, await response.clone().text()); return response.json(); }
    const agent = await post('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const tested = await post('/api/mcp/test', { id: randomUUID(), name: 'Hostile schema', url: `http://127.0.0.1:${ea.port}/mcp`, token: '' });
    const saved = await post('/api/mcp', { id: randomUUID(), test: tested.id }); connection = saved.id;
    await post(`/api/agents/${agent.id}/mcp/${connection}`, { id: randomUUID(), revision: 0, connectionRevision: 1, tools: ['slow'] });
    const id = randomUUID(), path = `/api/agents/${agent.id}/turns`;
    await post(path, { id, text: 'Run tool' });
    for (let i = 0; i < 300 && effects === 0; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(effects, 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const health = await fetch(origin + '/api/agents', { signal: AbortSignal.timeout(500) }); assert(health.ok);
    let failed; const deadline = Date.now() + 24000;
    while (Date.now() < deadline) { const rows = await (await fetch(origin + path, { signal: AbortSignal.timeout(2000) })).json(); failed = rows.find((row: any) => row.id === id); if (failed?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(failed?.status, 'failed'); assert.match(failed.error, /belum pasti/);
    const cancelId = randomUUID(); await post(path, { id: cancelId, text: 'Cancel this tool' });
    for (let i = 0; i < 300 && effects < 2; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(effects, 2);
    await post(`${path}/${cancelId}/cancel`, { id: randomUUID() });
    const rows = await (await fetch(origin + path, { signal: AbortSignal.timeout(500) })).json(); assert.equal(rows.find((row: any) => row.id === cancelId).status, 'cancelled');
  } finally { child.kill('SIGKILL'); await exited; external.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise<void>(resolve => external.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]); rmSync(dir, { recursive: true, force: true }); }
});
