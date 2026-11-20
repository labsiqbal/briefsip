import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as controlServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { rustBinary } from './rust-binary.ts';
import { testDatabase } from './test-support/database.ts';

async function api<T>(origin: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const call = request(origin + path, body === undefined ? {} : {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    }, async response => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString();
        assert([200, 201, 202].includes(response.statusCode ?? 0), text);
        resolve(JSON.parse(text));
      } catch (error) { reject(error); }
    });
    call.once('error', reject).end(body === undefined ? undefined : JSON.stringify(body));
  });
}

type Cleanup = (() => Promise<void>)[];
async function start(cleanup: Cleanup, dir: string, config: object) {
  const binary = rustBinary('minarbot-server', process.env.MINARBOT_RUST_BINARY);
  const child = spawn(binary, ['--test-config'], {
    env: { ...process.env, HOME: dir, MINARBOT_TEST_SERVER: 'rust', MINARBOT_TEST_PARENT: String(process.pid) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  cleanup.push(close);
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  child.stdin.end(JSON.stringify(config));
  const origin = await Promise.race([
    new Promise<string>(resolve => {
      let stdout = '';
      child.stdout.on('data', bytes => {
        stdout += String(bytes);
        const match = /^Minarbot: (http:\/\/[^\r\n]+)$/m.exec(stdout);
        if (match) resolve(match[1]);
      });
    }),
    exited.then(() => { throw Error('Peer fixture exited: ' + stderr); }),
  ]);
  return { origin, close, get stderr() { return stderr; } };
}

type Transfer = (upstream: IncomingMessage, downstream: ServerResponse) => Promise<void>;
async function fixture(t: TestContext, testPeerUpdateTimeoutMs?: number, relayApply = false) {
  const dir = await mkdtemp(join(tmpdir(), 'minarbot-peer-transfer-'));
  const cleanup: Cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });
  const releases = join(dir, 'releases'), received = join(dir, 'received');
  const from = { database: join(dir, 'from.sqlite'), port: 0, updates: { releasesDir: releases, testPeerUpdateTimeoutMs } };
  const to = { database: join(dir, 'to.sqlite'), port: 0, updates: { releasesDir: received, launcherSocket: join(dir, 'control.sock') } };
  let applied = 0, launcherAvailable = true;
  const control = controlServer(socket => socket.once('data', bytes => {
    const command = JSON.parse(bytes.toString());
    if (command.type === 'apply') applied++;
    socket.end(JSON.stringify(command.type === 'apply'
      ? { accepted: true, id: command.id }
      : { protocol: launcherAvailable ? 1 : 0, current: 'development' }) + '\n');
  }));
  control.listen(to.updates.launcherSocket);
  await once(control, 'listening');
  await chmod(to.updates.launcherSocket, 0o600);
  cleanup.push(() => new Promise<void>(resolve => control.close(() => resolve())));

  const initial = await start(cleanup, dir, from);
  let receiver = await start(cleanup, dir, to);
  const code = await api<{ code: string }>(receiver.origin, '/api/pairing-codes', { id: randomUUID() });
  const machine = await api<{ id: string }>(initial.origin, '/api/machines', {
    id: randomUUID(), origin: receiver.origin, code: code.code,
  });
  const back = (await api<{ machines: { id: string }[] }>(receiver.origin, '/api/machines')).machines[0];
  const setPermission = (origin: string, environmentId: string, allowed: boolean) =>
    api(origin, '/api/machines/updates', { id: randomUUID(), environmentId, allowed });
  await setPermission(initial.origin, machine.id, true);
  await setPermission(receiver.origin, back.id, true);

  let applyStarted = 0, applyResponse = 0;
  if (relayApply) {
    const origin = receiver.origin;
    await receiver.close();
    const relay = createServer((req, res) => {
      const apply = req.url === '/api/peer/updates/apply';
      if (apply && !applyStarted) applyStarted = performance.now();
      const upstream = request(receiver.origin + req.url, {
        method: req.method, headers: { ...req.headers, host: new URL(receiver.origin).host }, agent: false,
      }, async reply => {
        if (apply && !applyResponse) {
          applyResponse = performance.now();
          res.destroy();
          return reply.resume();
        }
        if (res.destroyed) return reply.resume();
        await forwardPeer(req, reply, res, origin).catch(() => res.destroy());
      });
      upstream.once('error', () => res.destroy());
      req.pipe(upstream);
    });
    relay.listen(Number(new URL(origin).port), '127.0.0.1');
    await once(relay, 'listening');
    cleanup.push(() => new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); }));
    receiver = await start(cleanup, dir, to);
  }

  // Keep the paired public origin stable while inserting the throttling proxy.
  await initial.close();
  let backend: string;
  const ranges: { range?: string; status?: number; length?: string }[] = [];
  let transfer: Transfer = forward;
  const proxy = createServer((req, res) => {
    const upstream = request(backend + req.url, {
      method: req.method, headers: { ...req.headers, host: new URL(backend).host }, agent: false,
    }, async reply => {
      try {
        if (req.url?.startsWith('/api/updates/releases/')) {
          ranges.push({ range: req.headers.range, status: reply.statusCode, length: reply.headers['content-length'] });
          await transfer(reply, res);
        } else {
          await forwardPeer(req, reply, res, initial.origin);
        }
      } catch { res.destroy(); }
    });
    upstream.once('error', () => res.destroy());
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(Number(new URL(initial.origin).port), '127.0.0.1');
  await once(proxy, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  backend = (await start(cleanup, dir, from)).origin;

  async function release(patch: number, payload: Buffer) {
    const version = '1.2.' + patch, id = version + '-abcdef12';
    const path = join(releases, id);
    await mkdir(path, { recursive: true });
    await mkdir(join(releases, 'feed'), { recursive: true });
    const files: Record<string, string> = {};
    for (const [name, bytes] of Object.entries({ 'package.json': Buffer.from(JSON.stringify({ version })), payload })) {
      await writeFile(join(path, name), bytes);
      files[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const manifest = { id, version, commit: 'abcdef12' + '0'.repeat(32), created: new Date().toISOString(), node: process.version, notes: '', files };
    for (const item of [join(path, 'release.json'), join(releases, 'feed/latest.json')]) {
      await writeFile(item, JSON.stringify(manifest));
    }
    return manifest;
  }
  type Attempt = {
    id: string; releaseId: string; version: string; state: string;
    bytesTransferred: number; totalBytes: number; startedAt: number; finishedAt: number | null;
    error: { code: string; message: string } | null;
  };
  return {
    release, ranges, received,
    get applied() { return applied; },
    get applyStarted() { return applyStarted; },
    get applyResponse() { return applyResponse; },
    get stderr() { return receiver.stderr; },
    setLauncher(available: boolean) { launcherAvailable = available; },
    setTransfer(handle: Transfer) { transfer = handle; },
    setReceiverPermission(allowed: boolean) { return setPermission(receiver.origin, back.id, allowed); },
    markSenderOfflineOnReceiver() {
      const db = testDatabase(to.database);
      try { db.prepare("UPDATE paired_machines SET status='offline'").run(); } finally { db.close(); }
    },
    async restartReceiver() {
      const port = Number(new URL(receiver.origin).port);
      await receiver.close();
      receiver = await start(cleanup, dir, { ...to, port });
    },
    async attempt() {
      const result = await api<{ machines: { fanOutAttempt: Attempt }[] }>(backend, '/api/updates/machines');
      return result.machines[0].fanOutAttempt;
    },
    async fanOut(version: string) {
      const result = await api<{ machines: { status: string; reason?: string }[] }>(backend, '/api/updates/fan-out', {
        id: randomUUID(), machines: [machine.id], version,
      });
      return result.machines[0];
    },
  };
}
async function forwardPeer(req: IncomingMessage, reply: IncomingMessage, res: ServerResponse, origin: string) {
  if (req.url === '/api/environment') {
    const chunks: Buffer[] = [];
    for await (const chunk of reply) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(reply.statusCode!, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...data, origin }));
  } else {
    res.writeHead(reply.statusCode!, reply.headers);
    reply.pipe(res);
  }
}

async function forward(reply: IncomingMessage, res: ServerResponse) {
  res.writeHead(reply.statusCode!, reply.headers);
  for await (const bytes of reply) res.write(bytes);
  res.end();
}
async function throttle(reply: IncomingMessage, res: ServerResponse, rate: number) {
  res.writeHead(reply.statusCode!, reply.headers);
  const started = performance.now();
  let emitted = 0;
  for await (const chunk of reply) {
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      const part = chunk.subarray(offset, offset + 8192);
      emitted += part.length;
      await delay(Math.max(0, emitted * 1000 / rate - (performance.now() - started)));
      if (res.destroyed) return;
      res.write(part);
    }
  }
  res.end();
}
async function drop(reply: IncomingMessage, res: ServerResponse) {
  res.writeHead(reply.statusCode!, reply.headers);
  for await (const bytes of reply) {
    res.write(bytes.subarray(0, 16384));
    await delay(30);
    res.destroy();
    return;
  }
}

test('peer fan-out follows receiver progress beyond the apply request deadline', { timeout: 90_000 }, async t => {
  const slow = process.env.MINARBOT_PEER_CONTROL === '1';
  const deadline = slow ? 49_000 : 1_000;
  const peers = await fixture(t, deadline, true);
  const release = await peers.release(11, randomBytes(slow ? 1_625_000 : 90_000));
  peers.setTransfer((reply, res) => throttle(reply, res, 25_000));
  const started = performance.now();
  const partialBytes = async () => {
    const partial = (await readdir(peers.received)).find(name => name.startsWith('.peer-release-partial-'));
    return partial ? (await stat(join(peers.received, partial))).size : 0;
  };
  const outcome = peers.fanOut(release.version);
  await delay(deadline + 350);
  const before = await partialBytes();
  const attempt = await peers.attempt();
  await delay(500);
  const after = await partialBytes();
  const replyMs = peers.applyResponse ? Math.round(peers.applyResponse - peers.applyStarted) : 'pending';
  t.diagnostic(`${attempt.state} ${attempt.error?.code ?? ''}, POST started +${Math.round(peers.applyStarted - started)} ms, reply latency ${replyMs} ms, receiver partial ${before} to ${after} bytes`);
  assert(before > 0 && after > before, `${before} to ${after}`);
  assert.equal(attempt.state, 'transferring');
  assert(attempt.bytesTransferred > 0 && attempt.bytesTransferred <= after);
  assert(peers.applyResponse > peers.applyStarted && peers.applyResponse - peers.applyStarted < deadline);
  assert.equal(peers.applied, 0);
  assert.equal((await outcome).status, 'accepted');
  const done = await peers.attempt();
  assert.equal(done.bytesTransferred, done.totalBytes);
  assert.equal(peers.applied, 1);
  t.diagnostic(`accepted after ${((performance.now() - started) / 1000).toFixed(2)} s`);
});

test('peer fan-out succeeds while the receiver still lists the restarted sender as offline', { timeout: 30000 }, async t => {
  const peers = await fixture(t);
  const release = await peers.release(1, randomBytes(65536));
  peers.markSenderOfflineOnReceiver();
  assert.equal((await peers.fanOut(release.version)).status, 'accepted');
  assert.equal(peers.applied, 1);
});

test('peer fan-out resumes dropped downloads, including after receiver restart', { timeout: 30000 }, async t => {
  const peers = await fixture(t), bytes = randomBytes(524288);
  const first = await peers.release(1, bytes);
  const progress: number[] = [];
  peers.setTransfer(async (reply, res) => {
    progress.push((await peers.attempt()).bytesTransferred);
    await (peers.ranges.length === 1 ? drop : forward)(reply, res);
  });
  assert.equal((await peers.fanOut(first.version)).status, 'accepted');
  assert.equal(peers.ranges.length, 2);
  assert.equal(peers.ranges[1].status, 206);
  assert.match(peers.ranges[1].range ?? '', /^bytes=[1-9]\d*-$/);
  const done = await peers.attempt();
  assert.equal(done.releaseId, first.id);
  assert.equal(done.state, 'accepted');
  assert.equal(done.error, null);
  assert.equal(done.bytesTransferred, done.totalBytes);
  assert(progress[0] <= progress[1] && progress[1] <= done.bytesTransferred);
  assert(done.finishedAt! >= done.startedAt);

  const second = await peers.release(2, bytes);
  peers.ranges.length = 0;
  peers.setTransfer(async (reply, res) => {
    if (peers.ranges.length === 1) return drop(reply, res);
    res.writeHead(502).end();
  });
  assert.equal((await peers.fanOut(second.version)).status, 'failed');
  assert.equal(peers.ranges.length, 4);
  assert.equal((await peers.attempt()).error?.code, 'peer_connection_lost');
  assert.match(peers.stderr, /code=peer_connection_lost/);
  assert.equal(peers.applied, 1);
  assert((await readdir(peers.received)).some(name => name.startsWith('.peer-release-partial-')));
  await peers.restartReceiver();
  peers.ranges.length = 0;
  peers.setTransfer(forward);
  assert.equal((await peers.fanOut(second.version)).status, 'accepted');
  assert.match(peers.ranges[0].range ?? '', /^bytes=[1-9]\d*-$/);
  assert.equal(peers.ranges[0].status, 206);
  assert.equal(peers.applied, 2);
  assert(!(await readdir(peers.received)).some(name => name.startsWith('.peer-release-partial-')));
});

test('peer fan-out reports receiver restart and can resume its retained partial', { timeout: 30000 }, async t => {
  const peers = await fixture(t);
  const release = await peers.release(9, randomBytes(524288));
  let retained = 0;
  let markPartial!: () => void;
  const partial = new Promise<void>(resolve => { markPartial = resolve; });
  peers.setTransfer(async (reply, res) => {
    res.writeHead(reply.statusCode!, reply.headers);
    for await (const bytes of reply) {
      const part = bytes.subarray(0, 16384);
      retained = part.length;
      res.write(part);
      markPartial();
      await once(res, 'close');
      return;
    }
  });
  const outcome = peers.fanOut(release.version);
  await partial;
  while (!(await peers.attempt()).bytesTransferred) await delay(100);
  await peers.restartReceiver();
  const interrupted = await outcome;
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.reason ?? '', /Receiving server restarted/);
  assert.equal(peers.applied, 0);
  assert(retained > 0);

  peers.ranges.length = 0;
  peers.setTransfer(forward);
  assert.equal((await peers.fanOut(release.version)).status, 'accepted');
  assert.deepEqual(peers.ranges.map(entry => [entry.range, entry.status]), [[`bytes=${retained}-`, 206]]);
  assert.equal(peers.applied, 1);
  assert(!(await readdir(peers.received)).some(name => name.startsWith('.peer-release-partial-')));
});

