import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';

// Exercise browser routes and real provider tool dispatch with synthetic files.
test('conversation output updates, panel requests and owner deletion preserve reference identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-file-panel-'));
  let target = '', invalid = false;
  const removed: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), text = body.messages.findLast((message: { role: string }) => message.role === 'user').content;
    assert(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'open_file_in_panel'));
    const results = body.messages.filter((message: { role: string }) => message.role === 'tool');
    const opening = text === 'open';
    if (results.length >= (text === 'twice' ? 2 : 1)) {
      if (opening) assert.equal(!!JSON.parse(results.at(-1).content).error, invalid);
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] })); return;
    }
    const name = opening ? 'open_file_in_panel' : 'create_text_file';
    const args = opening ? { id: target } : { name: 'hello.html', text: `<h1>${text}-${results.length}</h1>` };
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const database = join(directory, 'state.sqlite'), options = { database, baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options, { directory, servers: [provider] });
  const post = async (path: string, value: unknown) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  const get = async (path: string) => { const response = await fetch(app.origin + path); assert(response.ok, await response.clone().text()); return response.json(); };
  const run = async (path: string, text: string, files?: string[]) => {
    const id = randomUUID(); await post(`${path}/turns`, { id, text, ...(files ? { files } : {}) });
    for (let i = 0; i < 300; i++) {
      const turn = (await get(`${path}/turns`)).find((row: { id: string }) => row.id === id);
      if (turn?.status === 'done') return turn;
      assert.notEqual(turn?.status, 'failed', turn?.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Turn did not complete');
  };
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Panel files', model: 'fixture', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Panel room', members: [agent.id], lead: agent.id, instructions: 'Help.' });
    const thread = await post(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Panel side' });
    const scopes = [`/api/agents/${agent.id}`, `/api/channels/${channel.id}`, `/api/threads/${thread.id}`];
    for (const path of scopes) {
      const first = await run(path, 'first'); target = first.generatedFiles[0].id;
      const second = await run(path, 'twice');
      assert.equal(second.generatedFiles.length, 1); assert.equal(second.generatedFiles[0].id, target);
      assert.equal((await get(`${path}/files`)).length, 1);
      assert.equal(await (await fetch(`${app.origin}${path}/files/${target}`)).text(), '<h1>twice-1</h1>');
      assert.equal((await get(`${path}/panel/files`)).length, 1);
      const opened = await run(path, 'open'); assert.equal(opened.panelFile.id, target);
      assert.equal(opened.panelFile.name, 'hello.html'); assert(opened.panelFile.seq > 0);
      assert.equal((await get(`${path}/files`)).length, 1);
      const foreign = scopes.find(scope => scope !== path)!;
      invalid = true; const denied = await run(foreign, 'open'); assert.equal(denied.panelFile, null); invalid = false;
      await run(path, 'reference', [target]);
      const remove = (headers: HeadersInit = { Origin: app.origin }, suffix = '', root = path) => fetch(`${app.origin}${root}/files/${target}${suffix}`, { method: 'DELETE', headers });
      const deniedHeaders: HeadersInit[] = [{}, { Origin: 'https://foreign.test' }, { Origin: app.origin, Authorization: 'Bearer synthetic' }];
      for (const headers of deniedHeaders) assert.equal((await remove(headers)).status, 403);
      assert.equal((await remove({ Origin: app.origin }, '?preview=text')).status, 403);
      assert.equal((await remove({ Origin: app.origin }, '', foreign)).status, 404);
      assert.equal((await remove({ Origin: app.origin }, '', path.replace('/api/', '/api/scripts/'))).status, 403);
      assert.equal((await remove()).status, 200); assert.equal((await remove()).status, 200);
      assert.equal((await fetch(`${app.origin}${path}/files/${target}`)).status, 404);
      assert.equal((await fetch(`${app.origin}${path}/panel/files/${target}?preview=html`)).status, 404);
      assert.deepEqual(await get(`${path}/files`), []); assert.deepEqual(await get(`${path}/panel/files`), []);
      const history = await get(`${path}/turns`);
      assert(history.some((turn: { files: { deleted?: boolean }[] }) => turn.files.some(file => file.deleted)));
      assert(history.find((turn: { id: string }) => turn.id === first.id).generatedFiles[0].deleted);
      invalid = true; assert.equal((await run(path, 'open')).panelFile, null); invalid = false;
      const replacement = await run(path, 'replacement'); assert.notEqual(replacement.generatedFiles[0].id, target);
      removed.push(target);
    }
    await app.close();
    const db = new DatabaseSync(database);
    for (const id of removed) {
      const tombstone = db.prepare('SELECT deleted,length(bytes) AS size,digest FROM files WHERE id=?').get(id)!;
      assert.deepEqual({ ...tombstone }, { deleted: 1, size: 0, digest: '' });
    }
    assert(Number(db.prepare("SELECT count(*) AS count FROM flow_tool_calls WHERE json_extract(call,'$.function.name')='open_file_in_panel'").get()!.count) > 0);
    db.close(); app = await startApp(options);
    assert.equal((await get(`${scopes[0]}/files`)).length, 1);
    assert((await get(`${scopes[0]}/turns`)).some((turn: { generatedFiles: { deleted?: boolean }[] }) => turn.generatedFiles.some(file => file.deleted)));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
