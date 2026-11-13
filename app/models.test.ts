import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { discoverModels } from './models.ts';

test('model discovery validates catalog and never follows credential redirects', async () => {
  let mode = 'ok', calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    assert.equal(req.url, '/v1/models');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end(); return; }
    if (mode === 'error') { res.writeHead(401); res.end('private provider detail'); return; }
    if (mode === 'large') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    res.end(mode === 'bad-json' ? 'invalid' : JSON.stringify({ data: mode === 'invalid' ? [{ id: '\n' }] : mode === 'spaces' ? [{ id: ' model ' }] : mode === 'empty' ? [] : [{ id: 'z' }, { id: 'a' }, { id: 'z' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-models-'));
  let app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: base, apiKey: 'fixture-secret' });
  try {
    const catalog = await fetch(app.origin + '/api/models');
    assert.equal(catalog.status, 200); assert.deepEqual(await catalog.json(), { models: ['a', 'z'] });
    mode = 'error';
    const failure = await fetch(app.origin + '/api/models');
    assert.equal(failure.status, 502); assert(!(await failure.text()).includes('private'));
    mode = 'ok';
    assert.deepEqual(await discoverModels(base, 'fixture-secret'), ['a', 'z']);
    for (mode of ['redirect', 'error', 'large', 'bad-json', 'invalid', 'spaces']) {
      await assert.rejects(discoverModels(base, 'fixture-secret'), error => error instanceof Error && (/^(The provider|The model catalog)/.test(error.message)) && !error.message.includes('private'));
    }
    assert.equal(calls, 9);
    mode = 'empty'; assert.deepEqual(await discoverModels(base, 'fixture-secret'), []);
    await assert.rejects(discoverModels('http://example.com/v1', 'fixture-secret'), /address/);
    await assert.rejects(discoverModels('https://user:password@example.com/v1'), /address/);
    await app.close(); app = await startApp({ database: join(dir, 'state.sqlite') });
    assert.equal((await fetch(app.origin + '/api/models')).status, 503);
  } finally {
    await app.close(); rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