test('peer fan-out reports timeout, integrity, size, permission, and launcher failures', { timeout: 30000 }, async t => {
  const peers = await fixture(t);
  const bytes = randomBytes(524288);
  async function fails(patch: number, code: string, transfer: Transfer) {
    const release = await peers.release(patch, bytes);
    peers.setTransfer(transfer);
    const result = await peers.fanOut(release.version);
    assert.equal(result.status, 'failed', JSON.stringify(result));
    const attempt = await peers.attempt();
    assert.equal(attempt.state, 'failed');
    assert.equal(attempt.error?.code, code);
    assert.equal(attempt.error?.message, result.reason);
    assert.match(peers.stderr, new RegExp('code=' + code));
    assert(!(await readdir(peers.received)).includes(release.id));
    assert.equal(peers.applied, 0);
  }
  await fails(3, 'peer_transfer_timeout', async (_reply, res) => { res.writeHead(504).end(); });
  await fails(4, 'peer_integrity_mismatch', async (reply, res) => {
    res.writeHead(reply.statusCode!, reply.headers);
    let first = true;
    for await (const bytes of reply) {
      if (first) bytes[0] ^= 1;
      first = false;
      res.write(bytes);
    }
    res.end();
  });
  await fails(5, 'peer_size_limit', async (reply, res) => {
    res.writeHead(200, { ...reply.headers, 'content-length': 1073741825 });
    res.flushHeaders();
  });
  await fails(6, 'peer_permission_revoked', async (reply, res) => {
    res.writeHead(reply.statusCode!, reply.headers);
    let first = true;
    for await (const bytes of reply) {
      if (first) {
        await peers.setReceiverPermission(false);
      }
      first = false;
      res.write(bytes);
    }
    res.end();
  });
  await peers.setReceiverPermission(true);
  peers.setLauncher(false);
  await fails(7, 'peer_launcher_unavailable', forward);
});

