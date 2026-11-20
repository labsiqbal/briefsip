import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startApp } from './test-bridge.ts';

test('cold runtime catalog probes in parallel and shares one refresh', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-catalog-latency-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'harness');
  const calls = join(directory, 'calls');
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$1" >> '${calls}'
case "$1" in
  --version) /bin/sleep 0.6; printf 'fixture 1.0\\n';;
  --help) /bin/sleep 0.6; printf '  acp\\n';;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const runtimes = ['codex', 'claude', 'hermes', 'antigravity', 'grok', 'pi', 'opencode', 'gemini', 'kiro'];
  const app = await startApp({
    database: join(directory, 'db.sqlite'),
    harness: { executables: Object.fromEntries(runtimes.map(runtime => [runtime, runtime === 'hermes' ? join(directory, 'missing') : executable])) },
  });
  try {
    const start = performance.now();
    const request = async () => {
      const response = await fetch(app.origin + '/api/runtimes', { signal: t.signal });
      assert.equal(response.status, 200);
      return response.json();
    };
    const catalogs = await Promise.all(Array.from({ length: 3 }, request));
    const elapsed = performance.now() - start;
    const probes = readFileSync(calls, 'utf8').trim().split('\n');
    console.log('Cold runtime catalog %d ms, %d version probes', Math.round(elapsed), probes.filter(call => call === '--version').length);
    assert.deepEqual(catalogs[0], catalogs[1]);
    assert.deepEqual(catalogs[0], catalogs[2]);
    assert.deepEqual(catalogs[0].choices.map((choice: { runtime: string }) => choice.runtime), runtimes);
    assert.equal(catalogs[0].defaultRuntime, 'codex');
    assert.equal(catalogs[0].choices[0].version, 'fixture 1.0');
    assert.equal(catalogs[0].choices[2].reason, 'Version check failed or timed out. Check the harness installation on this host.');
    assert.equal(catalogs[0].choices[3].reason, 'Installed command did not pass the harness protocol check. Check its ACP support and host login.');
    assert.deepEqual(await request(), catalogs[0]);
    assert(elapsed < 3500, `Cold catalog took ${elapsed.toFixed(0)} ms`);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').filter(call => call === '--version').length, 8);
  } finally {
    await app.close();
  }
});

test('room POST latency stays flat behind a held discussion', { timeout: 45_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-room-latency-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const provider = createServer(request => {
    request.resume();
    calls++;
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  });
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  try {
    const post = async (path: string, body: object, status: number) => {
      const response = await fetch(app.origin + path, {
        method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: t.signal,
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    };
    const agents = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of agents.entries()) {
      await post('/api/agents', { id, name: `Member ${index}`, runtime: 'api', model: 'fixture', instructions: 'Help' }, 201);
    }
    const channel = randomUUID();
    await post('/api/channels', { id: channel, name: 'Room', members: agents, lead: null, instructions: 'Help' }, 201);
    const path = `/api/channels/${channel}/turns`;
    const [, held] = await Promise.all([
      once(provider, 'request', { signal: t.signal }),
      post(path, { id: randomUUID(), text: 'Hold discussion' }, 202),
    ]);
    const depths = [10, 50, 100];
    const timings = new Map<number, number>();
    // Add a single addressed turn when three new room members would skip a measurement depth.
    for (let queued = 2; queued < 115;) {
      const recipient = depths.some(depth => depth > queued && depth < queued + 3) ? held.agent : undefined;
      const id = randomUUID();
      const start = performance.now();
      assert.equal((await post(path, { id, recipient, text: 'Queued discussion' }, 202)).id, id);
      if (!recipient) timings.set(queued, performance.now() - start);
      queued += recipient ? 1 : 3;
    }
    const medians = depths.map(depth => {
      const exact = timings.get(depth);
      assert(exact !== undefined);
      const samples = [...timings].filter(([queued]) => Math.abs(queued - depth) <= 7).map(([, ms]) => ms).sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      console.log('Room POST at N=%d: %s ms (nearby median %s ms)', depth, exact.toFixed(2), median.toFixed(2));
      return median;
    });
    assert.equal(calls, 1);
    assert(medians[2] < medians[0] * 4 + 15, 'Room POST latency grows with the queue');
  } finally {
    await app.close();
  }
});

test('a free turn is admitted while other requests keep writing', { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-write-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const models: string[] = [];
  const provider = createServer(request => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => { models.push(JSON.parse(raw).model); provider.emit('model', JSON.parse(raw).model); });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  });
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` });
  let writing = true;
  try {
    const post = async (path: string, body: object, status: number) => {
      const response = await fetch(app.origin + path, {
        method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: t.signal,
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    };
    const members = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of members.entries()) {
      await post('/api/agents', { id, name: `Member ${index}`, runtime: 'api', model: 'member', instructions: 'Help' }, 201);
    }
    const free = randomUUID();
    await post('/api/agents', { id: free, name: 'Free', runtime: 'api', model: 'free', instructions: 'Help' }, 201);
    const channel = randomUUID();
    await post('/api/channels', { id: channel, name: 'Room', members, lead: null, instructions: 'Help' }, 201);
    // A held discussion keeps a deep room queue, which makes each queue scan slower.
    await Promise.all([once(provider, 'model', { signal: t.signal }), post(`/api/channels/${channel}/turns`, { id: randomUUID(), text: 'Hold' }, 202)]);
    for (let index = 0; index < 20; index++) await post(`/api/channels/${channel}/turns`, { id: randomUUID(), text: 'Queued' }, 202);
    // Every agent created here commits a write, so a snapshot taken by the scheduler goes stale.
    const writers = Array.from({ length: 4 }, async () => {
      while (writing) await post('/api/agents', { id: randomUUID(), name: 'Writer', runtime: 'api', model: 'writer', instructions: 'Help' }, 201);
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const start = performance.now();
    const admitted = new Promise<void>(resolve => { const listen = (model: string) => { if (model === 'free') { provider.off('model', listen); resolve(); } }; provider.on('model', listen); });
    await post(`/api/agents/${free}/turns`, { id: randomUUID(), text: 'Free work' }, 202);
    const outcome = await Promise.race([admitted.then(() => 'admitted'), new Promise(resolve => setTimeout(() => resolve('starved'), 3000))]);
    const elapsed = performance.now() - start;
    writing = false;
    await Promise.all(writers);
    console.log('Free turn admission under writes: %s after %d ms', outcome, Math.round(elapsed));
    assert.equal(outcome, 'admitted', `Free turn was not admitted within ${elapsed.toFixed(0)} ms while writes continued`);
  } finally {
    writing = false;
    await app.close();
  }
});
