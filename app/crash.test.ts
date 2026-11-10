import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from './server.ts';

test('SIGKILL after delegated provider acceptance does not replay parent or child', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-crash-'));
  let calls = 0, accepted!: () => void;
  const childAccepted = new Promise<void>(resolve => { accepted = resolve; });
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls++;
    if (data.messages.at(-1).content === 'child') { accepted(); return; }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'child-call', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ recipient: data.tools[0].function.parameters.properties.recipient.enum[0], task: 'child' }) } }],
    } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  const source = new URL('./server.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {startApp} from ${JSON.stringify(source)}; const app=await startApp(JSON.parse(process.env.BRIEFSIP_TEST_OPTIONS)); console.log(app.origin);`],
  { env: { ...process.env, BRIEFSIP_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stderr.resume();
  const output = createInterface({ input: child.stdout });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const [origin] = await Promise.race([once(output, 'line'), exited.then(() => { throw Error('Fixture process exited before startup'); })]);
    async function post(path: string, data: unknown) {
      const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      assert(response.ok); return response.json();
    }
    const alpha = await post('/api/agents', { id: randomUUID(), name: 'Alpha', model: 'fixture', instructions: 'Delegate.' });
    const beta = await post('/api/agents', { id: randomUUID(), name: 'Beta', model: 'fixture', instructions: 'Execute.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Crash check', instructions: 'Coordinate.', members: [alpha.id, beta.id], lead: alpha.id });
    const path = `/api/channels/${channel.id}/turns`, id = randomUUID();
    await post(path, { id, text: 'root' }); await childAccepted;
    child.kill('SIGKILL');
    assert.equal((await exited)[1], 'SIGKILL');
    app = await startApp(options);
    const rows = await (await fetch(app.origin + path)).json();
    assert.equal(rows.length, 2);
    const parent = rows.find((row: { id: string }) => row.id === id);
    const delegated = rows.find((row: { parent: string }) => row.parent === id);
    assert.equal(parent.status, 'interrupted'); assert.equal(delegated.status, 'interrupted');
    assert.equal(parent.agent, alpha.id); assert.equal(delegated.agent, beta.id);
    assert.equal(parent.coordination.length, 1); assert.equal(parent.coordination[0].child, delegated.id);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(calls, 2);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (app) await app.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
