import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('Rust Hermes availability survives a cold ACP start', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-hermes-probe-'));
  const executable = join(directory, 'hermes');
  writeFileSync(executable, `#!${process.execPath}\n` + `
import { appendFileSync } from 'node:fs';

const log = process.argv[1] + '.json';
if (process.argv.includes('--version')) {
  process.stdout.write('hermes 0.22.2\\n');
  process.exit(0);
}
appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), env: { HERMES_YOLO_MODE: process.env.HERMES_YOLO_MODE, HERMES_ACP_SKIP_CONFIGURED_MCP: process.env.HERMES_ACP_SKIP_CONFIGURED_MCP, HERMES_DISABLE_LAZY_INSTALLS: process.env.HERMES_DISABLE_LAZY_INSTALLS } }) + '\\n');
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
  chmodSync(executable, 0o700);
  const priorPath = process.env.PATH;
  process.env.PATH = `${directory}:${priorPath ?? ''}`;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database: join(directory, 'state.sqlite') });
    const response = await fetch(app.origin + '/api/runtimes');
    assert.equal(response.status, 200);
    const hermes = (await response.json()).choices.find((choice: { runtime: string }) => choice.runtime === 'hermes');
    assert.deepEqual(hermes, { runtime: 'hermes', available: true, version: 'hermes 0.22.2', signedIn: true, models: [], reason: null, label: 'Hermes', enabled: true });
    const probe = JSON.parse(readFileSync(logPath(executable), 'utf8'));
    assert.deepEqual(probe.args, ['acp']);
    assert.deepEqual(probe.env, { HERMES_YOLO_MODE: '0', HERMES_ACP_SKIP_CONFIGURED_MCP: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' });
  } finally {
    await app?.close();
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

function logPath(executable: string) {
  return executable + '.json';
}
