import { spawn } from 'node:child_process';
import { rustBinary } from './rust-binary.ts';

export async function runRustConnector(platform: 'slack' | 'telegram', options: object, signal: AbortSignal) {
  const binary = rustBinary('minarbot-server', process.env.MINARBOT_RUST_BINARY);
  if (signal.aborted) return;
  const child = spawn(binary, ['--connector-config'], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, MINARBOT_TEST_SERVER: 'rust' } });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr = (stderr + value).slice(-2048); });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ platform, ...options }));
  const stop = () => child.kill('SIGTERM');
  signal.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { if (signal.aborted || code === 0) resolve(); else reject(new Error(stderr.trim() || 'Rust connector stopped.')); });
    });
  } finally { signal.removeEventListener('abort', stop); }
}
export async function runRustConnectorJournal(command: object) {
  const child = spawn(rustBinary('minarbot-server', process.env.MINARBOT_RUST_BINARY), ['--connector-journal-config'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MINARBOT_TEST_SERVER: 'rust' } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  child.stdin.end(JSON.stringify(command));
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', value => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(stderr.trim() || 'Rust connector journal command failed.');
  return JSON.parse(stdout);
}
