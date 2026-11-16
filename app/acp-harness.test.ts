import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createHarnessAdapter, harnessAvailability, harnessRuntimes, type HarnessRuntime, type HarnessStart } from './harness.ts';
import { initializeHarness } from './harness-store.ts';
import { startApp } from './server.ts';
import { dispatchCapabilities } from './dispatch.ts';
async function collect<T>(source: AsyncIterable<T>) { const events: T[] = []; for await (const event of source) events.push(event); return events; }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const source = readFileSync(new URL('./fixtures/fake-acp.mjs', import.meta.url), 'utf8');
function fixture(runtime: HarnessRuntime = 'hermes', overrides: Partial<HarnessStart> = {}, room = false) {
  const workspace = mkdtempSync(join(room ? join(import.meta.dirname, 'node_modules') : tmpdir(), 'briefsip-acp-')), executable = join(workspace, 'fake-acp');
  writeFileSync(executable, `#!${process.execPath}\n` + source.split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  const controller = new AbortController(), approvals: unknown[] = [];
  const adapter = createHarnessAdapter(runtime, { workspace, write: true, executable, mcpURL: 'http://127.0.0.1:1/mcp', token: 'test-session-secret', signal: controller.signal, approve: async request => { approvals.push(request); return true; }, ...overrides });
  return { workspace, executable, controller, approvals, adapter, async close() { await adapter.close(); rmSync(workspace, { recursive: true, force: true }); } };
}
for (const runtime of ['hermes', 'antigravity', 'grok', 'opencode', 'gemini', 'kiro'] as const) {
  test(`${runtime}: initialize, supervised session, stream segments, tool, one-use permission and done`, async () => {
    const f = fixture(runtime, { model: 'fixture-model' });
    try {
      assert.equal(await f.adapter.startSession(), 'fixture-session');
      const events = await collect(f.adapter.sendTurn('hello'));
      assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Before tool. Final answer.');
      assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.state), ['pending', 'completed']);
      assert.equal(events.at(-1)?.type, 'done'); assert.equal(f.approvals.length, 1);
      const log = readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8');
      assert.match(log, /session\/set_model/); assert.match(log, /"optionId":"once"/); assert(!log.includes('"optionId":"persistent"}}'));
      assert(log.includes('test-session-secret')); assert(!log.includes('BRIEFSIP_HARNESS_CANARY'));
      const message = JSON.parse(log.split('\n').find(line => line.includes('"method":"initialize"'))!);
      assert.equal(message.params.protocolVersion, 1);
      assert.equal(message.params.clientCapabilities.terminal, false);
      assert.equal(dispatchCapabilities(runtime).steer, false);
    } finally { await f.close(); }
  });
}
test('ACP resume suppresses replay and keeps cwd and credentials scoped', async () => {
  const f = fixture('hermes', { sessionId: 'fixture-session' });
  try { await f.adapter.startSession(); const events = await collect(f.adapter.sendTurn('hello')); assert(!JSON.stringify(events).includes('Historic')); assert.match(readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8'), /session\/load/); }
  finally { await f.close(); }
});
test('ACP file requests reject outside paths and symlinks, require write approval', async () => {
  const f = fixture();
  try { symlinkSync('/tmp', join(f.workspace, 'outside')); await f.adapter.startSession(); await collect(f.adapter.sendTurn('FILES')); assert.equal(readFileSync(join(f.workspace, 'hello.txt'), 'utf8'), 'hello\n'); assert.equal(f.approvals.length, 2); assert(!existsSync(join(f.workspace, '../escape.txt'))); }
  finally { await f.close(); }
});
test('ACP read-only workspace rejects file writes without approval', async () => {
  const f = fixture('hermes', { write: false });
  try { await f.adapter.startSession(); await collect(f.adapter.sendTurn('READONLY')); assert(!existsSync(join(f.workspace, 'readonly.txt'))); assert.equal(f.approvals.length, 1); }
  finally { await f.close(); }
});
test('Pi RPC streams, requests tool approval, selects model, and cancels', async () => {
  const f = fixture('pi', { model: 'fixture/model' });
  try {
    assert.equal(await f.adapter.startSession(), undefined);
    const events = await collect(f.adapter.sendTurn('hello'));
    assert(events.some(event => event.type === 'text' && event.text === 'Pi answer.'));
    assert(events.some(event => event.type === 'tool')); assert.equal(f.approvals.length, 1);
    assert.equal(events.at(-1)?.type, 'done'); assert.equal(f.adapter.capabilities.resume, false);
    const iteration = f.adapter.sendTurn('WAIT')[Symbol.asyncIterator](); await iteration.next();
    const pending = iteration.next(); f.controller.abort(); await assert.rejects(pending, /stopped|closed/);
    assert.match(readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8'), /set_model/);
  } finally { await f.close(); }
});
test('ACP denied permission never grants persistent option', async () => {
  const f = fixture('hermes', { approve: async () => false });
  try { await f.adapter.startSession(); const events = await collect(f.adapter.sendTurn('hello')); assert(events.some(event => event.type === 'tool' && event.state === 'failed')); assert.match(readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8'), /"optionId":"deny"/); }
  finally { await f.close(); }
});
for (const mode of ['CRASH', 'INVALID', 'WAIT']) test(`ACP ${mode}: fail bounded, no replay`, async () => {
  const f = fixture('hermes', { timeoutMs: 150 });
  try { await f.adapter.startSession(); await assert.rejects(collect(f.adapter.sendTurn(mode)), /stopped|invalid|timed out/i); const log = readFileSync(join(f.workspace, 'fake-acp-log.jsonl'), 'utf8'); assert.equal(log.split('\n').filter(line => line.includes('"method":"session/prompt"')).length, 1); }
  finally { await f.close(); }
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
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'briefsip-acp-server-')), agent = randomUUID();
  const app = await startApp({ database: join(directory, 'db.sqlite'), port: 0, timeout: 15_000, workspaces: [{ agent, directory: f.workspace, write: true }], harness: { executables: Object.fromEntries(harnessRuntimes.map(runtime => [runtime, f.executable])), issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-session-secret' }), revokeAgentSession() {} } } });
  const request = async (path: string, body?: unknown) => { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  try {
    await request('/api/agents', { id: agent, name: 'ACP', model: 'saved-api-model', instructions: 'Help.' });
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
  const f = fixture('hermes', {}, true), directory = mkdtempSync(join(tmpdir(), 'briefsip-acp-room-'));
  const app = await startApp({ database: join(directory, 'db.sqlite'), port: 0, timeout: 20_000, harness: { executables: { hermes: f.executable }, issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-session-secret' }), revokeAgentSession() {} } } });
  const request = async (path: string, body?: unknown) => { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  try {
    const agents = [];
    for (const name of ['First', 'Peer']) agents.push(await request('/api/agents', { id: randomUUID(), name, model: 'api-model', instructions: 'Help.' }));
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
