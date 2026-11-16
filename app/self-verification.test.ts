import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { checkCommand, createSelfVerification } from './self-verification.ts';

test('synthetic done without verification gets one nudge, checks precede final, evidence stays outside reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-verify-')), database = join(dir, 'state.sqlite');
  const calls: string[] = [], errors: unknown[] = []; let file = '', checked = false, reviewed = false;
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { messages } = JSON.parse(raw), last = messages.at(-1);
      let message;
      const tool = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (messages[0].content.includes('One verification reminder') && !checked) {
        calls.push('nudge'); message = tool('open_file_in_panel', { id: file }); checked = true;
      } else if (last.role === 'tool') {
        const result = JSON.parse(last.content), name = messages.at(-2).tool_calls[0].function.name;
        calls.push(name); assert(!result.error, last.content);
        if (name === 'create_text_file') { file = result.id; message = { content: 'Done.' }; }
        else if (name === 'open_file_in_panel') { checked = true; message = tool('verify_result', { kind: 'file', review: 'Reread request: result.txt contains the requested result.' }); }
        else { assert(result.verified); reviewed = true; message = { content: `Saved [result.txt](/api/agents/${agent}/files/${file}).` }; }
      } else message = tool('create_text_file', { name: 'result.txt', text: 'Requested result' });
      res.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
    } catch (error) { errors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const agent = randomUUID();
  let app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1` });
  const request = async (path: string, body?: unknown) => { const r = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert(r.ok, await r.clone().text()); return r.json(); };
  try {
    await request('/api/agents', { id: agent, runtime: 'api', name: 'Verify', model: 'fixture', instructions: 'Work.' });
    const turn = randomUUID(); await request(`/api/agents/${agent}/turns`, { id: turn, text: 'Create result.txt with the requested result.' });
    let row;
    for (let n = 0; n < 300; n++) { row = (await request(`/api/agents/${agent}/turns`))[0]; if (row.status === 'done') break; assert.notEqual(row.status, 'failed', row.error); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(row.status, 'done'); assert(checked && reviewed); assert.deepEqual(errors, []);
    assert.deepEqual(calls, ['create_text_file', 'nudge', 'open_file_in_panel', 'verify_result']);
    assert.match(row.reply, /^Saved \[result\.txt\]/); assert(!row.reply.includes('test-summary'));
    await app.close();
    const db = new DatabaseSync(database), v = createSelfVerification(db);
    try {
      db.prepare('DELETE FROM turn_verification WHERE turn=?').run(turn);
      v.command(turn, 'native-check', 'npm test', '1 test passed', 0);
      assert.equal(v.nudge(turn), null);
      db.prepare('INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES (?,?,?,?,0,0)').run(turn, 'read-after-tests', JSON.stringify({ function: { name: 'run_shell', arguments: JSON.stringify({ command: 'cat result.txt' }) } }), JSON.stringify({ output: 'Requested result', exitCode: 0 }));
      assert.equal(v.review(turn, { kind: 'code', review: 'Tests ran before rereading the result.' }).verified, true);
      assert.equal(v.nudge(turn), null);
      db.prepare("INSERT INTO harness_steps VALUES (?,'changed','fileChange','completed')").run(turn);
      assert.equal(v.review(turn, { kind: 'code', review: 'Old tests do not cover the edit.' }).verified, false);
      assert.match(v.nudge(turn)!, /One verification reminder/);
      assert.equal(v.nudge(turn), null);
      const artifacts = v.artifacts(turn); assert.equal(artifacts.length, 2);
      const bytes = db.prepare('SELECT bytes FROM files WHERE id=?').get(artifacts[0].id)!.bytes as Uint8Array; assert.match(Buffer.from(bytes).toString(), /1 test passed/);
      const screenshot = randomUUID();
      db.prepare('INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES (?,?,?,?,0,0)').run(turn, screenshot, JSON.stringify({ function: { name: 'computer_screenshot', arguments: '{}' } }), '{}');
      db.prepare("INSERT INTO computer_actions VALUES (?,?,'done',?)").run(turn, screenshot, Buffer.from('screenshot fixture'));
      assert.equal(v.review(turn, { kind: 'ui', review: 'Screenshot inspected against request.' }).verified, true);
      assert.equal(v.artifacts(turn).length, 3);
      assert.equal(v.review(turn, { kind: 'routine', review: 'No saved routine.' }).verified, false);
      db.prepare('DELETE FROM turn_verification WHERE turn=?').run(turn);
      db.prepare("INSERT INTO harness_steps VALUES (?,'changed-again','fileChange','completed')").run(turn);
      db.prepare('INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action) VALUES (?,?,?,?,0,0)').run(turn, 'routine-readback', JSON.stringify({ function: { name: 'read_routine', arguments: '{}' } }), JSON.stringify({ routine: { id: randomUUID() } }));
      assert.equal(v.nudge(turn), null);
      assert.equal(db.prepare('SELECT nudged FROM turn_verification WHERE turn=?').get(turn), undefined);
    } finally { db.close(); }
    app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1` });
    const restored = (await request(`/api/agents/${agent}/turns`))[0];
    assert.equal(restored.generatedFiles.length, 1); assert.equal(restored.activity.artifacts.length, 3);
    assert.match(await (await fetch(app.origin + restored.activity.artifacts[0].url)).text(), /1 test passed/);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('common check commands recognized without treating ordinary writes as tests', () => {
  for (const command of ['npm test', 'npm run build', 'pnpm test:unit', 'node --test app.test.mjs', 'python3 -m unittest', 'cargo test']) assert(checkCommand(command), command);
  for (const command of ['echo done', 'cat test.js', 'touch result.txt', 'echo pytest', 'cat jest.js', 'echo node --test']) assert(!checkCommand(command), command);
});
