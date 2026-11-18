import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('Rust Hermes probes can read the host install without changing it', { timeout: 45000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-hermes-probe-'));
  const home = join(directory, 'home');
  const install = join(home, '.hermes', 'installs', 'fixture');
  const generation = join(install, 'environments', 'fixture');
  const leases = join(generation, '.leases');
  const lock = join(install, '.install.lock');
  mkdirSync(leases, { recursive: true });
  writeFileSync(join(install, 'facts.json'), 'committed');
  writeFileSync(join(generation, '.lease-managed'), '');
  writeFileSync(lock, 'host lock');
  const executable = join(directory, 'hermes');
  writeFileSync(executable, `#!${process.execPath}\n` + `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const install = join(process.env.HOME, '.hermes', 'installs', 'fixture');
if (readFileSync(join(install, 'facts.json'), 'utf8') !== 'committed') process.exit(1);
writeFileSync(join(install, '.install.lock'), 'probe lock');
writeFileSync(join(install, 'environments', 'fixture', '.leases', 'probe'), '');
if (process.env.HERMES_YOLO_MODE !== '0' || process.env.HERMES_ACP_SKIP_CONFIGURED_MCP !== '1' || process.env.HERMES_DISABLE_LAZY_INSTALLS !== '1') process.exit(1);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('hermes 0.22.2\\n');
  process.exit(0);
}
if (args.length !== 1 || args[0] !== 'acp') process.exit(1);
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  for (const line of pending.split('\\n').slice(0, -1)) {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [{ type: 'agent' }], models: [] } }) + '\\n'), 2500);
    }
  }
  pending = pending.slice(pending.lastIndexOf('\\n') + 1);
});
`, { mode: 0o700 });
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database: join(directory, 'state.sqlite'), testPathPrefix: directory });
    const response = await fetch(app.origin + '/api/runtimes');
    assert.equal(response.status, 200);
    const hermes = (await response.json()).choices.find((choice: { runtime: string }) => choice.runtime === 'hermes');
    assert.deepEqual(hermes, { runtime: 'hermes', available: true, version: 'hermes 0.22.2', signedIn: true, models: [], reason: null, label: 'Hermes', enabled: true });
    assert.equal(readFileSync(lock, 'utf8'), 'host lock');
    assert.deepEqual(readdirSync(leases), []);
  } finally {
    await app?.close();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(directory, { recursive: true, force: true });
  }
});
