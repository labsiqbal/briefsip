import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
test('agents bind isolated provider accounts across channels, side threads, edit and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-accounts-'));
  const calls: { account: string; body: any }[] = [];
  let transferTarget = '', pause = false;
  const provider = createServer(async (req, res) => {
    const account = req.url!.split('/')[1];
    assert.equal(req.headers.authorization, account === 'openai' ? 'Bearer key-openai' : undefined);
    assert.equal(req.headers['x-api-key'], account === 'anthropic' ? 'key-anthropic' : undefined);
    assert.equal(req.headers['x-goog-api-key'], account === 'gemini' ? 'key-gemini' : undefined);
    if (req.url!.endsWith('/models')) { res.end(JSON.stringify(account === 'gemini' ? { models: [{ name: 'models/fixture', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'fixture' }], has_more: false })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ account, body });
    const hasResult = JSON.stringify(body).includes('tool_result') || JSON.stringify(body).includes('functionResponse') || body.messages?.at(-1)?.role === 'tool';
    const call = !hasResult && pause ? { name: 'ask_user', args: { question: 'Continue?', choices: ['Yes'] } } : !hasResult && transferTarget && account === 'openai' ? { name: 'transfer_task', args: { recipient: transferTarget, task: 'Finish handoff' } } : null;
    if (account === 'gemini') res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: call ? [{ functionCall: call, thoughtSignature: 'signed' }] : [{ text: account }] }, finishReason: 'STOP' }] }));
    else if (account === 'anthropic') res.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: call ? 'tool_use' : 'end_turn', content: call ? [{ type: 'tool_use', id: randomUUID(), name: call.name, input: call.args }] : [{ type: 'text', text: account }] }));
    else res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: account } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const accounts = ['openai','anthropic','gemini','public'].map(id => ({ id, name: id, provider: ['openai','public'].includes(id) ? 'openai-compatible' : id, baseURL: `http://127.0.0.1:${address.port}/${id}`, apiKey: id === 'public' ? undefined : `key-${id}` }));
  const options = { database: join(dir, 'state.sqlite'), accounts };
  let app = await startApp(options, { directory: dir, servers: [provider] });
  async function request(path: string, body?: unknown, status = 200) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert(status === 200 ? res.ok : res.status === status, JSON.stringify(data)); return data;
  }
  async function until(path: string, id: string) {
    for (let i = 0; i < 200; i++) { const row = (await request(path)).find((r: any) => r.id === id); if (row && (row.paused || ['done','failed'].includes(row.status))) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Task did not settle');
  }
  try {
    const publicAccounts = await request('/api/provider-accounts');
    assert.equal(publicAccounts.length, 5); assert.equal(publicAccounts.find((account: { id: string }) => account.id === 'openai').host, new URL(accounts[0].baseURL).host); assert(!JSON.stringify(publicAccounts).includes('key-')); assert(!JSON.stringify(publicAccounts).includes('baseURL'));
    for (const account of accounts) assert.deepEqual((await request(`/api/models?account=${account.id}`)).models, ['fixture']);
    await request('/api/models?account=missing', undefined, 503);
    const agents = [];
    for (const account of accounts) {
      const command = { id: randomUUID(), name: account.id, model: 'fixture', instructions: 'Help', providerAccount: account.id };
      const agent = await request('/api/agents', { ...command, runtime: 'api' }); agents.push(agent); assert.deepEqual(await request('/api/agents', { ...command, runtime: 'api' }), agent);
      await request('/api/agents', { runtime: 'api', ...command, providerAccount: 'missing' }, 409);
      const side = await request(`/api/agents/${agent.id}/threads`, { id: randomUUID(), name: 'Side' });
      for (const path of [`/api/agents/${agent.id}/turns`, `/api/threads/${side.id}/turns`]) { const id = randomUUID(); await request(path, { id, text: `Use ${account.id}` }); assert.equal((await until(path, id)).reply, account.id); }
    }
    await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Invalid', model: 'fixture', instructions: 'Help', providerAccount: 'missing' }, 400);
    const [a, b, c] = agents;
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Mixed', instructions: 'Help', lead: a.id, members: agents.map(agent => agent.id) });
    const channelPath = `/api/channels/${channel.id}/turns`;
    transferTarget = c.id; const transferred = randomUUID(); await request(channelPath, { id: transferred, text: 'Transfer', recipient: a.id });
    const done = await until(channelPath, transferred); assert.equal(done.reply, 'gemini'); assert.equal(done.agent, c.id); transferTarget = '';
    const path = `/api/agents/${a.id}/turns`;
    pause = true; const paused = randomUUID(); await request(path, { id: paused, text: 'Pause' }); await until(path, paused); pause = false;
    const edit = { id: randomUUID(), revision: a.revision, name: a.name, model: a.model, instructions: a.instructions, providerAccount: b.provider_account };
    await request(`/api/agents/${a.id}/edit`, edit, 409);
    await request(`${path}/${paused}/cancel`, { id: randomUUID() });
    const edited = await request(`/api/agents/${a.id}/edit`, edit); assert.equal(edited.provider_account, 'anthropic'); assert.deepEqual(await request(`/api/agents/${a.id}/edit`, edit), edited);
    const next = randomUUID(); await request(path, { id: next, text: 'After switch' }); assert.equal((await until(path, next)).reply, 'anthropic');
    const usage = await request('/api/usage'); assert(usage.calls.some((call: any) => call.agent === a.id && call.account === 'openai')); assert(usage.calls.some((call: any) => call.agent === a.id && call.account === 'anthropic'));
    await app.close();
    for (const account of accounts) if (account.apiKey) assert(!readFileSync(options.database).includes(Buffer.from(account.apiKey)));
    app = await startApp({ ...options, accounts: accounts.filter(account => account.id !== 'anthropic'), baseURL: accounts[0].baseURL, apiKey: accounts[0].apiKey });
    const publicPath = `/api/agents/${agents[3].id}/turns`, publicId = randomUUID();
    await request(publicPath, { id: publicId, text: 'No inherited default key' }); assert.equal((await until(publicPath, publicId)).reply, 'public');
    const before = calls.length;
    await request(path, { id: randomUUID(), text: 'Must not fallback' }, 503); assert.equal(calls.length, before);
    assert.equal((await request('/api/agents')).agents.find((agent: any) => agent.id === a.id).provider_available, false);
    assert((await request(path)).some((turn: any) => turn.id === next && turn.reply === 'anthropic'));
    assert.deepEqual(await request(`/api/agents/${a.id}/edit`, edit), edited);
    await request(`/api/agents/${a.id}/edit`, { ...edit, id: randomUUID(), revision: edited.revision, providerAccount: '' });
    const recovered = randomUUID(); await request(path, { id: recovered, text: 'Explicit default' }); assert.equal((await until(path, recovered)).reply, 'openai');
    pause = true; const lost = randomUUID(); await request(path, { id: lost, text: 'Last account disappears' });
    const waiting = await until(path, lost); assert.equal(waiting.paused, 1); pause = false;
    await app.close(); app = await startApp({ database: options.database });
    const sentBefore = calls.length;
    await request(`${path}/${lost}/questions/${waiting.questions[0].id}/answer`, { id: randomUUID(), text: 'Yes' });
    const failed = await until(path, lost); assert.equal(failed.status, 'failed'); assert.match(failed.error, /provider account/); assert.equal(calls.length, sentBefore);

  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
