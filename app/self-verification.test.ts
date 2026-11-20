import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('synthetic done without verification gets one nudge, checks precede final, evidence stays outside reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-verify-')), database = join(dir, 'state.sqlite');
  const calls: string[] = [], errors: unknown[] = []; let file = '', checked = false, reviewed = false;
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { messages } = JSON.parse(raw), last = messages.at(-1);
      let message;
      const tool = (name: string, args: unknown) => ({ tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (messages[0].content.includes('One verification reminder') && !checked) {
        calls.push('nudge'); message = tool('read_workspace_file', { path: 'result.txt' }); checked = true;
      } else if (last.role === 'tool') {
        const result = JSON.parse(last.content), name = messages.at(-2).tool_calls[0].function.name;
        calls.push(name); assert(!result.error, last.content);
        if (name === 'create_text_file') { file = result.id; message = { content: 'Done.' }; }
        else if (name === 'read_workspace_file') { assert.equal(result.text, 'Requested result'); checked = true; message = tool('verify_result', { kind: 'file', review: 'Reread request: result.txt contains the requested result.' }); }
        else { assert(result.verified); reviewed = true; message = { content: `Saved [result.txt](/api/agents/${agent}/files/${file}).` }; }
      } else message = tool('create_text_file', { name: 'result.txt', text: 'Requested result' });
      res.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
    } catch (error) { errors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const agent = randomUUID();
  let app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1` }, { directory: dir, servers: [provider] });
  const request = async (path: string, body?: unknown) => { const r = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert(r.ok, await r.clone().text()); return r.json(); };
  try {
    await request('/api/agents', { id: agent, runtime: 'api', name: 'Verify', model: 'fixture', instructions: 'Work.' });
    const turn = randomUUID(); await request(`/api/agents/${agent}/turns`, { id: turn, text: 'Create result.txt with the requested result.' });
    let row;
    for (let n = 0; n < 300; n++) { row = (await request(`/api/agents/${agent}/turns`))[0]; if (row.status === 'done') break; assert.notEqual(row.status, 'failed', row.error); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(row.status, 'done'); assert(checked && reviewed); assert.deepEqual(errors, []);
    assert.deepEqual(calls, ['create_text_file', 'nudge', 'read_workspace_file', 'verify_result']);
    assert.match(row.reply, /^Saved \[result\.txt\]/); assert(!row.reply.includes('test-summary'));
    await app.close();
    app = await startApp({ database, baseURL: `http://127.0.0.1:${address.port}/v1` });
    const restored = (await request(`/api/agents/${agent}/turns`))[0];
    assert.equal(restored.generatedFiles.length, 1);
    assert.equal(restored.reply, row.reply);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
