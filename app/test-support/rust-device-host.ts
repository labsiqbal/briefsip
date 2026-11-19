import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { ProtocolError } from '../shared/protocol.ts';
import { rustBinary } from '../rust-binary.ts';
import type { ActionContext, Ownership } from './task-protocol.ts';

type Options = { database: string; server: string; keyring: string };
type Enrollment = { origin: string; tokenFile: string; expiresAt: number };
type Connection = { phase: 'connecting' | 'connected' | 'backoff' | 'blocked' | 'offline'; generation: number };

type Task = { taskId: string; ownership: Ownership; revision: number };
type Recovery = { taskId: string; actionId: string; state?: string; error?: string };
type Action = {
  taskId: string; actionId: string; sequence: number; actionKind: string; ownership: Ownership;
  payload: unknown; context: ActionContext; grantRevision: number; bindingId?: string;
  bindingRevision?: number; resolutionRequestId?: string;
};

export async function startDeviceFetchProxy(canonical: () => string) {
  let assertion: unknown;
  let dropped: Error | undefined;
  const proxy = createServer(async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const headers = new Headers();
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
      }
      const origin = canonical();
      headers.delete('host');
      if (headers.has('origin')) headers.set('origin', origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const upstream = await fetch(origin + req.url, { method: req.method, headers, body, signal: controller.signal, redirect: 'error' });
      if (res.destroyed) { await upstream.body?.cancel(); return; }
      const responseHeaders = Object.fromEntries(upstream.headers);
      for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete responseHeaders[key];
      res.writeHead(upstream.status, responseHeaders);
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            if (!res.write(next.value)) await once(res, 'drain', { signal: controller.signal });
          }
        } finally { reader.releaseLock(); }
      }
      res.end();
    } catch (error) {
      if (error instanceof Error && error.name === 'AssertionError') assertion ??= error;
      if (!controller.signal.aborted && error instanceof Error && error.constructor === Error) dropped = error;
      res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => proxy.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Device proxy address missing.');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    faultError(error: unknown) {
      const fault = dropped;
      dropped = undefined;
      if (assertion) return assertion;
      if (fault && error instanceof ProtocolError && error.code === 'device_offline')
        return new ProtocolError(error.status, error.code, fault.message);
      return error;
    },
    async close() {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      if (assertion) throw assertion;
    },
  };
}