if (process.env.MINARBOT_PEER_CONTROL === '1') {
  test('25 KB/s control keeps fan-out open beyond 60 seconds', { timeout: 90_000 }, async t => {
    const peers = await fixture(t);
    const release = await peers.release(10, randomBytes(1_625_000));
    peers.setTransfer((reply, res) => throttle(reply, res, 25_000));
    const started = performance.now();
    assert.equal((await peers.fanOut(release.version)).status, 'accepted');
    const elapsed = performance.now() - started;
    assert(elapsed > 60_000);
    assert.equal(peers.applied, 1);
    t.diagnostic(`accepted after ${(elapsed / 1000).toFixed(2)} s`);
  });
}

for (const rate of (process.env.MINARBOT_PEER_TEST_RATES ?? '').split(',').filter(Boolean).map(Number)) {
  test(`20.8 MB peer archive reaches launcher at ${rate / 1000} KB/s`, { timeout: 900_000, concurrency: true }, async t => {
    assert(rate === 30000 || rate === 160000);
    const peers = await fixture(t);
    const release = await peers.release(8, randomBytes(20_800_000));
    peers.setTransfer((reply, res) => throttle(reply, res, rate));
    const started = performance.now();
    assert.equal((await peers.fanOut(release.version)).status, 'accepted');
    const elapsed = performance.now() - started;
    const attempt = await peers.attempt();
    assert.equal(peers.applied, 1);
    assert(attempt.totalBytes > 20_800_000);
    assert(elapsed < (300 + Math.ceil(attempt.totalBytes / 8192)) * 1000);
    t.diagnostic(`${attempt.bytesTransferred} bytes in ${(elapsed / 1000).toFixed(2)}s`);
  });
}
