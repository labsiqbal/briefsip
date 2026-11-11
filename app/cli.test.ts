import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cli } from './cli.ts';
import { startApp } from './server.ts';

test('script CLI discovers only grants, sends once, waits, preserves retry ID and reports attention/timeouts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-cli-')); let calls = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; calls++;
    const text = JSON.parse(raw).messages.at(-1).content;
    if (text === 'HOLD') return;
    const ask = text === 'ASK';
    res.end(JSON.stringify({ choices: [{ finish_reason: ask ? 'tool_calls' : 'stop', message: ask ? { tool_calls: [{ id: 'question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Choose', choices: ['Yes','No'] }) } }] } : { content: 'Answer' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const directory = join(dir, 'scripts'), options = { database: join(dir, 'db.sqlite'), scriptDirectory: directory, baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await res.json(); assert(res.ok, JSON.stringify(value)); return value;
  }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'Alpha', model: 'test', instructions: 'Help' });
    const b = await request('/api/agents', { id: randomUUID(), name: 'alpha', model: 'test', instructions: 'Help' });
    await request(`/api/agents/${a.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    const list = await cli(['list'], directory); assert.equal(list.exitCode, 0); assert.deepEqual(list.agents?.map(row => row.id), [a.id]);
    const id = randomUUID(), args = ['run','ALPHA','Hello','--id',id,'--wait','--timeout','3'];
    const done = await cli(args, directory); assert.equal(done.exitCode, 0); assert.equal(done.turn.reply, 'Answer');
    assert.equal((await cli(args, directory)).exitCode, 0); assert.equal(calls, 1);
    assert.equal((await cli(['status',a.id,id], directory)).turn.id, id);
    await request(`/api/agents/${b.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    assert.equal((await cli(['run','Alpha','Ambiguous'], directory)).exitCode, 2); assert.equal(calls, 1);
    const ask = await cli(['run',a.id,'ASK','--wait','--timeout','3'], directory); assert.equal(ask.exitCode, 3);
    assert.equal((await cli(['cancel',a.id,ask.id!], directory)).exitCode, 0);
    assert.equal((await cli(['status',a.id,ask.id!], directory)).exitCode, 1);
    const held = await cli(['run',a.id,'HOLD','--wait','--timeout','1'], directory); assert.equal(held.exitCode, 4); assert(held.id);
    assert.equal((await cli(['status',a.id,held.id], directory)).turn.status, 'running');
    assert.equal((await cli(['cancel',b.id,held.id], directory)).exitCode, 1);
    assert.equal((await cli(['status',a.id,held.id], directory)).turn.status, 'running');
    assert.equal((await cli(['cancel',a.id,held.id.toUpperCase()], directory)).exitCode, 0);
    const cancelled = await cli(['cancel',a.id,held.id], directory);
    assert.equal(cancelled.exitCode, 0); assert.equal(cancelled.turn.status, 'cancelled');
    assert.equal((await cli(['cancel',a.id,id], directory)).exitCode, 1);
    assert.equal((await cli(['status',a.id,held.id], directory)).exitCode, 1);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types','cli.ts','list'], { cwd: import.meta.dirname, env: { ...process.env, BRIEFSIP_SCRIPT_DIRECTORY: directory }, stdio: ['ignore','pipe','pipe'] });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume(); child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(`CLI exit ${code}`)); else resolve(text); });
    });
    assert.equal(JSON.parse(output).agents.length, 2); assert(!output.includes(JSON.parse(readFileSync(join(directory,'connection.json'),'utf8')).token));
    const unicode = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types','cli.ts','run',a.id,'-','--wait','--timeout','3'], { cwd: import.meta.dirname, env: { ...process.env, BRIEFSIP_SCRIPT_DIRECTORY: directory }, stdio: ['pipe','pipe','pipe'] });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume(); child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(`CLI exit ${code}: ${text}`)); else resolve(text); });
      child.stdin.write(Buffer.from([0x63,0x61,0x66,0xc3]));
      setTimeout(() => child.stdin.end(Buffer.from([0xa9])), 500);
    });
    assert.equal(JSON.parse(unicode).turn.text, 'café');
    const connectionFile = join(directory, 'connection.json'), saved = readFileSync(connectionFile, 'utf8');
    let drop = true, observed: (() => void) | undefined;
    const proxy = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const response = await fetch(app.origin + req.url, { method: req.method, headers: { Authorization: req.headers.authorization!, 'Content-Type': 'application/json' }, body: body || undefined });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (req.method === 'POST' && drop) { drop = false; res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes);
      if (req.method === 'GET' && req.url?.includes('?focus=')) observed?.();
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address(); assert(proxyAddress && typeof proxyAddress !== 'string');
    try {
      writeFileSync(connectionFile, JSON.stringify({ ...JSON.parse(saved), url: `http://127.0.0.1:${proxyAddress.port}` }));
      const lost = await cli(['run',a.id,'Lost response'], directory); assert.equal(lost.exitCode, 5); assert(lost.id);
      const recovered = await cli(['run',a.id,'Lost response','--id',lost.id,'--wait','--timeout','3'], directory);
      assert.equal(recovered.exitCode, 0); assert.equal(recovered.id, lost.id); assert.equal(calls, 5);
      const pending = await cli(['run',a.id,'HOLD'], directory); assert.equal(pending.exitCode, 0);
      drop = true;
      const lostCancel = await cli(['cancel',a.id,pending.id!], directory);
      assert.equal(lostCancel.exitCode, 5); assert.equal(lostCancel.id, pending.id);
      const cancelRetry = await cli(['cancel',a.id,pending.id!], directory);
      assert.equal(cancelRetry.exitCode, 0); assert.equal(cancelRetry.turn.status, 'cancelled');
      const revision = cancelRetry.turn.revision;
      assert.equal((await cli(['cancel',a.id,pending.id!], directory)).turn.revision, revision);
      const restartPending = await cli(['run',a.id,'HOLD'], directory); assert.equal(restartPending.exitCode, 0);
      const seen = new Promise<void>(resolve => { observed = resolve; }); let settled = false;
      const waiting = cli(['status',a.id,restartPending.id!,'--wait','--timeout','5'], directory).then(result => { settled = true; return result; });
      await seen; observed = undefined;
      await app.close();
      await new Promise(resolve => setTimeout(resolve, 650)); assert.equal(settled, false, 'discovery gap must not end an established wait');
      app = await startApp(options);
      const interrupted = await waiting; assert.equal(interrupted.exitCode, 1); assert.equal(interrupted.turn.status, 'interrupted'); assert.equal(calls, 7);
    } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
    const collision = await request('/api/agents', { id: randomUUID(), name: a.id, model: 'test', instructions: 'Help' });
    await request(`/api/agents/${collision.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    assert.equal((await cli(['status',a.id,id], directory)).exitCode, 0);
    assert.equal((await cli(['status',a.id.toUpperCase(),id], directory)).exitCode, 0);
    await app.close(); app = await startApp(options);
    assert.equal((await cli(['status',a.id,id], directory)).turn.reply, 'Answer'); assert.equal(calls, 7);
    await request(`/api/agents/${a.id}/scripts`, { id: randomUUID(), revision: 1, enabled: false });
    assert.equal((await cli(['status',a.id,id], directory)).exitCode, 5);
    assert.equal((await cli(['cancel',a.id,held.id], directory)).exitCode, 5);
    for (let n = 0; n < 99; n++) {
      const extra = await request('/api/agents', { id: randomUUID(), name: `Extra ${n}`, model: 'test', instructions: 'Help' });
      await request(`/api/agents/${extra.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    }
    const catalog = await cli(['list'], directory); assert.equal(catalog.agents?.length, 101);
    assert.equal(new Set(catalog.agents?.map(agent => agent.id)).size, 101);
    assert(!catalog.agents?.some(agent => agent.id === a.id));
    const credentials = JSON.parse(readFileSync(connectionFile, 'utf8'));
    const headers = { Authorization: `Bearer ${credentials.token}` };
    const first = await (await fetch(app.origin + '/api/scripts/agents', { headers })).json();
    assert.equal(first.agents.length, 100); assert(first.next_after);
    const second = await (await fetch(app.origin + '/api/scripts/agents?after=' + first.next_after, { headers })).json();
    assert.equal(second.agents.length, 1); assert.equal(second.next_after, null);
    for (const suffix of ['?after=invalid', '?unexpected=1']) {
      const rejected = await fetch(app.origin + '/api/scripts/agents' + suffix, { headers }); assert.equal(rejected.status, 400); await rejected.arrayBuffer();
    }
    const denied = await fetch(app.origin + '/api/scripts/agents', { headers: { ...headers, Origin: app.origin } }); assert.equal(denied.status, 403); await denied.arrayBuffer();
    const side = await request(`/api/agents/${b.id}/threads`, { id: randomUUID(), name: 'Cancellation scope' });
    const sideTurn = await request(`/api/threads/${side.id}/turns`, { id: randomUUID(), text: 'HOLD' });
    assert.equal((await cli(['cancel',b.id,sideTurn.id], directory)).exitCode, 1);
    await request(`/api/threads/${side.id}/turns/${sideTurn.id}/cancel`, { id: randomUUID() });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Cancellation scope', instructions: 'Help', members: [b.id], lead: b.id });
    const channelTurn = await request(`/api/channels/${channel.id}/turns`, { id: randomUUID(), text: 'HOLD', agent: b.id });
    assert.equal((await cli(['cancel',b.id,channelTurn.id], directory)).exitCode, 1);
    await request(`/api/channels/${channel.id}/turns/${channelTurn.id}/cancel`, { id: randomUUID() });
    const revokeTarget = await cli(['run',b.id,'HOLD'], directory);
    assert.equal(revokeTarget.exitCode, 0);
    const cancelPath = `/api/scripts/agents/${b.id}/turns/${revokeTarget.id}/cancel`;
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(app.origin + cancelPath, { method, headers });
      assert.equal(response.status, 405); await response.arrayBuffer();
    }
    let finishBody!: () => void;
    const delayed = new Promise<number | undefined>((resolve, reject) => {
      const raw = JSON.stringify({ id: revokeTarget.id });
      const req = httpRequest(app.origin + cancelPath, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write(raw.slice(0, -1)); finishBody = () => req.end(raw.slice(-1));
    });
    await request(`/api/agents/${b.id}/scripts`, { id: randomUUID(), revision: 1, enabled: false });
    finishBody(); assert.equal(await delayed, 403);
    const retained = await request(`/api/agents/${b.id}/turns?focus=${revokeTarget.id}`);
    assert(['queued','running'].includes(retained[0].status));
    await request(`/api/agents/${b.id}/turns/${revokeTarget.id}/cancel`, { id: randomUUID() });
    const file = join(directory, 'connection.json'), original = readFileSync(file);
    writeFileSync(file, JSON.stringify({ url: 'https://example.com', token: 'x'.repeat(32) }));
    assert.equal((await cli(['list'], directory)).exitCode, 5); writeFileSync(file, original);
    await assert.rejects(cli(['run',a.id,'Hello','--id'], directory));
    await assert.rejects(cli(['cancel',a.id], directory));
    await assert.rejects(cli(['cancel',a.id,id,'--wait'], directory));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
