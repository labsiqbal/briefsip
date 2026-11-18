import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { rustBinary } from '../rust-binary.ts';

type Options = { database: string; server: string; keyring: string };
type Enrollment = { origin: string; tokenFile: string; expiresAt: number };
type Connection = { phase: 'connecting' | 'connected' | 'backoff' | 'blocked' | 'offline'; generation: number };

function launch(options: Options, enrollment?: 'new' | 'reenroll' | 'rotate') {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  const args = ['--device-host', ...(enrollment ? ['enroll'] : []), '--server', options.server, '--test-keyring', options.keyring];
  if (enrollment && enrollment !== 'new') args.push('--' + enrollment);
  const child = spawn(binary, args, { env: {
    ...process.env, BRIEFSIP_TEST_SERVER: 'rust', BRIEFSIP_DEVICE_DB: options.database, BRIEFSIP_DEVELOPMENT: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function enrollRustDevice(options: Options, clerkToken: string) {
  const enrollment = await startRustDeviceEnrollment(options);
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
