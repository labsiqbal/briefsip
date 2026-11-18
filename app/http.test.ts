import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, isReconnecting, readJson } from './src/http.ts';

test('empty proxy responses indicate a restart', async () => {
  for (const status of [502, 503, 504]) {
    await assert.rejects(readJson(new Response(null, { status })), error =>
      error instanceof HttpError && error.status === status && isReconnecting(error)
      && error.message === 'Briefsip is restarting. Try again in a moment.');
  }
});

test('HTML errors show a safe fallback', async () => {
  await assert.rejects(readJson(new Response('<html>error</html>', { status: 500 })), { message: 'HTTP 500' });
  await assert.rejects(readJson(new Response('<html>bad gateway</html>', { status: 502 })), isReconnecting);
});

test('JSON errors preserve status, message and code', async () => {
  await assert.rejects(readJson(Response.json({ error: 'Release unavailable', code: 'missing' }, { status: 503 })),
    error => error instanceof HttpError && error.status === 503 && error.message === 'Release unavailable'
      && error.code === 'missing' && !isReconnecting(error));
  await assert.rejects(readJson(Response.json({ error: { message: 'No access', code: 'denied' } }, { status: 403 })),
    { status: 403, message: 'No access', code: 'denied' });
});

test('valid success returns JSON and empty success reports invalid response', async () => {
  assert.deepEqual(await readJson(Response.json({ ok: true })), { ok: true });
  await assert.rejects(readJson(new Response('')), { message: 'Briefsip returned an invalid response. Try again.' });
});
