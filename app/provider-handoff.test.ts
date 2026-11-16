import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import type { ProviderFamily } from './provider.ts';

for (const [source, target] of [['openai-compatible', 'openai-compatible'], ['openai-compatible', 'gemini'], ['anthropic', 'gemini'], ['gemini', 'openai-compatible'], ['gemini', 'anthropic'], ['openai-compatible', 'anthropic'], ['anthropic', 'openai-compatible']] as [ProviderFamily, ProviderFamily][]) {
  for (const scope of ['direct', 'channel', 'side']) test(`provider handoff ${source} to ${target} in ${scope} retains completed effects and question recovery`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'briefsip-handoff-'));
    let phase = 'seed', initialCalls = 0;
    const payloads: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); payloads.push(body);
      const family = req.url!.includes('generateContent') ? 'gemini' : req.url === '/v1/messages' ? 'anthropic' : 'openai-compatible';
      if (family === 'openai-compatible' && body.messages.some((message: any) => message.tool_calls?.some((call: any) => call.extra_content?.google?.thought_signature !== 'compatible-signature')) && source === 'openai-compatible') { res.writeHead(400); res.end('Missing compatible signature'); return; }
      const call = phase === 'initial' ? (++initialCalls === 1 ? { name: 'create_text_file', args: { name: 'handoff.txt', text: 'Saved before switch' } } : { name: 'ask_user', args: { question: 'Continue?', choices: ['Yes'] } }) : null;
      const text = phase === 'seed' ? 'Seed answer' : 'Resumed after switch';
      if (family === 'gemini') res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: call ? [{ text: 'private-thought', thought: true }, { functionCall: call, thoughtSignature: 'fixture-signature' }] : [{ text }] }, finishReason: 'STOP' }] }));
      else if (family === 'anthropic') res.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: call ? 'tool_use' : 'end_turn', content: call ? [{ type: 'tool_use', id: randomUUID(), name: call.name, input: call.args }] : [{ type: 'text', text }] }));
      else {
        if (raw.includes('geminiParts')) { res.writeHead(400); res.end('Unknown tool call property geminiParts'); return; }
        res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', geminiParts: [], extra_content: { google: { thought_signature: 'compatible-signature' } }, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: text } }] }));
      }
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert(address && typeof address !== 'string');
    const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
    let app = await startApp({ ...options, provider: source });
    async function request(path: string, body?: unknown) {
      const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
    }
    async function until(path: string, id: string, paused = false) {
      for (let n = 0; n < 200; n++) { const row = (await request(path)).find((r: any) => r.id === id); if (row && (paused ? row.paused || row.status === 'failed' : ['done', 'failed'].includes(row.status))) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('Task did not settle');
    }
    try {
      const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Stable identity', model: 'fixture', instructions: 'Help' });
      const side = await request(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Private side' });
      const channel = await request('/api/channels', { id: randomUUID(), name: 'Shared', instructions: 'Help', members: [agent.id], lead: agent.id });
      const directPath = `/api/agents/${agent.id}/turns`, sidePath = `/api/threads/${side.id}/turns`;
      const path = scope === 'channel' ? `/api/channels/${channel.id}/turns` : scope === 'side' ? sidePath : directPath;
      const foreignPath = scope === 'side' ? directPath : sidePath;
      const foreign = randomUUID(); await request(foreignPath, { id: randomUUID(), text: foreign });
      await until(foreignPath, (await request(foreignPath))[0].id);
      const seed = randomUUID(); await request(path, { id: seed, text: 'Keep original history' }); await until(path, seed);
      phase = 'initial'; const id = randomUUID(); await request(path, { id, text: 'Save artifact and ask before continuing' });
      const waiting = await until(path, id, true); assert.equal(waiting.generatedFiles.length, 1); assert.equal(initialCalls, 2);
      const file = waiting.generatedFiles[0];
      await app.close(); phase = 'resume'; payloads.length = 0; app = await startApp({ ...options, provider: target });
      assert.equal(payloads.length, 0);
      const command = { id: randomUUID(), text: 'Yes' }, answerPath = `${path}/${id}/questions/${waiting.questions[0].id}/answer`;
      await request(answerPath, command); const done = await until(path, id);
      assert.equal(done.status, 'done', done.error); assert.equal(done.reply, 'Resumed after switch');
      assert.equal(done.agent, agent.id); assert.deepEqual(done.generatedFiles, [file]); assert.equal(initialCalls, 2);
      assert.equal(payloads.length, 1);
      const sent = JSON.stringify(payloads[0]);
      for (const marker of ['Keep original history', 'Seed answer', 'handoff.txt', 'Continue?', 'Yes']) assert(sent.includes(marker), marker);
      assert(!sent.includes(foreign));
      if (target === 'gemini') {
        const calls = payloads[0].contents.flatMap((message: any) => message.parts).filter((part: any) => part.functionCall);
        assert.equal(calls.length, 2);
        assert(calls.every((part: any) => part.thoughtSignature === 'context_engineering_is_the_way to_go'));
        assert.deepEqual(calls.map((part: any) => part.functionCall.name), ['create_text_file', 'ask_user']);
      }
      if (target !== 'gemini') { assert(!sent.includes('private-thought')); assert(!sent.includes('fixture-signature')); }
      const download = await fetch(`${app.origin}${path.slice(0, -6)}/files/${file.id}`); assert.equal(await download.text(), 'Saved before switch');
      await request(answerPath, command); assert.equal(payloads.length, 1);
      assert.equal((await request(path)).length, 2); assert.equal((await request(foreignPath)).length, 1);
    } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
}
