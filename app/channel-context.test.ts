import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

for (const automatic of [true, false]) test(`channel context names lead for ${automatic ? 'automatic routing and execution' : 'explicit execution'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-channel-context-'));
  const calls: { model: string; messages: { role: string; content: string }[]; tools?: unknown[] }[] = [];
  let recipient = '';
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    const routing = body.messages[0].content.startsWith('Choose exactly one channel member');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: routing ? JSON.stringify({ action: 'assign', recipient }) : 'Channel understood.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({ database: join(directory, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` }, { directory, servers: [provider] });
  async function request(path: string, body?: unknown, status?: number) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (status) assert.equal(response.status, status, JSON.stringify(value)); else assert(response.ok, JSON.stringify(value));
    return value;
  }
  try {
    const assistant = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Assistant', model: 'assistant', instructions: 'Help.' });
    const rightHand = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Right Hand', model: 'right-hand', instructions: 'Coordinate.' });
    let channel = await request('/api/channels', { id: randomUUID(), name: 'Owner team', instructions: 'Discuss channel work.', members: [assistant.id, rightHand.id], lead: rightHand.id });
    const path = `/api/channels/${channel.id}/turns`;
    async function send(lead: string, members: string[], route = automatic) {
      const first = calls.length, id = randomUUID();
      await request(path, { id, text: 'Describe this channel.', ...(route ? { automatic: true } : { recipient }) }, 202);
      let done = false;
      for (let n = 0; n < 200; n++) {
        const turn = (await request(path)).find((row: { id: string }) => row.id === id);
        assert(!['failed', 'cancelled', 'interrupted'].includes(turn.status), JSON.stringify(turn));
        if (turn.status === 'done') { assert.equal(turn.agent, recipient); done = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(done, 'Channel turn completed');
      const captured = calls.slice(first);
      assert.equal(captured.length, route ? 2 : 1);
      for (const call of captured) {
        const routing = call.messages[0].content.startsWith('Choose exactly one channel member');
        assert.equal(call.model, routing ? (lead === 'Assistant' ? 'assistant' : 'right-hand') : recipient === assistant.id ? 'assistant' : 'right-hand');
        const context = call.messages.filter(message => message.role === 'system' || routing && message.role === 'user').map(message => message.content).join('\n');
        assert(context.includes('Owner team'), context);
        assert(context.includes('Discuss channel work.'), context);
        for (const member of members) assert(context.includes(member), context);
        if (routing) {
          const data = JSON.parse(call.messages.find(message => message.role === 'user')!.content);
          assert.equal(data.lead, lead);
        } else assert(context.includes(`Lead: ${lead}`), context);
        if (!members.includes('Right Hand')) assert(!context.includes('Right Hand'), context);
      }
    }
    recipient = rightHand.id;
    await send('Right Hand', ['Assistant', 'Right Hand']);
    recipient = assistant.id;
    await send('Right Hand', ['Assistant', 'Right Hand']);
    channel = await request(`/api/channels/${channel.id}/edit`, { ...channel, id: randomUUID(), archived: false, lead: assistant.id });
    recipient = assistant.id;
    await send('Assistant', ['Assistant', 'Right Hand']);
    channel = await request(`/api/channels/${channel.id}/edit`, { ...channel, id: randomUUID(), archived: false, lead: rightHand.id });
    await request(`/api/agents/${rightHand.id}/visibility`, { id: randomUUID(), revision: 0, hidden: true });
    const before = calls.length;
    await request(path, { id: randomUUID(), text: 'Hidden lead cannot route.', automatic: true }, 409);
    assert.equal(calls.length, before);
    await send('No lead', ['Assistant'], false);
    channel = await request(`/api/channels/${channel.id}/edit`, { ...channel, id: randomUUID(), archived: false, members: [assistant.id], lead: null });
    await send('No lead', ['Assistant'], false);
  } finally {
    await app.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
