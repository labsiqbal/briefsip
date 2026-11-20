import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { harnessRuntimes, type HarnessRuntime } from './shared/runtime.ts';
import { startApp } from './test-bridge.ts';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const source = readFileSync(new URL('./fixtures/fake-acp.mjs', import.meta.url), 'utf8');
function executableFixture(room = false) {
  const workspace = mkdtempSync(join(room ? join(import.meta.dirname, 'node_modules') : tmpdir(), 'minarbot-acp-')), executable = join(workspace, 'fake-acp');
  writeFileSync(executable, `#!${process.execPath}\n` + source.split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  return { workspace, executable, close() { rmSync(workspace, { recursive: true, force: true }); } };
}
async function rustFixture(runtime: HarnessRuntime, { write = true, timeout = 15_000, model = 'fixture-model' } = {}) {
  const f = executableFixture(), directory = mkdtempSync(join(tmpdir(), 'minarbot-acp-state-')), agent = randomUUID();
  const database = join(directory, 'db.sqlite');
  const app = await startApp({
    database, timeout, workspaces: [{ agent, directory: f.workspace, write }],
    harness: {
      executables: { [runtime]: f.executable },
      issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-session-secret' }), revokeAgentSession() {} },
    },
  });
  const agentPath = `/api/agents/${agent}`, turns = agentPath + '/turns';
  const request = async (path: string, body?: unknown) => {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); assert(res.ok, JSON.stringify(value)); return value;
  };
  const close = async () => { try { await app.close(); } finally { f.close(); rmSync(directory, { recursive: true, force: true }); } };
  try {
    const profile = { name: 'ACP fixture', model: 'saved-api-model', instructions: 'Minarbot native context.' };
    await request('/api/agents', { id: agent, ...profile, runtime: 'api' });
    await request(agentPath + '/edit', { id: randomUUID(), revision: 1, ...profile, runtime, harnessModel: model, confirmRuntime: true });
  } catch (error) { await close(); throw error; }
  const send = async (text: string) => { const id = randomUUID(); await request(turns, { id, text }); return id; };
  const read = async (id: string) => (await request(turns)).find((row: { id: string }) => row.id === id);
  const until = async (id: string, predicate: (row: any) => boolean) => {
    let last;
    const deadline = performance.now() + 25_000;
    do {
      last = await read(id);
      if (last && predicate(last)) return last;
      await delay(20);
    } while (performance.now() < deadline);
    assert.fail(`ACP turn did not reach the expected state: ${JSON.stringify(last)}`);
  };
  const decide = (id: string, card: { id: string; revision: number }, decision: 'allow' | 'deny') =>
    request(`${turns}/${id}/harness-approvals/${card.id}`, { id: randomUUID(), revision: card.revision, decision });
  const complete = async (id: string, decision: 'allow' | 'deny' = 'allow') => {
    const terminal = ['done', 'failed', 'cancelled'];
    for (;;) {
      const row = await until(id, row => terminal.includes(row.status) || row.harnessApprovals.some((card: any) => card.state === 'approval'));
      if (terminal.includes(row.status)) return row;
      for (const card of row.harnessApprovals.filter((card: any) => card.state === 'approval')) await decide(id, card, decision);
    }
  };
  const log = () => readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...f, agent, agentPath, database, send, until, complete, request, log, close };
}

