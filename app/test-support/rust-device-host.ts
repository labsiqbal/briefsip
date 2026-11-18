import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ProtocolError } from '../shared/protocol.ts';
import { rustBinary } from '../rust-binary.ts';

type Options = { database: string; server: string; keyring: string };
type Enrollment = { origin: string; tokenFile: string; expiresAt: number };
type Connection = { phase: 'connecting' | 'connected' | 'backoff' | 'blocked' | 'offline'; generation: number };

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
    if (!response.ok || result.ok !== true) throw new Error(`Rust device enrollment denied: ${response.status} ${result.error?.code}`);
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
