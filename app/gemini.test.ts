import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiChoice, geminiRequest, geminiTokens, geminiURL } from './gemini.ts';
import { readProviderStream } from './provider-stream.ts';
import { startApp } from './server.ts';

test('Gemini translation preserves signed parts and refuses incomplete effects', async () => {
  const parts = [{ text: 'Reasoning', thought: true }, { functionCall: { name: 'read_history', args: {} }, thoughtSignature: 'signed' }];
  const choice = geminiChoice({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
  const call = choice.message.tool_calls[0];
  assert.equal(geminiChoice({ candidates: [{ content: { parts: [{ functionCall: { name: 'list_agents' } }] }, finishReason: 'STOP' }] }).message.tool_calls[0].function.arguments, '{}');
  for (const invalid of [{ text: 'hidden call', functionCall: { name: 'delete_file', args: {} } }, { text: 'bad flag', thought: 'true' }, { functionCall: { name: 'read_history', args: null } }, { functionCall: { name: 'read_history', id: {} } }]) assert.throws(() => geminiChoice({ candidates: [{ content: { role: 'model', parts: [invalid, parts[1]] }, finishReason: 'STOP' }] }));
  const body = geminiRequest([{ role: 'system', content: 'System' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '{}' }], [], 100);
  assert.deepEqual(body.contents[1].parts, parts); assert.equal(body.contents[2].parts[0].functionResponse.name, 'read_history');
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(choice.message.content, ''); assert.deepEqual(geminiTokens({ promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 9 }), [3, 6, 9]);
  assert.deepEqual(geminiTokens({}), [null, null, null]);
  for (const model of ['../key', 'bad?key=x', 'x/y']) assert.throws(() => geminiURL('https://example.test/v1beta', model, true));
  for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL']) assert.throws(() => geminiChoice({ candidates: [{ content: { role: 'model', parts }, finishReason }] }));
  async function* stream(events: unknown[]) { for (const event of events) yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`); }
  let visible = '';
  const output = await readProviderStream(stream([{ promptFeedback: { safetyRatings: [] }, candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Hello ' }] } }] }, { candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1 } }]), 'gemini', text => { visible = text; });
  assert.equal(visible, 'Hello world'); assert.equal(geminiChoice(output).message.content, 'Hello world');
  await assert.rejects(readProviderStream(stream([{ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] }]), 'gemini', () => {}));
});

test('Gemini HTTP streaming, signed tool recovery, models and cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-gemini-'));
  let mode = 'text', requests = 0, toolCalls = 0, held = false;
  const signed = [{ text: 'internal', thought: true }, { functionCall: { name: 'create_text_file', args: { name: 'native.txt', text: 'Gemini artifact' } }, thoughtSignature: 'opaque-signature' }];
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'synthetic'); assert.equal(req.headers.authorization, undefined);
    if (req.url?.startsWith('/v1beta/models?') || req.url === '/v1beta/models') { res.end(JSON.stringify(req.url.includes('pageToken') ? { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }, { name: 'models/second', supportedGenerationMethods: ['generateContent'] }] } : { models: [{ name: 'models/fixture', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' })); return; }
    assert.match(req.url!, /^\/v1beta\/models\/fixture:(streamGenerateContent\?alt=sse|generateContent)$/);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++; assert.equal(body.generationConfig.maxOutputTokens, 4096);
    assert(body.tools[0].functionDeclarations.every((tool: any) => tool.parametersJsonSchema));
    const result = body.contents.at(-1).parts.find((part: any) => part.functionResponse);
    if (result) { assert.deepEqual(body.contents.at(-2).parts, signed); assert.equal(result.functionResponse.name, 'create_text_file'); }
    if (mode === 'hold' || mode === 'tool-hold' && result) { held = true; return; }
    const parts = mode.startsWith('tool') && !result ? (toolCalls++, signed) : [{ text: 'Gemini answer' }];
    const value = { candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: mode === 'incomplete' ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 9 } };
    if (req.url!.includes('streamGenerateContent')) { res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify(value)}\n\n`); } else res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), provider: 'gemini' as const, baseURL: `http://127.0.0.1:${address.port}/v1beta`, apiKey: 'synthetic', stream: true };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) { const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; }
  async function until(path: string, id: string, status: string) { for (let n = 0; n < 400; n++) { const row = (await request(path)).find((row: any) => row.id === id); if (row?.status === status) return row; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Missing ${status}`); }
  try {
    assert.deepEqual((await request('/api/models')).models, ['fixture', 'second']);
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Gemini', model: 'fixture', instructions: 'Help' }), path = `/api/agents/${agent.id}/turns`;
    for (mode of ['text', 'tool', 'incomplete']) { const id = randomUUID(); await request(path, { id, text: mode }); const row = await until(path, id, mode === 'incomplete' ? 'failed' : 'done'); if (mode === 'tool') assert.equal(row.generatedFiles.length, 1); }
    mode = 'tool-hold'; const id = randomUUID(); await request(path, { id, text: 'Resume signed tool' });
    for (let n = 0; n < 400 && !held; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(held);
    const before = toolCalls; await app.close(); app = await startApp(options); mode = 'tool';
    const interrupted = await until(path, id, 'interrupted'); await request(`${path}/${id}/resume`, { id: randomUUID(), revision: interrupted.revision, acknowledgeUncertain: true });
    const resumed = await until(path, id, 'done'); assert.equal(resumed.generatedFiles.length, 1); assert.equal(toolCalls, before);
    mode = 'hold'; held = false; const cancel = randomUUID(); await request(path, { id: cancel, text: 'Cancel' });
    for (let n = 0; n < 400 && !held; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(held);
    await request(`${path}/${cancel}/cancel`, { id: randomUUID() }); await until(path, cancel, 'cancelled');
    await app.close(); app = await startApp({ ...options, stream: false }); mode = 'text'; const unary = randomUUID(); await request(path, { id: unary, text: 'Unary' }); assert.equal((await until(path, unary, 'done')).reply, 'Gemini answer');
    assert(requests >= 8);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
