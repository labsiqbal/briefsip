import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';

test('Rust host metrics cache samples, classify storage files and reject path overrides', async () => {
  const httpDir = mkdtempSync(join(tmpdir(), 'briefsip-metrics-http-')), database = join(httpDir, 'state.sqlite');
  const app = await startApp({ database });
  try {
    const db = new DatabaseSync(database);
    try {
      db.exec('CREATE TABLE fixture(bytes BLOB); INSERT INTO fixture VALUES (zeroblob(32768)); DELETE FROM fixture;');
    } finally { db.close(); }
    symlinkSync('/missing-private-key-target', database + '.mcp-key');
    const response = await fetch(app.origin + '/api/host-metrics'); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.cpu.scope, 'host'); assert.equal(body.cpu.percent, null); assert(body.process.rss > 0); assert(!JSON.stringify(body).includes(httpDir));
    assert.equal(body.process.cpuPercent, null);
    assert(body.storage.files.some((file: { kind: string; status: string }) => file.kind === 'mcp-key' && file.status === 'not-regular'));
    assert(body.storage.files.some((file: { kind: string; status: string }) => file.kind === 'rollback-journal' && file.status === 'missing'));
    assert(BigInt(body.storage.reusableBytes) > 0n);
    assert(BigInt(body.storage.databaseBytes) >= BigInt(body.storage.reusableBytes));
    assert(!JSON.stringify(body).includes('/missing'));
    assert.deepEqual(await (await fetch(app.origin + '/api/host-metrics')).json(), body);
    assert.equal((await fetch(app.origin + '/api/host-metrics?path=/etc/passwd')).status, 400);
    assert.equal((await fetch(app.origin + '/api/host-metrics', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    await new Promise(resolve => setTimeout(resolve, 2100));
    const second = await (await fetch(app.origin + '/api/host-metrics')).json(); assert(second.cpu.intervalMs >= 2000); assert(second.cpu.percent === null || second.cpu.percent >= 0 && second.cpu.percent <= 100); assert(second.process.cpuPercent >= 0);
  } finally { await app.close(); rmSync(httpDir, { recursive: true, force: true }); }
});
