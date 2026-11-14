import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, get } from 'node:http';
import { execFileSync } from 'node:child_process';
import { startApp } from './server.ts';
import { createLocalProjects, initializeLocalProjects, ProjectError } from './local-projects.ts';
const scratch = () => mkdtempSync(resolve('node_modules/.projects-test-'));
function store() {
  const home = scratch(), db = new DatabaseSync(join(home, 'state.sqlite')), agent = randomUUID();
  db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY) STRICT;CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,instructions TEXT,lead TEXT,revision INTEGER DEFAULT 1,archived INTEGER DEFAULT 0) STRICT;CREATE TABLE channel_members(channel TEXT,agent TEXT,PRIMARY KEY(channel,agent)) STRICT;CREATE TABLE threads(id TEXT PRIMARY KEY,agent TEXT,name TEXT,deleted INTEGER DEFAULT 0,archived INTEGER DEFAULT 0) STRICT;CREATE TABLE turns(id TEXT PRIMARY KEY,seq INTEGER,channel TEXT,thread TEXT,status TEXT,created TEXT) STRICT;');
  db.prepare('INSERT INTO agents VALUES (?)').run(agent);
  initializeLocalProjects(db);
  const transaction = <T>(work: () => T) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    }
    catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const projects = createLocalProjects(db, { home, dataDir: join(home, 'data'), root: join(home, 'Projects') }, transaction);
  return { home, db, agent, projects, transaction, close() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    } };
}
test('project folders reject system, traversal, home, credential, data and symlink paths before creation', () => {
  const f = store();
  try {
    mkdirSync(join(f.home, 'safe'));
    symlinkSync('/etc', join(f.home, 'escape'));
    symlinkSync(join(f.home, 'safe'), join(f.home, 'alias'));
    mkdirSync(join(f.home, 'data'));
    for (const path of ['/', '/etc', '/tmp', f.home, join(f.home, '.ssh'), join(f.home, '.codex'), join(f.home, '.codex-linc'), join(f.home, '.claude'), join(f.home, '.hermes'), join(f.home, '.config/briefsip'), join(f.home, 'data'), join(f.home, 'data/sub'), join(f.home, 'escape'), join(f.home, 'alias'), f.home + '/safe/../safe'])
      assert.throws(() => f.projects.create({ id: randomUUID(), name: 'Bad', folders: [{ mode: 'existing', path }] }), ProjectError, path);
    const unsafe = createLocalProjects(f.db, { home: f.home, dataDir: join(f.home, 'data'), root: join(f.home, 'escape') }, f.transaction);
    assert.throws(() => unsafe.create({ id: randomUUID(), name: 'never-created', folders: [{ mode: 'new' }] }));
    assert.equal(f.projects.list().length, 0);
    const browser = f.projects.folders();
    assert(browser.folders.some(item => item.name === 'safe'));
    assert(!browser.folders.some(item => ['escape', 'alias', 'data'].includes(item.name)));
  }
  finally {
    f.close();
  }
});
test('project CRUD, new and multiple folders, write confirmation, revisions, replay, restart and deletion preserve files', () => {
  const f = store();
  try {
    mkdirSync(join(f.home, 'existing'));
    const body = { id: randomUUID(), name: 'Build docs', description: 'Local project', folders: [{ mode: 'new' }, { mode: 'existing', path: join(f.home, 'existing') }], members: [{ agent: f.agent, write: true }], confirmWrite: true };
    assert.throws(() => f.projects.create({ ...body, confirmWrite: false }), /Confirm/);
    const p = f.projects.create(body) as any;
    assert.equal(p.folders.length, 2);
    assert(existsSync(p.folders[0]));
    // New project folders start as their own Git repository with one empty commit and no sample hooks.
    assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: p.folders[0], encoding: 'utf8' }).trim(), p.folders[0]);
    assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: p.folders[0], encoding: 'utf8' }).trim(), 'Start project');
    assert(!existsSync(join(p.folders[0], '.git', 'hooks', 'pre-commit.sample')));
    assert(!existsSync(join(p.folders[1], '.git')), 'existing folders are never initialized');
    writeFileSync(join(p.folders[0], 'keep.txt'), 'keep');
    assert.deepEqual(f.projects.create(body), p);
    assert.throws(() => f.projects.create({ ...body, name: 'Other' }), /already used/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM channel_members WHERE channel=?').get(p.channel)?.n, 1);
    assert.equal(f.projects.binding(p.id, f.agent, p.folders[1])?.write, true);
    const edit = { id: randomUUID(), revision: 1, name: 'Renamed', members: [{ agent: f.agent, write: false }] };
    const changed = f.projects.edit(p.id, 'edit', edit) as any;
    assert.equal(changed.revision, 2);
    assert.equal(changed.name, 'Renamed');
    assert.equal(f.db.prepare('SELECT name FROM channels WHERE id=?').get(p.channel)?.name, 'Renamed');
    assert.equal(f.projects.binding(p.id, f.agent)?.write, false);
    assert.deepEqual(f.projects.edit(p.id, 'edit', edit), changed);
    assert.throws(() => f.projects.edit(p.id, 'edit', { id: randomUUID(), revision: 1, name: 'Stale' }), /changed/);
    rmSync(join(f.home, 'existing'), { recursive: true });
    assert.deepEqual(f.projects.create(body), p);
    assert.deepEqual(f.projects.edit(p.id, 'edit', { members: edit.members, name: edit.name, revision: edit.revision, id: edit.id }), changed);
    const reopened = createLocalProjects(f.db, { home: f.home, dataDir: join(f.home, 'data'), root: join(f.home, 'Projects') }, f.transaction);
    assert.deepEqual(reopened.create(body), p);
    const remove = { id: randomUUID(), revision: 2, confirmed: true };
    assert.deepEqual(reopened.edit(p.id, 'delete', remove), { id: p.id, deleted: true });
    assert.deepEqual(reopened.edit(p.id, 'delete', remove), { id: p.id, deleted: true });
    assert.equal(readFileSync(join(p.folders[0], 'keep.txt'), 'utf8'), 'keep');
    assert.equal(reopened.list().length, 0);
    assert.throws(() => reopened.binding(p.id, f.agent), /not found/);
    assert.equal(f.db.prepare('SELECT archived FROM channels WHERE id=?').get(p.channel)?.archived, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM channel_members WHERE channel=?').get(p.channel)?.n, 0);
  }
  finally {
    f.close();
  }
});
test('project grants resolve only in chatroom or side thread, selected folder, and revoked membership fails closed', () => {
  const f = store();
  try {
    mkdirSync(join(f.home, 'other'));
    const p = f.projects.create({ id: randomUUID(), name: 'Scope', folders: [{ mode: 'new' }, { mode: 'existing', path: join(f.home, 'other') }], members: [{ agent: f.agent, write: false }] }) as any;
    assert.equal(f.projects.forTurn(f.agent, randomUUID()), undefined);
    const direct = randomUUID();
    f.db.prepare('INSERT INTO turns VALUES (?,1,NULL,NULL,?,?)').run(direct, 'done', new Date().toISOString());
    assert.equal(f.projects.forTurn(f.agent, direct), undefined);
    const room = randomUUID();
    f.db.prepare('INSERT INTO turns VALUES (?,2,?,NULL,?,?)').run(room, p.channel, 'done', new Date().toISOString());
    assert.equal(f.projects.forTurn(f.agent, room)?.directory, p.folders[0]);
    const thread = f.projects.edit(p.id, 'thread', { id: randomUUID(), revision: 1, agent: f.agent, folder: p.folders[1], name: 'Second folder' }) as any;
    const side = randomUUID();
    f.db.prepare('INSERT INTO turns VALUES (?,3,NULL,?,?,?)').run(side, thread.threads[0].id, 'done', new Date().toISOString());
    assert.equal(f.projects.forTurn(f.agent, side)?.directory, p.folders[1]);
    assert.equal(f.projects.forTurn(f.agent, side)?.write, false);
    f.projects.edit(p.id, 'edit', { id: randomUUID(), revision: 2, members: [] });
    assert.throws(() => f.projects.forTurn(f.agent, side), /not a project member/);
  }
  finally {
    f.close();
  }
});
async function fixture() {
  const directory = scratch(), workspace = join(directory, 'workspace'), data = join(directory, 'data');
  mkdirSync(workspace);
  mkdirSync(data);
  writeFileSync(join(workspace, 'read.txt'), 'project bytes');
  const calls: any[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req)
      chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const latest = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content;
    const name = latest === 'READ' ? 'read_workspace_file' : latest === 'WRITE' ? 'create_workspace_file' : latest === 'GIT' ? 'git_status' : '';
    const tool = body.messages.at(-1)?.role === 'tool';
    res.end(JSON.stringify({ choices: [tool || !name ? { finish_reason: 'stop', message: { content: tool ? JSON.stringify(body.messages.at(-1).content) : 'No tools' } } : { finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(name === 'read_workspace_file' ? { path: 'read.txt' } : name === 'create_workspace_file' ? { path: 'made.txt', text: 'made' } : {}) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as any;
  const agent = randomUUID(), options = { database: join(data, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, projectRoot: join(directory, 'Projects') };
  let app = await startApp(options);
  const request = async (path: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  await request('/api/agents', { id: agent, name: 'Coder', model: 'fixture', instructions: 'Help' }, 201);
  const project = await request('/api/projects', { id: randomUUID(), name: 'Project', folders: [{ mode: 'existing', path: workspace }], members: [{ agent, write: false }] });
  const send = async (path: string, text: string) => {
    const id = randomUUID();
    await request(path, { id, text }, 202);
    for (let i = 0; i < 300; i++) {
      const turn = (await request(path)).find((row: any) => row.id === id);
      if (['done', 'failed'].includes(turn.status))
        return turn;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Turn timed out');
  };
  return { directory, workspace, agent, project, request, send, calls, options, get app() {
      return app;
    }, async restart(extra = {}) {
      await app.close();
      app = await startApp({ ...options, ...extra });
    }, async close() {
      await app.close();
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    } };
}
test('project HTTP Owner rules, direct-chat isolation, read/write enforcement, env fallback, per-folder Git and restart receipts', async () => {
  const f = await fixture();
  try {
    await f.request('/api/projects', undefined, 403, { Authorization: 'Bearer peer' });
    await f.request('/api/projects', undefined, 403, { Origin: 'https://foreign.invalid' });
    await f.request('/api/projects', { id: randomUUID(), name: 'Rejected', folders: [{ mode: 'new' }] }, 403, { 'Content-Type': 'text/plain' });
    assert.equal(await new Promise((resolve, reject) => get(f.app.origin + '/api/projects', { headers: { Host: 'foreign.invalid' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject)), 403);
    const direct = `/api/agents/${f.agent}/turns`, room = `/api/channels/${f.project.channel}/turns`;
    assert.equal((await f.send(direct, 'READ')).status, 'failed');
    assert.equal(f.calls.at(-1).tools.some((t: any) => t.function.name === 'read_workspace_file'), false);
    const read = await f.send(room, 'READ');
    assert.equal(read.status, 'done', read.error);
    assert.match(read.reply, /project bytes/);
    assert.equal((await f.send(room, 'WRITE')).status, 'failed');
    assert(!existsSync(join(f.workspace, 'made.txt')));
    const body = { id: randomUUID(), revision: 1, members: [{ agent: f.agent, write: true }], confirmWrite: true };
    const edited = await f.request(`/api/projects/${f.project.id}/edit`, body);
    assert.equal(edited.revision, 2);
    assert.equal((await f.send(room, 'WRITE')).status, 'done');
    assert.equal(readFileSync(join(f.workspace, 'made.txt'), 'utf8'), 'made');
    execFileSync('git', ['init', '-q'], { cwd: f.workspace });
    const git = await f.request(`/api/projects/${f.project.id}/git`);
    assert.equal(git.isRepo, true);
    assert.equal(git.dirtyCount, 2);
    assert.equal((await f.send(room, 'GIT')).status, 'done');
    const second=join(f.directory,'second-repo');mkdirSync(second);execFileSync('git',['init','-q'],{cwd:second});writeFileSync(join(second,'second.txt'),'second');
    const multi=await f.request('/api/projects',{id:randomUUID(),name:'Multiple repositories',folders:[{mode:'existing',path:f.workspace},{mode:'existing',path:second}],members:[{agent:f.agent,write:false}]});
    const otherGit=await f.request(`/api/projects/${multi.id}/git?`+new URLSearchParams({folder:second}));assert.equal(otherGit.dirtyCount,1);assert.equal(otherGit.changedFiles[0].path,'second.txt');
    const side=await f.request(`/api/projects/${multi.id}/thread`,{id:randomUUID(),revision:1,agent:f.agent,folder:second,name:'Second repository'});const gitTurn=await f.send(`/api/threads/${side.threads[0].id}/turns`,'GIT');assert.equal(gitTurn.status,'done');assert.match(gitTurn.reply,/second.txt/);
    await f.request(`/api/projects/${multi.id}/delete`,{id:randomUUID(),revision:2,confirmed:true});assert(existsSync(join(second,'second.txt')));
    await f.restart();
    assert.deepEqual(await f.request(`/api/projects/${f.project.id}/edit`, body), edited);
    assert.equal((await f.request('/api/projects')).projects.length, 1);
    await f.restart({ workspaces: [{ agent: f.agent, directory: f.workspace, write: false }] });
    assert.equal((await f.send(direct, 'READ')).status, 'done');
    const deleted = await f.request(`/api/projects/${f.project.id}/delete`, { id: randomUUID(), revision: 2, confirmed: true });
    assert.equal(deleted.deleted, true);
    assert(existsSync(join(f.workspace, 'made.txt')));
    assert.equal((await f.request('/api/projects')).projects.length, 0);
    assert((await f.request(room)).some((turn: any) => turn.id === read.id));
  }
  finally {
    await f.close();
  }
});
test('project harness cwd and read-only native escalation denial; direct chat remains unbound', async () => {
  const f = await fixture();
  try {
    const binary = join(f.directory, 'fake-harness'), source = readFileSync(new URL('./fixtures/fake-harness.mjs', import.meta.url), 'utf8');
    writeFileSync(binary, `#!${process.execPath}\n` + source.split('\n').slice(1).join('\n'));
    chmodSync(binary, 0o700);
    await f.restart({ harness: { executables: { codex: binary, claude: binary }, issuer: { mintAgentSession: () => ({ id: randomUUID(), token: 'test-mcp-session-token' }), revokeAgentSession: () => {
          } } } });
    await f.request(`/api/agents/${f.agent}/edit`, { id: randomUUID(), revision: 1, name: 'Coder', model: 'fixture', instructions: 'Help', runtime: 'codex', confirmRuntime: true });
    for (const runtime of ['codex', 'claude']) {
      if (runtime === 'claude')
        await f.request(`/api/agents/${f.agent}/edit`, { id: randomUUID(), revision: 2, name: 'Coder', model: 'fixture', instructions: 'Help', runtime, confirmRuntime: true });
      const done = await f.send(`/api/channels/${f.project.channel}/turns`, 'READ_ONLY_WRITE');
      assert.equal(done.status, 'done', done.error);
      assert.equal(done.reply, 'Harness denied');
      assert(existsSync(join(f.workspace, 'fake-log.jsonl')));
      assert.match(readFileSync(join(f.workspace, 'fake-log.jsonl'), 'utf8'), runtime === 'codex' ? /thread\/start/ : /"type":"init"/);
      assert.equal(done.harnessApprovals.length, 0);
      await f.request(`/api/agents/${f.agent}/turns`, { id: randomUUID(), text: 'Direct has no folder' }, 503);
    }
  }
  finally {
    await f.close();
  }
});
test('managed folder retry recovers durable intent after transaction failure without deleting files', () => {
  const f = store();
  try {
    const body = { id: randomUUID(), name: 'Retry folder', folders: [{ mode: 'new' }] };
    f.db.exec("CREATE TRIGGER reject_project BEFORE INSERT ON local_projects BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.throws(() => f.projects.create(body), /fixture failure/);
    const folder = join(f.home, 'Projects', 'retry-folder');
    assert(existsSync(folder));
    writeFileSync(join(folder, 'retained.txt'), 'retained');
    f.db.exec('DROP TRIGGER reject_project');
    const p = f.projects.create(body) as any;
    assert.equal(p.folders[0], folder);
    assert.equal(readFileSync(join(folder, 'retained.txt'), 'utf8'), 'retained');
    assert.deepEqual(f.projects.create(body), p);
  }
  finally {
    f.close();
  }
});
