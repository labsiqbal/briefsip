import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './test-bridge.ts';

async function shellFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'minarbot-rust-shell-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const args = new Map<string, Record<string, unknown>>();
  const results = new Map<string, unknown>();
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { messages } = JSON.parse(raw);
    const last = messages.at(-1);
    const result = last?.role === 'tool' ? last : null;
    const id = messages.findLast((message: { role: string }) => message.role === 'user').content;
    if (result) results.set(id, JSON.parse(result.content));
    const message = result ? { content: 'Checked shell result.' } : {
      tool_calls: [{ id, type: 'function', function: { name: 'run_shell', arguments: JSON.stringify(args.get(id)) } }],
    };
    res.end(JSON.stringify({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message }] }));
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => {
    await app?.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const writable = randomUUID(), readonly = randomUUID();
  const start = () => startApp({
    database: join(root, 'db.sqlite'),
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    workspaces: [{ agent: writable, directory: workspace, write: true }, { agent: readonly, directory: workspace }],
  });
  const envName = 'MINARBOT_SHELL_TEST_CANARY', original = process.env[envName];
  try {
    process.env[envName] = 'shell-secret-fixture';
    app = await start();
  } finally {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  }
  const origin = app.origin;
  async function request(path: string, body?: unknown) {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  for (const id of [writable, readonly]) {
    await request('/api/agents', { id, runtime: 'api', name: 'Shell', model: 'fixture', instructions: 'Help.' });
  }
  async function send(input: Record<string, unknown>, { write = true } = {}) {
    const id = randomUUID(), turns = `/api/agents/${write ? writable : readonly}/turns`;
    args.set(id, input);
    const until = async (predicate: (row: any) => boolean) => {
      for (let n = 0; n < 500; n++) {
        const row = (await request(turns)).find((row: { id: string }) => row.id === id);
        if (row && predicate(row)) return row;
        await delay(10);
      }
      assert.fail(`Shell turn ${id} timed out`);
    };
    await request(turns, { id, text: id });
    return {
      until,
      async decide(decision = 'allow') {
        const row = await until(row => row.harnessApprovals.some((card: { state: string }) => card.state === 'approval') || row.status === 'failed');
        assert.notEqual(row.status, 'failed', row.error);
        const approval = row.harnessApprovals.find((card: { state: string }) => card.state === 'approval');
        await request(`${turns}/${id}/harness-approvals/${approval.id}`, { id: randomUUID(), revision: approval.revision, decision });
      },
      cancel: () => request(`${turns}/${id}/cancel`, { id: randomUUID() }),
      async result() {
        const row = await until(row => ['done', 'failed'].includes(row.status));
        assert.equal(row.status, 'done', row.error);
        return results.get(id) as { check?: boolean; exitCode: number | null; output: string; error?: string; status?: number; timedOut: boolean; truncated: boolean };
      },
    };
  }
  return { root, workspace, send };
}

test('Rust shell confines cwd, filesystem and environment and enforces read-only and approval', async t => {
  const { root, workspace, send } = await shellFixture(t);
  writeFileSync(join(root, 'outside'), 'OUTSIDE_SHELL_CANARY');
  symlinkSync(root, join(workspace, 'escape'));
  for (const [args, status] of [
    [{ command: 'pwd', cwd: '..' }, 400],
    [{ command: 'pwd', check: 'yes' }, 400],
    [{ command: 'pwd', cwd: 'escape' }, 403],
  ] as const) {
    const turn = await send(args);
    const result = await turn.result();
    assert.match(result.error ?? '', /shell command|workspace/i);
    assert.equal(result.status, status);
    const row = await turn.until(row => row.status === 'done');
    assert.deepEqual(row.harnessApprovals, []);
  }
  const checked = await send({ command: 'python3 -c "assert 2 + 2 == 4"', check: true });
  await checked.decide();
  const checkedResult = await checked.result();
  assert.equal(checkedResult.exitCode, 0);
  assert.equal(checkedResult.check, true);

  const denied = await send({ command: 'touch denied' });
  await denied.decide('deny');
  assert.match((await denied.result()).error ?? '', /denied/);
  assert(!existsSync(join(workspace, 'denied')));

  const allowed = await send({ command: 'pwd; env; cat escape/outside; echo ok > result' });
  await allowed.decide();
  const result = await allowed.result();
  assert.match(result.output, /\/workspace/);
  assert.doesNotMatch(result.output, /shell-secret-fixture|NODE_OPTIONS|OUTSIDE_SHELL_CANARY/);
  assert.equal(readFileSync(join(workspace, 'result'), 'utf8'), 'ok\n');

  const readonly = await send({ command: 'echo changed > result' }, { write: false });
  await readonly.decide();
  assert.notEqual((await readonly.result()).exitCode, 0);
  assert.equal(readFileSync(join(workspace, 'result'), 'utf8'), 'ok\n');
});

test('Rust shell caps output, times out and stops descendants after exit and cancellation', async t => {
  const { workspace, send } = await shellFixture(t);
  const run = async (command: string, timeoutMs = 2000) => {
    const turn = await send({ command, timeoutMs });
    await turn.decide();
    return turn.result();
  };
  const bounded = await run('yes x');
  assert.equal(bounded.truncated, true);
  assert(Buffer.byteLength(bounded.output) <= 256 * 1024);
  assert.equal((await run('sleep 30', 100)).timedOut, true);
  await run('(sleep 1; echo escaped > orphan) >/dev/null 2>&1 & exit 0');

  const cancelled = await send({ command: 'touch started; (sleep 2; echo escaped > aborted) & wait' });
  await cancelled.decide();
  for (let n = 0; n < 150 && !existsSync(join(workspace, 'started')); n++) await delay(10);
  assert(existsSync(join(workspace, 'started')));
  await cancelled.cancel();
  await cancelled.until(row => row.status === 'cancelled');
  await delay(2100);
  assert(!existsSync(join(workspace, 'orphan')));
  assert(!existsSync(join(workspace, 'aborted')));
});
