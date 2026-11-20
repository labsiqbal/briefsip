import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('model discovery validates catalog and never follows credential redirects', async () => {
  let mode = 'ok', calls = 0, redirected = false;
  const server = createServer((req, res) => {
    calls++;
    if (req.url === '/unexpected') { redirected = true; res.end(); return; }
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    assert.equal(req.url, '/v1/models');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/unexpected' }); res.end(); return; }
    if (mode === 'error') { res.writeHead(401); res.end('private provider detail'); return; }
    if (mode === 'large') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    res.end(mode === 'bad-json' ? 'invalid' : JSON.stringify({ data: mode === 'invalid' ? [{ id: '\n' }] : mode === 'spaces' ? [{ id: ' model ' }] : mode === 'empty' ? [] : [{ id: 'z' }, { id: 'a' }, { id: 'z' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-models-'));
  let app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: base, apiKey: 'fixture-secret' }, { directory: dir, servers: [server] });
  try {
    const models = () => fetch(app.origin + '/api/models');
    const catalog = await models();
    assert.equal(catalog.status, 200); assert.deepEqual(await catalog.json(), { models: ['a', 'z'] });
    for (mode of ['redirect', 'error', 'large', 'bad-json', 'invalid', 'spaces']) {
      const failure = await models();
      assert.equal(failure.status, 502, mode);
      const message = await failure.text();
      assert.doesNotMatch(message, /private provider detail|fixture-secret/);
    }
    assert.equal(calls, 7);
    assert.equal(redirected, false);
    mode = 'empty';
    assert.deepEqual(await (await models()).json(), { models: [] });
    for (const baseURL of ['http://example.test/v1', 'https://user:password@example.test/v1']) {
      await assert.rejects(startApp({ database: join(dir, 'invalid.sqlite'), baseURL }), /Invalid provider address/);
    }
    await app.close(); app = await startApp({ database: join(dir, 'state.sqlite') });
    assert.equal((await fetch(app.origin + '/api/models')).status, 503);
  } finally {
    await app.close(); rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
