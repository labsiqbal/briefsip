import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startApp } from './test-bridge.ts';

function repository() {
  const dir = mkdtempSync(join(import.meta.dirname, 'node_modules/.git-workspace-test-')), root = join(dir, 'repo'), data = join(dir, 'data'); mkdirSync(root); mkdirSync(data);
  const run = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }).trimEnd();
  run('init', '-q', '--initial-branch=main'); run('config', 'user.name', 'Workspace Tester'); run('config', 'user.email', 'workspace@example.test');
  writeFileSync(join(root, 'note.txt'), 'before\n'); run('add', '--', 'note.txt'); run('commit', '-q', '-m', 'Initial');
  return { dir, root, data, run };
}

test('Git log returns last 50 commits and no more', async () => {
  const f = repository(), agent = randomUUID();
  const app = await startApp({ database: join(f.data, 'log.sqlite'), workspaces: [{ agent, directory: f.root }] });
  try {
    const created = await fetch(app.origin + '/api/agents', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime: 'api', id: agent, name: 'Reader', model: 'fixture', instructions: 'Help' }),
    });
    assert.equal(created.status, 201);
    const tree = f.run('rev-parse', 'HEAD^{tree}');
    let head = f.run('rev-parse', 'HEAD');
    for (let n = 0; n < 55; n++) head = f.run('commit-tree', tree, '-p', head, '-m', `History ${n}`);
    f.run('update-ref', 'HEAD', head);
    const response = await fetch(app.origin + `/api/agents/${agent}/git/log`);
    assert.equal(response.status, 200);
    const log = await response.json();
    assert.equal(log.commits.length, 50);
    assert.equal(log.commits[0].subject, 'History 54');
  } finally {
    await app.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('HTTP Git reads/tools/checkpoints use workspace gating and reject foreign requests, restart and restore through API', async () => {
  const f = { ...repository(), agent: randomUUID(), readonly: randomUUID() }, requests: any[] = []; let chosen = 'git_status';
  const provider = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw); requests.push(data); const result = data.messages.findLast((message: any) => message.role === 'tool'); res.end(JSON.stringify({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message: result ? { content: result.content } : { tool_calls: [{ id: 'git-call', type: 'function', function: { name: chosen, arguments: chosen === 'git_commit' ? JSON.stringify({ message: 'Tool commit' }) : '{}' } }] } }] })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(f.data, 'app.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, workspaces: [{ agent: f.agent, directory: f.root, write: true }, { agent: f.readonly, directory: f.root }] };
  let app = await startApp(options, { directory: f.dir, servers: [provider] });
  async function request(path: string, body?: unknown, expected = 200, origin = app.origin): Promise<any> { const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result; }
  async function send(path: string) { const id = randomUUID(); await request(path, { id, text: 'Git task' }, 202); for (let n = 0; n < 600; n++) { const row = (await request(path)).find((row: any) => row.id === id); if (['done', 'failed'].includes(row.status)) return row; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Turn timed out'); }
  try {
    const managed = randomUUID(); for (const agent of [f.agent, f.readonly, managed]) await request('/api/agents', { runtime: 'api', id: agent, name: 'Git fixture', model: 'fixture', instructions: 'Help' }, 201);
    const path = `/api/agents/${f.agent}/git`, turns = `/api/agents/${f.agent}/turns`;
    assert.equal((await request(path)).isRepo, true); assert.deepEqual(await request(`/api/agents/${managed}/git`), { isRepo: false });
    await request(path, undefined, 403, 'https://foreign.invalid'); await request(path + '/diff?path=../private', undefined, 400); await request(path + '/diff?path=note.txt&path=note.txt', undefined, 400); await request(path + '/log?limit=51', undefined, 400); await request(path + '?fetch=1', undefined, 400);
    const row = await send(turns); assert.equal(row.status, 'done', JSON.stringify(row)); assert(row.activity.tools.some((item: any) => item.name === 'git_status')); assert.equal(row.checkpoint.restorable, true);
    const offered = requests[0].tools.map((item: any) => item.function.name); for (const name of ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_create_branch', 'git_create_worktree']) assert(offered.includes(name));
    writeFileSync(join(f.root, 'note.txt'), 'restore this'); const preview = await request(path + `/checkpoints/${row.id}`), command = { id: randomUUID(), checkpointId: row.id, digest: preview.digest };
    const restored = await request(path + `/checkpoints/${row.id}/restore`, command); assert.equal(restored.restored, true, JSON.stringify(restored)); assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'before\n');
    await app.close(); app = await startApp(options); writeFileSync(join(f.root, 'note.txt'), 'later'); assert.deepEqual(await request(path + `/checkpoints/${row.id}/restore`, command), restored); assert.equal(readFileSync(join(f.root, 'note.txt'), 'utf8'), 'later');
    const side = await request(`/api/agents/${f.agent}/threads`, { id: randomUUID(), name: 'Side' }, 200); assert.equal((await send(`/api/threads/${side.id}/turns`)).status, 'done');
    chosen = 'git_commit'; assert.equal((await send(`/api/agents/${f.readonly}/turns`)).status, 'failed'); assert(!requests.at(-1).tools.some((item: any) => item.function.name === 'git_commit'));
    chosen = 'git_status';
    const managedTurn = await send(`/api/agents/${managed}/turns`);
    assert.equal(managedTurn.status, 'done', JSON.stringify(managedTurn));
    assert(managedTurn.activity.tools.some((item: any) => item.name === 'git_status'));
    assert.deepEqual(JSON.parse(managedTurn.reply), { isRepo: false });
    assert.deepEqual((await request(`/api/agents/${managed}/workspace/entries`)).entries, []);
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Help', members: [f.agent], lead: f.agent }, 201); assert.equal((await send(`/api/channels/${channel.id}/turns`)).status, 'failed'); assert(!requests.at(-1).tools.some((item: any) => item.function.name === 'git_status'));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(f.dir, { recursive: true, force: true }); }
});
