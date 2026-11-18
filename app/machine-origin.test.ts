import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp } from './server.ts';

test('machine identity uses the first allowed origin so paired peers keep matching it', async () => {
  const directory = mkdtempSync('/dev/shm/machine-origin-');
  const origin = 'https://linc.example.test:4317';
  const app = await startApp({ database: join(directory, 'db.sqlite'), allowedOrigins: [origin, 'https://other.example.test'] });
  try {
    const environment = await (await fetch(`${app.origin}/api/environment`)).json() as { origin: string };
    assert.equal(environment.origin, origin);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