for (const runtime of ['hermes', 'antigravity', 'grok', 'opencode', 'gemini', 'kiro'] as const) {
  test(`${runtime}: initialize, supervised session, stream segments, tool, one-use permission and done`, async () => {
    const f = await rustFixture(runtime);
    try {
      const done = await f.complete(await f.send('hello'));
      assert.equal(done.status, 'done', done.error);
      assert.equal(done.reply, 'Final answer.');
      assert.deepEqual(done.activity.stream.map((entry: any) => [entry.kind, entry.text]), [
        ['text', 'Before tool. '], ['tool', 'echo fixture'], ['text', 'Final answer.'],
      ]);
      assert.equal(done.harnessApprovals.length, 1);
      assert.equal(done.activity.harness[0].state, 'completed');
      const log = f.log(), init = log.find(row => row.method === 'initialize');
      const session = log.find(row => row.method === 'session/new');
      assert.equal(init.params.protocolVersion, 1);
      assert.equal(init.params.clientCapabilities.terminal, false);
      assert.equal(session.params.cwd, f.workspace);
      assert(JSON.stringify(session).includes('test-session-secret'));
      assert(!JSON.stringify(log).includes('MINARBOT_HARNESS_CANARY'));
      assert(log.some(row => row.method === 'session/set_mode' && row.params.modeId === 'default'));
      assert(log.some(row => row.method === 'session/set_model' && row.params.modelId === 'fixture-model'));
      const decisions = log.flatMap(row => row.result?.outcome?.optionId ?? []);
      assert.deepEqual(decisions, ['once']);
      const prompt = log.find(row => row.method === 'session/prompt');
      assert.match(prompt.params.prompt[0].text, /^<minarbot_context>\n<runtime_info>/);
      assert.match(prompt.params.prompt[0].text, /<\/minarbot_context>$/);
      assert.match(prompt.params.prompt[1].text, /Minarbot native context\./);
      assert.match(prompt.params.prompt[1].text, /(?:^|\n)user: hello$/);
      assert.equal(prompt.params.sessionId, 'fixture-session');
    } finally { await f.close(); }
  });
}

test('ACP resume suppresses replay and keeps cwd and credentials scoped', async () => {
  const f = await rustFixture('hermes');
  try {
    assert.equal((await f.complete(await f.send('hello'))).status, 'done');
    const resumed = await f.complete(await f.send('hello again'));
    assert.equal(resumed.status, 'done', resumed.error);
    assert(!JSON.stringify(resumed).includes('Historic'));
    const loaded = f.log().find(row => row.method === 'session/load');
    assert.equal(loaded.params.sessionId, 'fixture-session');
    assert.equal(loaded.params.cwd, f.workspace);
    assert(JSON.stringify(loaded.params.mcpServers).includes('test-session-secret'));
  } finally { await f.close(); }
});

test('ACP file requests reject outside paths and symlinks, require write approval', async () => {
  const f = await rustFixture('hermes');
  try {
    const id = await f.send('FILES');
    const pending = await f.until(id, row => row.harnessApprovals.some((card: { state: string }) => card.state === 'approval'));
    // Add the link after the initial workspace checkpoint, before the ACP file requests.
    writeFileSync(join(dirname(f.database), 'escape.txt'), 'Outside workspace fixture');
    symlinkSync(dirname(f.database), join(f.workspace, 'outside'));
    assert.equal(pending.status, 'running');
    const done = await f.complete(id);
    assert.equal(done.status, 'done', done.error);
    assert.equal(readFileSync(join(f.workspace, 'hello.txt'), 'utf8'), 'hello\n');
    assert.equal(done.harnessApprovals.length, 2);
    assert(!existsSync(join(f.workspace, '../escape.txt')));
  } finally { await f.close(); }
});

test('ACP read-only workspace rejects file writes without approval', async () => {
  const f = await rustFixture('hermes', { write: false });
  try {
    const done = await f.complete(await f.send('READONLY'));
    assert.equal(done.status, 'done', done.error);
    assert(!existsSync(join(f.workspace, 'readonly.txt')));
    assert.equal(done.harnessApprovals.length, 1);
  } finally { await f.close(); }
});

test('Pi RPC streams, requests tool approval, selects model, and cancels', async () => {
  const f = await rustFixture('pi', { model: 'fixture/model' });
  try {
    const done = await f.complete(await f.send('hello'));
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.reply, 'Pi answer.');
    assert(done.activity.stream.some((entry: any) => entry.kind === 'tool'));
    assert.equal(done.harnessApprovals.length, 1);
    const choices = await f.request(f.agentPath + '/runtimes');
    assert.equal(choices.choices.find((choice: any) => choice.runtime === 'pi').capabilities.resume, false);
    assert(f.log().some(row => row.type === 'set_model' && row.provider === 'fixture' && row.modelId === 'model'));
    const pending = await f.send('WAIT');
    await f.until(pending, row => row.partial?.text === 'Waiting.');
    await f.request(`${f.agentPath}/turns/${pending}/cancel`, { id: randomUUID() });
    const cancelled = await f.until(pending, row => row.status === 'cancelled');
    assert.equal(cancelled.status, 'cancelled');
  } finally { await f.close(); }
});

