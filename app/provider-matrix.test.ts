import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { once } from 'node:events';
import { startApp } from './test-bridge.ts';

const key = 'provider-matrix-secret-canary-87362';
const invalidCatalog = 'The provider returned an invalid model catalog. Check the /models endpoint response.';
const missingAccount = 'The selected provider account is missing. Choose another account or update server configuration.';
const unauthorized = "The provider rejected the API key. Check the server's provider configuration.";
const timedOut = 'The provider request timed out. Check the provider before retrying because completion may be uncertain.';
const malformed = 'The provider returned a malformed response. Check provider compatibility before retrying.';
const cutStream = 'The provider stream ended before completion. Check the provider before retrying because the result may be incomplete.';
const failedRequest = (status: number) => `The provider failed while processing the request (HTTP ${status}). Check provider status and retry later.`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('local provider discovery and execution matrix preserves errors, bounded dispatch and secret isolation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-provider-matrix-'));
  const logs: string[] = [], responses: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(format(...args)); });
  let mode = 'catalog', requests = 0, redirected = 0, held: ServerResponse | undefined;
  let deadline = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ['timeout', 'catalog-timeout'].includes(mode) ? deadline.signal : realTimeout(ms));
  const calls: { model: string; toolResults: number }[] = [];
  const provider = createServer(async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (req.url === '/stolen') { redirected++; res.end(key); return; }
    if (req.url === '/v1/models') {
      if (mode === 'loading') { held = res; provider.emit('held'); return; }
      if (mode === 'catalog-timeout') { deadline.abort(new DOMException('Fixture deadline elapsed', 'TimeoutError')); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(key); return; }
      if (mode === 'non-json') { res.end(`${key}<html>not JSON</html>`); return; }
      if (mode === 'oversize') { res.end(key + 'x'.repeat(2 * 1024 * 1024)); return; }
      if (mode.startsWith('http-')) { res.writeHead(Number(mode.slice(5))); res.end(JSON.stringify({ error: { message: key } })); return; }
      if (mode === 'catalog-secret') { res.end(JSON.stringify({ data: [{ id: key }] })); return; }
      if (mode === 'invalid-catalog') { res.end(JSON.stringify({ data: [{ id: '\n' }], error: key })); return; }
      res.end(JSON.stringify({ data: mode === 'empty' ? [] : [{ id: 'primary' }, { id: 'backup' }] })); return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const toolResults = body.messages.filter((message: any) => message.role === 'tool').length;
    calls.push({ model: body.model, toolResults });
    assert(Array.isArray(body.tools) && body.tools.length > 0);
    const reject = (status: number) => { res.writeHead(status); res.end(JSON.stringify({ error: { message: key } })); };
    // Timeout mapping is exercised after the provider observes dispatch.
    if (mode === 'timeout') { deadline.abort(new DOMException('Fixture deadline elapsed', 'TimeoutError')); return; }
    if (mode === 'text-secret') { res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: key } }] })); return; }
    if (mode === 'malformed') { res.end(`{"error":"${key}",`); return; }
    if (mode === 'tools' || mode === 'other-400') { res.writeHead(400); res.end(JSON.stringify({ error: { message: key, param: mode === 'tools' ? 'tools' : 'temperature' } })); return; }
    if (mode.startsWith('http-')) return reject(Number(mode.slice(5)));
    if (mode === 'stream-cut' || mode === 'stream-socket-cut' || mode === 'stream-secret') {
      res.setHeader('Content-Type', 'text/event-stream');
      if (mode === 'stream-secret') { res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: key }, finish_reason: null }] })}\n\n`); return; }
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Partial answer"},"finish_reason":null}]}\n\n');
      if (mode === 'stream-socket-cut') { setTimeout(() => res.destroy(), 30); return; }
      res.end(`event: error\ndata: {"error":{"message":"${key}"}}\n\n`); return;
    }
    if (mode === 'after-tool' && !toolResults) {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'one-effect', type: 'function', function: { name: 'create_text_file', arguments: '{"name":"once.txt","text":"Saved once"}' } }] } }] })); return;
    }
    if (mode === 'after-tool' || mode === 'fallback-fails') return reject(503);
    if (mode.startsWith('fallback-') && body.model === 'primary') return reject(Number(mode.slice(9)));
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Answer' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: key, timeout: 2000 };
  let app = await startApp({ ...options, accounts: [{ id: 'work', name: 'Work', baseURL: options.baseURL, apiKey: key }] });
  async function request(path: string, body?: unknown, status = 200) {
    const res = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text(); responses.push(raw); assert(!raw.includes(key), 'API response leaked key');
    assert.equal(res.status, status, raw); return JSON.parse(raw);
  }
  async function until(path: string, id: string) {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) { const row = (await request(path)).find((row: any) => row.id === id); if (row && ['done', 'failed'].includes(row.status)) return row; await sleep(25); }
    assert.fail(`Turn ${id} did not settle within 30s`);
  }
  function scan() {
    assert(!responses.join('\n').includes(key), 'Response history leaked key');
    assert(!logs.join('\n').includes(key), 'Captured console leaked key');
    for (const file of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      assert(!readFileSync(join(file.parentPath, file.name)).includes(Buffer.from(key)), `File ${file.name} leaked key`);
    }
  }
  try {
    await t.test('loading remains pending; empty catalog succeeds without inventing models', async () => {
      mode = 'loading'; const before = requests; let done = false;
      const ready = once(provider, 'held', { signal: AbortSignal.timeout(30000) });
      const pending = request('/api/models').then(value => { done = true; return value; });
      await ready;
      assert(held); assert.equal(done, false); assert.equal(requests - before, 1);
      held.end('{"data":[]}'); held = undefined; assert.deepEqual(await pending, { models: [] });
      mode = 'empty'; assert.deepEqual(await request('/api/models'), { models: [] }); scan();
    });
    const discovery = [
      ['http-401', unauthorized],
      ['http-403', 'The provider denied access to the model catalog. Check the API key permissions.'],
      ['catalog-secret', invalidCatalog], ['non-json', invalidCatalog], ['oversize', invalidCatalog], ['invalid-catalog', invalidCatalog],
      ['redirect', 'The model catalog redirected unexpectedly. Check the provider URL and /models endpoint.'],
      ['http-408', 'Model discovery timed out. Check the provider and try again.'],
      ['http-429', 'The provider rate limit blocked model discovery. Wait for quota to reset and try again.'],
      ['http-503', 'The provider is unavailable for model discovery. Check provider status and try again.'],
      ['catalog-timeout', 'Model discovery timed out. Check the provider and try again.'],
    ];
    for (const [scenario, expected] of discovery) await t.test(`discovery ${scenario}`, async () => {
      mode = scenario; deadline = new AbortController(); const before = requests;
      assert.deepEqual(await request('/api/models?account=work', undefined, 502), { error: expected });
      assert.equal(requests - before, 1); assert.equal(redirected, 0); scan();
    });
    await t.test('missing named account cannot use configured default', async () => {
      const before = requests;
      assert.deepEqual(await request('/api/models?account=gone', undefined, 503), { error: missingAccount });
      assert.equal(requests, before); scan();
    });
    mode = 'catalog';
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Matrix', model: 'primary', backupModel: 'backup', instructions: 'Synthetic provider checks' }, 201);
    const path = `/api/agents/${agent.id}/turns`;
    const failures = [
      ['http-401', unauthorized],
      ['http-403', 'The provider denied this request. Check the API key permissions and model access.'],
      ['http-404', 'The provider does not know this model. Check the model ID or choose one from model discovery.'],
      ['http-408', timedOut], ['timeout', timedOut],
      ['http-500', failedRequest(500)], ['http-502', failedRequest(502)],
      ['text-secret', malformed], ['malformed', malformed],
      ['tools', 'The provider rejected the requested tools. Choose a model and provider that support tools.'],
      ['other-400', 'The provider rejected the request (HTTP 400). Check model and provider compatibility.'],
    ];
    for (const [scenario, expected] of failures) await t.test(`turn ${scenario} does not fall back or replay`, async () => {
      mode = scenario; deadline = new AbortController(); const before = calls.length, command = { id: randomUUID(), text: scenario };
      await request(path, command, 202); const row = await until(path, command.id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, expected); assert.equal(row.reply, null);
      assert.deepEqual(calls.slice(before).map(call => call.model), ['primary']);
      await request(path, command, 202); assert.equal(calls.length, before + 1); scan();
    });
    for (const status of [429, 503]) await t.test(`turn ${status} falls back once on same account`, async () => {
      mode = `fallback-${status}`; const before = calls.length, id = randomUUID();
      await request(path, { id, text: mode }, 202); const row = await until(path, id);
      assert.equal(row.status, 'done'); assert.equal(row.error, null); assert.equal(row.answer_model, 'backup');
      assert.deepEqual(calls.slice(before).map(call => call.model), ['primary', 'backup']); scan();
    });
    await t.test('fallback failure ends after two requests', async () => {
      mode = 'fallback-fails'; const before = calls.length, id = randomUUID();
      await request(path, { id, text: mode }, 202); const row = await until(path, id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, failedRequest(503));
      assert.deepEqual(calls.slice(before).map(call => call.model), ['primary', 'backup']); scan();
    });
    await t.test('rate limit without fallback stays failed', async () => {
      const plain = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'No fallback', model: 'primary', instructions: 'Test' }, 201);
      mode = 'http-429'; const before = calls.length, id = randomUUID(), plainPath = `/api/agents/${plain.id}/turns`;
      await request(plainPath, { id, text: mode }, 202); const row = await until(plainPath, id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, 'The provider rate limit was reached (HTTP 429). Wait for quota to reset or choose another model.');
      assert.equal(calls.length, before + 1); scan();
    });
    await t.test('completed tool effect blocks automatic fallback; acknowledged resume retains artifact', async () => {
      mode = 'after-tool'; const before = calls.length, id = randomUUID();
      await request(path, { id, text: mode }, 202); const row = await until(path, id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, failedRequest(503)); assert.equal(row.generatedFiles.length, 1);
      assert.deepEqual(calls.slice(before).map(call => call.model), ['primary', 'primary']);
      await request(`${path}/${id}/resume`, { id: randomUUID(), revision: row.revision }, 409); assert.equal(calls.length, before + 2);
      mode = 'answer';
      await request(`${path}/${id}/resume`, { id: randomUUID(), revision: row.revision, acknowledgeUncertain: true });
      const resumed = await until(path, id); assert.equal(resumed.status, 'done'); assert.deepEqual(resumed.generatedFiles, row.generatedFiles);
      assert.deepEqual(calls.slice(before).map(call => call.toolResults), [0, 1, 1, 1]); scan();
    });
    await app.close(); app = await startApp({ ...options, stream: true });
    for (const scenario of ['stream-cut', 'stream-socket-cut']) await t.test(`turn ${scenario} retains partial text without fallback or replay on restart`, async () => {
      mode = scenario; const before = calls.length, command = { id: randomUUID(), text: scenario };
      await request(path, command, 202); const row = await until(path, command.id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, cutStream); assert.equal(row.reply, null); assert.equal(row.partial.text, 'Partial answer');
      assert.equal(calls.length, before + 1);
      await app.close(); app = await startApp({ ...options, stream: true });
      const restored = (await request(path)).find((turn: any) => turn.id === command.id);
      assert.equal(restored.error, cutStream); assert.equal(calls.length, before + 1);
      await request(path, command, 202); assert.equal(calls.length, before + 1); scan();
    });
    await t.test('streamed credential echo never reaches partial storage', async () => {
      mode = 'stream-secret'; const before = calls.length, id = randomUUID();
      await request(path, { id, text: mode }, 202); const row = await until(path, id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, malformed); assert.equal(row.partial.text, ''); assert.equal(row.partial.final, false); assert.deepEqual(row.activity.stream, []);
      assert.equal(calls.length, before + 1); scan();
    });
    await t.test('unconfigured default is distinct from missing named account', async () => {
      await app.close(); app = await startApp({ database: options.database, apiKey: key });
      const before = requests;
      assert.deepEqual(await request('/api/models', undefined, 503), { error: 'The default provider account is not configured. Check server configuration before trying model discovery.' });
      await request(path, { id: randomUUID(), text: 'Must not dispatch' }, 503);
      assert.equal(requests, before); scan();
    });
    await t.test('unreachable loopback host reports connection problem', async () => {
      await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      app = await startApp(options);
      assert.deepEqual(await request('/api/models', undefined, 502), { error: 'The model catalog host is unreachable. Check the provider URL and network.' });
      const id = randomUUID(); await request(path, { id, text: 'Unreachable' }, 202); const row = await until(path, id);
      assert.equal(row.status, 'failed'); assert.equal(row.error, 'The provider could not be reached. Check the provider URL and network before retrying; completion may be uncertain.'); scan();
    });
    await request('/api/provider-accounts'); await request('/api/agents'); await request('/api/usage');
    scan();
  } finally {
    await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
