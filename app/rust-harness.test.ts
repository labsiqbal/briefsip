import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { startApp } from './server.ts';
import { rustBinary } from './rust-binary.ts';
import { mcpScopes } from './t3/mcp-session-registry.ts';

test('Rust ACP and Pi execute fake protocols with model selection and approvals', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-rust-acp-')), executable = join(dir, 'fake-acp');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('./fixtures/fake-acp.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  const agent = randomUUID(), runtimes = ['hermes', 'grok', 'opencode', 'gemini', 'kiro', 'antigravity', 'pi'];
  const app = await startApp({ database: join(dir, 'state.sqlite'), workspaces: [{ agent, directory: dir, write: true }], harness: { executables: Object.fromEntries(runtimes.map(runtime => [runtime, executable])) } });
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(app.origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  try {
    const profile = { name: 'Fixture', instructions: 'Help.', model: 'fixture', runtime: 'api' };
    await request('/api/agents', { id: agent, ...profile });
    let revision = 1;
    for (const runtime of runtimes) {
      await request(`/api/agents/${agent}/edit`, { id: randomUUID(), revision: revision++, ...profile, runtime, confirmRuntime: true, harnessModel: runtime === 'pi' ? 'fixture/model' : 'fixture-model' });
      const id = randomUUID(), root = `/api/agents/${agent}/turns`; await request(root, { id, text: 'hello' });
      let done = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const turn = (await request(root)).find((row: { id: string }) => row.id === id);
        assert(!['failed', 'cancelled'].includes(turn.status), JSON.stringify(turn));
        for (const card of turn.harnessApprovals.filter((card: { state: string }) => card.state === 'approval')) await request(`${root}/${id}/harness-approvals/${card.id}`, { id: randomUUID(), revision: card.revision, decision: 'allow' });
        if (turn.status === 'done') { assert.equal(turn.reply, runtime === 'pi' ? 'Pi answer.' : 'Final answer.'); done = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(done, `${runtime} did not finish`);
    }
    const log = readFileSync(join(dir, 'fake-acp-log.jsonl'), 'utf8'); assert(log.includes('set_model')); assert(log.includes('session/set_model'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Rust MCP feature receipts, scopes, cursors and stdio forwarding', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-rust-harness-'));
  const app = await startApp({ database: join(dir, 'state.sqlite'), baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key' });
  try {
    const peer = app.mcpServer.createPeerToken({ id: randomUUID(), name: 'Owner', scopes: [...mcpScopes] });
    const limited = app.mcpServer.createPeerToken({ id: randomUUID(), name: 'Limited', scopes: ['agents:read'] });
    const rpc = async (name: string, args: Record<string, unknown>, token = peer.token!) => {
      const response = await fetch(app.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return { status: response.status, body: await response.json() };
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await rpc(name, args); assert.equal(response.status, 200, JSON.stringify(response.body)); assert(!response.body.result.isError, JSON.stringify(response.body)); return response.body.result.structuredContent;
    };
    assert.equal((await rpc('create_agent', {}, limited.token!)).status, 403);
    const agent = await call('create_agent', { requestId: randomUUID(), name: 'Fixture', model: 'fixture', instructions: 'Help.' });
    assert.equal((await call('read_agent', { agent: agent.id })).name, 'Fixture');
    const input = { requestId: randomUUID(), agent: agent.id, name: 'Side' };
    const side = await call('create_conversation', input); assert.equal((await call('create_conversation', input)).id, side.id);
    const conflict = await rpc('create_conversation', { ...input, name: 'Changed' }); assert(conflict.body.result.isError); assert(JSON.stringify(conflict).includes('409'));
    await call('rename_conversation', { requestId: randomUUID(), thread: side.id, revision: 1, name: 'Renamed' });
    assert.equal((await call('list_conversations', { agent: agent.id })).items.length, 2);
    assert.equal((await rpc('list_projects', { limit: 9 })).status, 400);
    const project = await call('create_project', { requestId: randomUUID(), name: 'Fixture project', members: [{ agent: agent.id, write: false }] });
    assert.equal((await call('read_project', { project: project.id })).members.items[0].agent, agent.id);
    const section = await call('add_project_section', { requestId: randomUUID(), project: project.id, revision: 1, name: 'Research' }); assert.equal(section.sections.length, 2);
    const binary = resolve(rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY));
    const child = spawn(binary, ['--mcp-stdio'], { env: { PATH: process.env.PATH, BRIEFSIP_MCP_URL: app.origin + '/mcp', BRIEFSIP_MCP_TOKEN: peer.token }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.setEncoding('utf8').on('data', value => { output += value; }); child.stderr.setEncoding('utf8').on('data', value => { error += value; });
    const closed = once(child, 'close');
    child.stdin.end([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })].join('\n') + '\n');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { assert.equal((await closed)[0], 0, error); } finally { clearTimeout(timeout); }
    const replies = output.trim().split('\n').map(line => JSON.parse(line)); assert.equal(replies.length, 2); assert(replies[1].result.tools.some((tool: { name: string }) => tool.name === 'create_agent')); assert(!output.includes(peer.token!));
    await fetch(app.origin + '/api/runtimes'); const times: number[] = [];
    for (let index = 0; index < 30; index++) { const start = performance.now(); assert.equal((await fetch(app.origin + '/api/runtimes')).status, 200); times.push(performance.now() - start); }
    times.sort((a, b) => a - b); console.log('Rust /api/runtimes warm p95 ms:', times[28]); assert(times[28] < 50);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
