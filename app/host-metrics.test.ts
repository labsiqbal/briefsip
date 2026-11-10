import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { cpuPercent, processCpuPercent, diskMetrics, memoryAvailable, createHostMetrics } from './host-metrics.ts';
import { startApp } from './server.ts';

test('CPU units, disk reservations/thresholds and available memory retain honest semantics', () => {
  const before = { idle: 100, total: 200, cores: 2 };
  assert.equal(cpuPercent(null, before), null);
  assert.equal(cpuPercent(before, { idle: 120, total: 300, cores: 2 }), 80);
  assert.equal(cpuPercent(before, { ...before, cores: 4 }), null);
  assert.equal(cpuPercent(before, before), null);
  assert.equal(cpuPercent(before, { idle: 90, total: 300, cores: 2 }), null);
  assert.equal(processCpuPercent({ time: 0, user: 0, system: 0 }, { time: 1000, user: 1000000, system: 0 }), 100);
  assert.equal(processCpuPercent({ time: 0, user: 0, system: 0 }, { time: 1000, user: 1000000, system: 1000000 }), 200);
  assert.equal(processCpuPercent(null, { time: 1, user: 1, system: 0 }), null);
  assert.equal(memoryAvailable('MemTotal: 1000 kB\nMemAvailable: 900 kB\n'), 921600);
  assert.equal(memoryAvailable('MemFree: 900 kB\n'), null); assert.equal(memoryAvailable('MemAvailable: -1 kB\n'), null);
  assert.deepEqual(diskMetrics({ blocks: 100n, bfree: 20n, bavail: 10n, bsize: 1024n }), { total: '102400', available: '10240', used: '81920', reserved: '10240', percent: 88.8, pressure: 'normal' });
  assert.equal(diskMetrics({ blocks: 100n, bfree: 10n, bavail: 9n, bsize: 1024n })?.pressure, 'warning');
  assert.equal(diskMetrics({ blocks: 100n, bfree: 10n, bavail: 1n, bsize: 1024n })?.pressure, 'critical');
  assert.equal(diskMetrics({ blocks: 0n, bfree: 0n, bavail: 0n, bsize: 1n }), null);
  assert.equal(diskMetrics({ blocks: 100n, bfree: 1n, bavail: 2n, bsize: 1n }), null);
  assert.equal(diskMetrics({ blocks: 9007199254740993n, bfree: 2n, bavail: 1n, bsize: 4096n })?.total, (9007199254740993n * 4096n).toString());
});

test('local metrics share collection, distinguish missing/symlink files and do not follow supplied paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-host-metrics-')), database = join(dir, 'state.sqlite');
  const db = new DatabaseSync(database);
  try {
    db.exec('CREATE TABLE data(bytes BLOB); INSERT INTO data VALUES (zeroblob(32768)); DELETE FROM data;');
    symlinkSync('/missing-private-key-target', database + '.mcp-key');
    const read = createHostMetrics(db, database), first = read(); assert.equal(read(), first);
    const value = await first; assert.equal(value.cpu.percent, null); assert.equal(value.process.cpuPercent, null);
    assert.equal(value.storage.files.find(file => file.kind === 'mcp-key')?.status, 'not-regular');
    assert.equal(value.storage.files.find(file => file.kind === 'wal')?.status, 'missing');
    assert(BigInt(value.storage.reusableBytes) > 0n); assert(BigInt(value.storage.databaseBytes) >= BigInt(value.storage.reusableBytes));
    assert.deepEqual(await read(), value); assert(!JSON.stringify(value).includes(dir)); assert(!JSON.stringify(value).includes('/missing'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  const httpDir = mkdtempSync(join(tmpdir(), 'briefsip-metrics-http-')), app = await startApp({ database: join(httpDir, 'state.sqlite') });
  try {
    const response = await fetch(app.origin + '/api/host-metrics'); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.cpu.scope, 'host'); assert.equal(body.cpu.percent, null); assert(body.process.rss > 0); assert(!JSON.stringify(body).includes(httpDir));
    assert.equal((await fetch(app.origin + '/api/host-metrics?path=/etc/passwd')).status, 400);
    assert.equal((await fetch(app.origin + '/api/host-metrics', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    await new Promise(resolve => setTimeout(resolve, 2100));
    const second = await (await fetch(app.origin + '/api/host-metrics')).json(); assert(second.cpu.intervalMs >= 2000); assert(second.cpu.percent === null || second.cpu.percent >= 0 && second.cpu.percent <= 100); assert(second.process.cpuPercent >= 0);
  } finally { await app.close(); rmSync(httpDir, { recursive: true, force: true }); }
});
