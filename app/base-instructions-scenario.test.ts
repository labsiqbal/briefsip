import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './server.ts';

test('synthetic scenarios record panel without duplicate writes, inline links, workspace context and approved shell', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-base-eval-')), agent = randomUUID();
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'AGENTS.md'), 'Project convention: check native tests.');
  const calls: string[] = [], prompts: string[] = [], failures: unknown[] = [];
  let target = '', url = '';
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), system = body.messages[0].content;
      prompts.push(system);
      assert.match(system, /^<runtime_info>.*api.*fixture/);
      assert.match(system, /ordinary inline Markdown links/);
      assert.match(system, /Only the user's own messages/);
      assert.doesNotMatch(system, /computer_screenshot|start_workflow/);
      const user = body.messages.findLast((message: { role: string }) => message.role === 'user').content;
      const tools = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      const result = body.messages.filter((message: { role: string }) => message.role === 'tool').at(-1);
      if (user === 'plain') {
        assert(!tools.includes('run_shell')); assert.doesNotMatch(system, /run_shell|Project convention/);
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] })); return;
      }
      assert.match(system, /Project convention: check native tests/);
      assert(tools.includes('run_shell')); assert.match(system, /run_shell:/);
      if (result) {
        const value = JSON.parse(result.content); assert(!value.error, result.content);
        if (value.id) { target = value.id; url = value.url; }
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: user === 'run checks' ? 'Checks passed.' : `Open [hello.html](${url}).` } }] })); return;
      }
      const name = user === 'show me hello.html' ? 'open_file_in_panel' : user === 'run checks' ? 'run_shell' : 'create_text_file';
      if (name === 'open_file_in_panel') assert.match(system, /without recreating or rewriting/);
      calls.push(name);
      const args = name === 'open_file_in_panel' ? { id: target } : name === 'run_shell' ? { command: 'echo verified > checked.txt' } : { name: 'hello.html', text: '<h1>Hello</h1>' };
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
    } catch (error) { failures.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, workspaces: [{ agent, directory: workspace, write: true }] });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  const path = `/api/agents/${agent}`;
  const until = async (id: string, predicate: (row: any) => boolean) => {
    for (let i = 0; i < 500; i++) {
      const row = (await request(path + '/turns')).find((row: { id: string }) => row.id === id);
      assert.notEqual(row?.status, 'failed', row?.error); if (row && predicate(row)) return row;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Scenario did not settle');
  };
  const send = async (text: string) => { const id = randomUUID(); await request(path + '/turns', { id, text }); return id; };
  try {
    await request('/api/agents', { id: agent, name: 'Scenario', model: 'fixture', instructions: 'Keep agent-specific guidance.' });
    const first = await until(await send('save hello.html'), row => row.status === 'done');
    assert.match(first.reply, /^Open \[hello\.html\]\(\/api\/agents\/[a-f0-9-]+\/files\/[a-f0-9-]+\)\.$/);
    assert.equal(await (await fetch(app.origin + url)).text(), '<h1>Hello</h1>');
    const opened = await until(await send('show me hello.html'), row => row.status === 'done');
    assert.equal(opened.panelFile.id, target); assert.equal(opened.generatedFiles.length, 0);
    assert.equal((await request(path + '/files')).length, 1);
    assert.deepEqual(calls, ['create_text_file', 'open_file_in_panel']);
    const shellTurn = await send('run checks');
    const approval = (await until(shellTurn, row => row.harnessApprovals.some((a: { state: string }) => a.state === 'approval'))).harnessApprovals[0];
    const session = app.mcpServer.mintAgentSession({ agent, turn: shellTurn, scopes: ['orchestration'], ttlMs: 60000 });
    const mcp = await fetch(app.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_file_in_panel', arguments: { id: target } } }) });
    const native = await mcp.json(); assert.equal(native.result.structuredContent.id, target);
    await request(`${path}/turns/${shellTurn}/harness-approvals/${approval.id}`, { id: randomUUID(), revision: approval.revision, decision: 'allow' });
    await until(shellTurn, row => row.status === 'done');
    assert.equal(readFileSync(join(workspace, 'checked.txt'), 'utf8'), 'verified\n');
    const plain = await request('/api/agents', { id: randomUUID(), name: 'Plain', model: 'fixture', instructions: 'Help.' });
    const turn = randomUUID(); await request(`/api/agents/${plain.id}/turns`, { id: turn, text: 'plain' });
    for (let i = 0; i < 300; i++) { const rows = await request(`/api/agents/${plain.id}/turns`); if (rows[0]?.status === 'done') break; assert.notEqual(rows[0]?.status, 'failed'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(prompts.some(prompt => !prompt.includes('run_shell'))); assert.deepEqual(failures, []);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