export async function withDeviceProvider<T>(provide: (context: ActionContext) => unknown, run: (origin: string) => Promise<T>) {
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(JSON.stringify(await provide(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
    } catch (error) {
      failure = error;
      res.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture provider address missing.');
    const result = await run(`http://127.0.0.1:${address.port}`);
    if (failure) throw failure;
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export function rustDeviceFixture(database: string, proxy: Awaited<ReturnType<typeof startDeviceFetchProxy>>) {
  const keyring = database + '.keys.json';
  const options = { database, server: proxy.origin, keyring };
  if (!existsSync(keyring)) writeFileSync(keyring, '{}', { mode: 0o600 });
  let child: ReturnType<typeof worker> | undefined;
  let state: Connection = { phase: 'offline', generation: 0 };
  let results: Recovery[] = [];
  let startupFailure: unknown;
  function worker() {
    const process = spawn(rustBinary('briefsip-server', globalThis.process.env.BRIEFSIP_RUST_BINARY),
      hostArgs(options, ['--test-control']), { env: hostEnv(options), stdio: ['pipe', 'pipe', 'pipe'] });
    let sequence = 0, stderr = '', exitError: Error | undefined;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
    process.stdin.on('error', () => {});
    process.stderr.setEncoding('utf8').on('data', value => { stderr = (stderr + value).slice(-8192); });
    process.on('error', error => { exitError = error; });
    createInterface({ input: process.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if ('phase' in message) { state = message; return; }
      if ('recovery' in message) { results = message.recovery; return; }
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      if (message.error) {
        const { status, code, message: reason } = message.error;
        operation.reject(proxy.faultError(new ProtocolError(status, code, reason)));
      } else {
        operation.resolve(message.value);
      }
    });
    const exited = new Promise<void>(resolve => process.once('close', () => {
      exitError ??= new Error(stderr.trim() || 'Rust device fixture stopped.');
      for (const operation of pending.values()) operation.reject(exitError);
      pending.clear();
      resolve();
    }));
    return {
      call<T>(op: string, args: object) {
        return new Promise<T>((resolve, reject) => {
          if (exitError) { reject(exitError); return; }
          const id = ++sequence;
          pending.set(id, { resolve: value => resolve(value as T), reject });
          process.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
        });
      },
      async close() {
        if (!process.stdin.writableEnded) process.stdin.end();
        const timeout = setTimeout(() => {
          if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
        }, 5000);
        try { await exited; } finally { clearTimeout(timeout); }
      },
    };
  }
  const call = <T>(op: string, args = {}) => (child ??= worker()).call<T>(op, args);
  return {
    options,
    keys: { get values() { return new Map(Object.entries(JSON.parse(readFileSync(keyring, 'utf8')) as Record<string, string>)); } },
    deviceId: () => String(JSON.parse(readFileSync(database + '.host/identity.json', 'utf8')).deviceId),
    async enroll(token: string, mode: 'new' | 'reenroll' | 'rotate' = 'new') {
      try { return await enrollRustDevice(options, token, mode); }
      catch (error) { throw proxy.faultError(error); }
    },
    connect() {
      state = { phase: 'connecting', generation: state.generation };
      const connected = call<void>('connect');
      void connected.catch(error => { startupFailure = error; });
      return {
        state: () => { if (startupFailure) throw startupFailure; return state; },
        stop: async () => { await connected; await call('disconnect'); },
      };
    },
    startTask: (taskId: string) => call<Task>('start-task', { taskId }),
    taskContext: (taskId: string, ownership: Ownership, revision: number) => call<ActionContext>('context', { taskId, ownership, revision }),
    acquireTask: (taskId: string, lockProof: Record<string, unknown>, previousExecutorGeneration: number, requestId: string) =>
      call<Task>('acquire', { taskId, requestId, lockProof, previousExecutorGeneration }),
    prepareTask: (taskId: string, actionId: string, body: object) => call('prepare', { taskId, actionId, body }),
    commitTask: (taskId: string, actionId: string, body: object) => call('commit', { taskId, actionId, body }),
    reconcileTask: (taskId: string, body: object) => call('reconcile', { taskId, body }),
    completeTask: (taskId: string, actionId: string) => call<{ data: { state: string; revision: number }; receipt: unknown }>('complete', { taskId, actionId }),
    executeAction: (input: Action, effect: () => unknown) => input.actionKind === 'canonical'
      ? call<Record<string, unknown>>('action', { input })
      : withDeviceProvider(effect, provider => call<Record<string, unknown>>('action', { input, provider })),
    runTask: (taskId: string, provide: (context: ActionContext) => unknown) =>
      withDeviceProvider(provide, provider => call<{ taskId: string; state: string }>('run-task', { taskId, provider })),
    recoverAction: (taskId: string, actionId: string) => call<{ state: string }>('recover-action', { taskId, actionId }),
    recoverPending: () => call<Recovery[]>('recover'),
    recoveryStatus: () => ({ results }),
    close: async () => { await child?.close(); },
  };
}

export async function startDeviceFaultProxy(canonical: () => string) {
  type Fault = { path: string; before?: () => Promise<void>; drop?: (status: number) => boolean };
  let fault: Fault | undefined;
  let origin: string;
  const server = createServer(async (incoming, outgoing) => {
    const hook = fault && incoming.url?.endsWith(fault.path) ? fault : undefined;
    try {
      await hook?.before?.();
      if (outgoing.destroyed) return;
      const target = new URL(canonical());
      const headers = { ...incoming.headers, host: target.host };
      if (headers.origin === origin) headers.origin = target.origin;
      const upstream = request(target, { method: incoming.method, path: incoming.url, headers }, reply => {
        if (hook?.drop?.(reply.statusCode!)) {
          reply.resume();
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(outgoing);
        reply.on('error', () => outgoing.destroy());
      });
      outgoing.once('close', () => upstream.destroy());
      upstream.on('error', () => outgoing.destroy());
      incoming.pipe(upstream);
    } catch {
      outgoing.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Device proxy address missing.');
  origin = 'http://127.0.0.1:' + address.port;
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { origin, fault: (next?: Fault) => { fault = next; }, close };
}

function hostArgs(options: Options, command: string[] = []) {
  return ['--device-host', ...command, '--server', options.server, '--test-keyring', options.keyring];
}

function hostEnv(options: Options) {
  return { ...process.env, BRIEFSIP_TEST_SERVER: 'rust', BRIEFSIP_DEVICE_DB: options.database, BRIEFSIP_DEVELOPMENT: '1' };
}

function launch(options: Options, enrollment?: 'new' | 'reenroll' | 'rotate') {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  const args = hostArgs(options, enrollment ? ['enroll'] : []);
  if (enrollment && enrollment !== 'new') args.push('--' + enrollment);
  const child = spawn(binary, args, { env: hostEnv(options), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', launchError: Error | undefined;
  child.stderr.setEncoding('utf8').on('data', value => { stderr = (stderr + value).slice(-8192); });
  child.on('error', error => { launchError = error; });
  const lines = createInterface({ input: child.stdout });
  let last: Enrollment | Connection | undefined;
  lines.on('line', line => { last = JSON.parse(line); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  function failure() { return launchError ?? new Error(stderr.trim() || 'Rust device host exited before readiness.'); }
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const ready = async <T extends Enrollment | Connection>(select: (value: Enrollment | Connection) => value is T) => {
    const deadline = performance.now() + 15_000;
    while (!last || !select(last)) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) { await exited; throw failure(); }
      if (performance.now() >= deadline) throw new Error('Rust device host readiness timed out.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return last;
  };
  return { ready, state: () => last, stop, wait: async () => { await exited; if (child.exitCode !== 0) throw failure(); } };
}

export async function startRustDeviceEnrollment(options: Options, mode: 'new' | 'reenroll' | 'rotate' = 'new') {
  const process = launch(options, mode);
  try {
    const result = await process.ready((value): value is Enrollment => 'origin' in value);
    return { ...result, close: process.stop, wait: process.wait };
  } catch (error) {
    await process.stop();
    throw error;
  }
}

export function startRustDeviceConnection(options: Options) {
  const process = launch(options);
  return {
    state: () => {
      const value = process.state();
      return value && 'phase' in value ? value : undefined;
    },
    ready: () => process.ready((value): value is Connection => 'phase' in value && value.phase === 'connected'),
    wait: process.wait,
    stop: process.stop,
  };
}

export async function enrollRustDevice(options: Options, clerkToken: string, mode: 'new' | 'reenroll' | 'rotate' = 'new') {
  const enrollment = await startRustDeviceEnrollment(options, mode);
  try {
    const response = await fetch(enrollment.origin + '/local/link-proof', {
      method: 'POST',
      headers: {
        Origin: enrollment.origin,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + await readFile(enrollment.tokenFile, 'utf8'),
      },
      body: JSON.stringify({ requestId: randomUUID(), clerkToken }),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new ProtocolError(response.status, result.error?.code, `Rust device enrollment denied: ${response.status} ${result.error?.code}`);
    await enrollment.wait();
    return result.data as { deviceId: string; generation: number };
  } finally { await enrollment.close(); }
}

export function startRustDeviceTask(options: Options, taskId: string, provider: string, checkpoint?: string) {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  const args = hostArgs(options, ['run-task', taskId]);
  args.push('--test-provider', provider);
  if (checkpoint) args.push('--test-checkpoint', checkpoint);
  return spawn(binary, args, { env: hostEnv(options), timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

export type RecoveryExport = {
  requestId: string; recoveryGeneration: string; envelope: { entries: import('./task-protocol.ts').JournalEntry[] }; signature: string; resultContent?: unknown;
};

export function exportRustDeviceRecovery(options: Options, taskId: string, actionIds: string[], requestId: string, recoveryGeneration: string, withContent = false): RecoveryExport {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  try {
    const output = execFileSync(binary, hostArgs(options, ['export-recovery']), {
      env: hostEnv(options), encoding: 'utf8', maxBuffer: 9 * 1024 * 1024, timeout: 15_000,
      input: JSON.stringify({ taskId, actionIds, requestId, recoveryGeneration, withContent }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  } catch (error) {
    const line = (error as { stderr?: string }).stderr?.split('\n')[0];
    if (line?.startsWith('{')) {
      const failure = JSON.parse(line);
      throw new ProtocolError(failure.status, failure.code, failure.message);
    }
    throw error;
  }
}

export async function runRustDeviceTask(options: Options, taskId: string, provider: string) {
  const child = startRustDeviceTask(options, taskId, provider);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code === 0) return JSON.parse(stdout) as { taskId: string; state: string };
  const first = stderr.split('\n').find(line => line.startsWith('{'));
  if (first?.startsWith('{')) {
    const failure = JSON.parse(first);
    throw new ProtocolError(failure.status, failure.code, failure.message);
  }
  throw new Error(stderr.trim() || 'Rust task host exited before reporting a result.');
}

export async function crashRustDeviceTask(options: Options, taskId: string, provider: string, checkpoint: string) {
  const child = startRustDeviceTask(options, taskId, provider, checkpoint);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise<NodeJS.Signals | null>(resolve => child.once('close', (_code, signal) => resolve(signal)));
  try {
    const message = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child.once('error', reject);
      void closed.then(() => reject(new Error(stderr.trim() || 'Rust task host exited before the checkpoint.')));
    });
    if (JSON.parse(message).checkpoint !== checkpoint) throw new Error(`Expected Rust task checkpoint ${checkpoint}.`);
    child.kill('SIGKILL');
    if (await closed !== 'SIGKILL') throw new Error('Rust task host did not stop at the crash checkpoint.');
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}
