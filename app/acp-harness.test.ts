import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createHarnessAdapter, type HarnessStart } from './harness.ts';
import { harnessRuntimes, type HarnessRuntime } from './shared/runtime.ts';
import { initializeHarness } from './harness-store.ts';
import { startApp } from './test-bridge.ts';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const source = readFileSync(new URL('./fixtures/fake-acp.mjs', import.meta.url), 'utf8');
function executableFixture(room = false) {
  const workspace = mkdtempSync(join(room ? join(import.meta.dirname, 'node_modules') : tmpdir(), 'briefsip-acp-')), executable = join(workspace, 'fake-acp');
  writeFileSync(executable, `#!${process.execPath}\n` + source.split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  return { workspace, executable, close() { rmSync(workspace, { recursive: true, force: true }); } };
}
function fixture(runtime: HarnessRuntime = 'hermes', overrides: Partial<HarnessStart> = {}) {
  const files = executableFixture(), { workspace, executable } = files;
  const controller = new AbortController(), approvals: unknown[] = [];
  const adapter = createHarnessAdapter(runtime, { workspace, write: true, executable, mcpURL: 'http://127.0.0.1:1/mcp', token: 'test-session-secret', signal: controller.signal, approve: async request => { approvals.push(request); return true; }, ...overrides });
  return { workspace, executable, controller, approvals, adapter, async close() { await adapter.close(); files.close(); } };
}
async function rustFixture(runtime: HarnessRuntime, { write = true, timeout = 15_000, model = 'fixture-model' } = {}) {
  const f = executableFixture(), directory = mkdtempSync(join(tmpdir(), 'briefsip-acp-state-')), agent = randomUUID();
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
    const profile = { name: 'ACP fixture', model: 'saved-api-model', instructions: 'Briefsip native context.' };
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
      assert(!JSON.stringify(log).includes('BRIEFSIP_HARNESS_CANARY'));
      assert(log.some(row => row.method === 'session/set_mode' && row.params.modeId === 'default'));
      assert(log.some(row => row.method === 'session/set_model' && row.params.modelId === 'fixture-model'));
      const decisions = log.flatMap(row => row.result?.outcome?.optionId ?? []);
      assert.deepEqual(decisions, ['once']);
      const prompt = log.find(row => row.method === 'session/prompt');
      assert.match(prompt.params.prompt[0].text, /^<briefsip_context>\n<runtime_info>/);
      assert.match(prompt.params.prompt[0].text, /<\/briefsip_context>$/);
      assert.match(prompt.params.prompt[1].text, /Briefsip native context\./);
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
    symlinkSync('/tmp', join(f.workspace, 'outside'));
    const done = await f.complete(await f.send('FILES'));
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
test('ACP cancel notification reaches child and cleanup kills detached tool process', async () => {
  const f = fixture();
  let pid = 0;
  try {
    await f.adapter.startSession(); const iterator = f.adapter.sendTurn('TREE')[Symbol.asyncIterator](); await iterator.next();
    pid = Number(readFileSync(join(f.workspace, 'child-pid'), 'utf8')); await delay(200);
    const waiting = iterator.next(); f.controller.abort(); await assert.rejects(waiting, /stopped|closed/); await f.adapter.close();
    for (let i = 0; i < 50; i++) { try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); if (stat.split(') ')[1].startsWith('Z ')) break; } catch { break; } await delay(20); }
    let alive = false; try { alive = !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); } catch { /* Reaped. */ }
    assert.equal(alive, false); assert(existsSync(join(f.workspace, 'cancel-received')));
  } finally { await f.close(); }
});
test('ACP abort before launch spawns nothing', async () => {
  const f = fixture(); f.controller.abort();
  try { await assert.rejects(f.adapter.startSession()); assert(!existsSync(join(f.workspace, 'fake-acp-log.jsonl'))); } finally { await f.close(); }
});
test('runtime migration preserves agents, references, existing sessions, and closed runtime constraint', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE agents(id TEXT PRIMARY KEY,runtime TEXT NOT NULL DEFAULT 'api' CHECK(runtime IN ('api','codex','claude'))) STRICT; CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT REFERENCES agents(id)); INSERT INTO agents VALUES ('agent','codex'); INSERT INTO turns VALUES ('turn','agent');");
    initializeHarness(db); db.prepare('INSERT INTO harness_sessions VALUES (?,?,?,?,?)').run('agent', 'chat', 'codex', '/workspace', 'session'); initializeHarness(db);
    for (const runtime of harnessRuntimes) db.prepare('UPDATE agents SET runtime=?').run(runtime);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('SELECT count(*) AS n FROM harness_sessions').get()!.n, 1);
    assert.throws(() => db.exec("UPDATE agents SET runtime='invalid'"), /CHECK/);
  } finally { db.close(); }
});
test('ACP runtimes work through server: approvals, segments and runtime picker', async () => {
  const f = executableFixture(), directory = mkdtempSync(join(tmpdir(), 'briefsip-acp-server-')), agent = randomUUID();
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
  const f = executableFixture(true), directory = mkdtempSync(join(tmpdir(), 'briefsip-acp-room-'));
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