test('ACP denied permission never grants persistent option', async () => {
  const f = await rustFixture('hermes');
  try {
    const done = await f.complete(await f.send('hello'), 'deny');
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.activity.harness[0].state, 'failed');
    assert.deepEqual(f.log().flatMap(row => row.result?.outcome?.optionId ?? []), ['deny']);
  } finally { await f.close(); }
});

for (const mode of ['CRASH', 'INVALID', 'WAIT']) test(`ACP ${mode}: fail bounded, no replay`, async () => {
  const f = await rustFixture('hermes', { timeout: 5_000 });
  try {
    const failed = await f.until(await f.send(mode), row => ['done', 'failed'].includes(row.status));
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /stopped|invalid|timed out/i);
    assert.equal(f.log().filter(row => row.method === 'session/prompt').length, 1);
  } finally { await f.close(); }
});
test('ACP cancel reaches child, kills detached tool process and preserves inspect diagnostics', async () => {
  const f = await rustFixture('hermes');
  try {
    const id = await f.send('TREE');
    await f.until(id, row => row.partial?.text === 'Waiting.');
    const pid = Number(readFileSync(join(f.workspace, 'child-pid'), 'utf8'));
    const stat = () => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)?.split(' '); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    const start = stat()?.[19];
    assert(start, 'Detached tool did not start');
    const alive = () => { const current = stat(); return current?.[19] === start && current[0] !== 'Z'; };
    assert(alive());
    await f.request(`${f.agentPath}/turns/${id}/cancel`, { id: randomUUID() });
    const stopped = await f.until(id, row => row.status === 'cancelled');
    assert.equal(stopped.reply, null);
    const deadline = performance.now() + 5_000;
    const received = () => existsSync(join(f.workspace, 'cancel-received'));
    while ((alive() || !received()) && performance.now() < deadline) await delay(20);
    assert.equal(alive(), false, 'Detached tool survived cancellation');
    assert(received(), 'Child had no time to handle session/cancel');
    const notices = f.log().filter(row => row.method === 'session/cancel');
    assert.deepEqual(notices, [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'fixture-session' } }]);
    const inspection = await f.request(`/api/turns/${id}/inspect`);
    const [step] = inspection.harness;
    assert.equal(inspection.status, 'cancelled');
    assert.equal(step.id, 'worker');
    assert.equal(step.state, 'in_progress');
    assert(step.started);
    assert.deepEqual(JSON.parse(step.arguments), { pid });
    assert.equal(step.result, 'Worker started');
    assert.equal(inspection.engineStderr, 'ACP cancelled [REDACTED]');
  } finally { await f.close(); }
});
test('ACP runtimes work through server: approvals, segments and runtime picker', async () => {
  const f = executableFixture(), directory = mkdtempSync(join(tmpdir(), 'minarbot-acp-server-')), agent = randomUUID();
  const app = await startApp({ database: join(directory, 'db.sqlite'), port: 0, timeout: 15_000, workspaces: [{ agent, directory: f.workspace, write: true }], harness: { executables: Object.fromEntries(harnessRuntimes.map(runtime => [runtime, f.executable])), issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-session-secret' }), revokeAgentSession() {} } } });
  const request = async (path: string, body?: unknown) => { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  try {
    await request('/api/agents', { runtime: 'api', id: agent, name: 'ACP', model: 'saved-api-model', instructions: 'Help.' });
    let revision = 1;
    for (const runtime of ['hermes', 'grok', 'antigravity'] as const) {
      await request(`/api/agents/${agent}/edit`, { id: randomUUID(), revision: revision++, name: 'ACP', model: 'saved-api-model', instructions: 'Help.', runtime, confirmRuntime: true });
      const id = randomUUID(); await request(`/api/agents/${agent}/turns`, { id, text: 'hello' });
      let done = false;
      for (let i = 0; i < 300; i++) {
        const turn = (await request(`/api/agents/${agent}/turns`)).find((turn: { id: string }) => turn.id === id);
        for (const approval of turn.harnessApprovals.filter((approval: { state: string }) => approval.state === 'approval')) await request(`/api/agents/${agent}/turns/${id}/harness-approvals/${approval.id}`, { id: randomUUID(), revision: approval.revision, decision: 'allow' });
        if (turn.status === 'done') { assert.equal(turn.reply, 'Final answer.'); assert.equal(turn.activity.stream.length, 3); done = true; break; }
        assert(!['failed', 'cancelled'].includes(turn.status), JSON.stringify(turn)); await delay(20);
      }
      assert(done);
    }
    const choices = await request(`/api/agents/${agent}/runtimes`);
    assert(choices.choices.some((choice: { runtime: string; available: boolean }) => choice.runtime === 'hermes' && choice.available));
  } finally { await app.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ACP room queue, checkpoints and stop preserve peer approvals', async () => {
  const f = executableFixture(true), directory = mkdtempSync(join(tmpdir(), 'minarbot-acp-room-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: f.workspace, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git('init', '-q');
  git('-c', 'user.name=ACP Test', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture');
  const app = await startApp({ database: join(directory, 'db.sqlite'), port: 0, timeout: 20_000, harness: { executables: { hermes: f.executable }, issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-session-secret' }), revokeAgentSession() {} } } });
  const request = async (path: string, body?: unknown) => { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  try {
    const agents = [];
    for (const name of ['First', 'Peer']) agents.push(await request('/api/agents', { runtime: 'api', id: randomUUID(), name, model: 'api-model', instructions: 'Help.' }));
    const project = await request('/api/projects', { id: randomUUID(), name: 'ACP room', folders: [{ mode: 'existing', path: f.workspace }], members: agents.map(agent => ({ agent: agent.id, write: true })), confirmWrite: true });
    for (const agent of agents) await request(`/api/agents/${agent.id}/edit`, { id: randomUUID(), revision: 1, name: agent.name, model: 'api-model', instructions: 'Help.', runtime: 'hermes', confirmRuntime: true });
    const path = `/api/channels/${project.sections[0].id}/turns`, root = randomUUID();
    await request(path, { id: root, text: 'hello' });
    let rows = [];
    for (let i = 0; i < 300; i++) { rows = await request(path); if (rows.some((row: { harnessApprovals: unknown[] }) => row.harnessApprovals.length)) break; await delay(20); }
    const active = rows.find((row: { status: string }) => row.status === 'running'), queued = rows.find((row: { status: string }) => row.status === 'queued');
    assert(active); assert(queued, 'Room peer waits in serialized queue');
    const approval = active.harnessApprovals[0];
    await request(`${path}/${active.id}/harness-approvals/${approval.id}`, { id: randomUUID(), revision: approval.revision, decision: 'allow' });
    for (let i = 0; i < 300; i++) { rows = await request(path); if (rows.find((row: { id: string }) => row.id === queued.id)?.harnessApprovals.length) break; await delay(20); }
    assert.equal(rows.find((row: { id: string }) => row.id === active.id)?.status, 'done');
    assert(rows.find((row: { id: string }) => row.id === active.id)?.checkpoint?.restorable);
    await request(path.replace('/turns', `/discussions/${root}/stop`), { id: randomUUID(), generation: root });
    for (let i = 0; i < 100; i++) { rows = await request(path); if (rows.find((row: { id: string }) => row.id === queued.id)?.harnessApprovals[0]?.state === 'expired') break; await delay(20); }
    assert.equal(rows.find((row: { id: string }) => row.id === queued.id)?.harnessApprovals[0]?.state, 'expired');
  } finally { await app.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
