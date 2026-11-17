import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

type Config = { baseURL?: string; apiKey?: string; defaultModel?: string; provider?: string; accounts?: unknown; timeout?: number; concurrency?: number; workspaces?: unknown; projectRoot?: string; harness?: unknown; stream?: boolean; streamTermination?: string; maxTokens?: number; database: string; port?: number; host?: string; tls?: { cert: string; key: string }; allowedOrigins?: string[]; dist?: string; auth?: { secretKey: string; publishableKey: string; issuer: string; origin: string; development?: boolean; audience?: string; jwtKey?: string; apiUrl?: string }; fixedClock?: number };
export async function startRustServer(options: Config) {
  if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32)) throw new Error('BRIEFSIP_CONCURRENCY must be 1..32');
  const supported = new Set(['database', 'port', 'host', 'tls', 'allowedOrigins', 'dist', 'auth', 'fixedClock', 'baseURL', 'apiKey', 'defaultModel', 'provider', 'accounts', 'timeout', 'concurrency', 'workspaces', 'projectRoot', 'harness', 'stream', 'streamTermination', 'maxTokens']);
  for (const key of Object.keys(options)) if (!supported.has(key)) throw new Error(`not ported: option ${key} (see crates/PORTING.md)`);
  const config = JSON.stringify(options, (key, value) => { if (typeof value === 'function') throw new Error(`not ported: function option ${key} (see crates/PORTING.md)`); return value; });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const binary = process.env.BRIEFSIP_RUST_BINARY ?? resolve(root, 'target/debug/briefsip-server');
  const child = spawn(binary, ['--test-config'], { cwd: root, env: { ...process.env, BRIEFSIP_TEST_SERVER: 'rust' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>(closed => child.once('close', () => closed()));
  let stderr = '', stdout = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr = (stderr + value).slice(-8192); });
  child.stdout.setEncoding('utf8');
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ ...JSON.parse(config), database: resolve(options.database), port: options.port ?? 0 }));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    try { await exited; } finally { clearTimeout(timeout); }
  })();
  try {
    const origin = await new Promise<string>((ready, reject) => {
      const timeout = setTimeout(() => reject(new Error('Rust test server readiness timed out.')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      void exited.then(() => { clearTimeout(timeout); reject(Object.assign(new Error(`Rust test server exited: ${stderr.trim()}`), /Address already in use/.test(stderr) ? { code: 'EADDRINUSE' } : {})); });
      child.stdout.on('data', value => { stdout = (stdout + value).slice(-8192); const match = /^Briefsip: (https?:\/\/[^\r\n]+)$/m.exec(stdout); if (match) { clearTimeout(timeout); ready(match[1]); } });
    });
    return { origin, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
