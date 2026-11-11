import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
    await request(`/api/agents/${a.id}/turns/${ask.id}/cancel`, { id: randomUUID() });
    assert.equal((await cli(['status',a.id,ask.id!], directory)).exitCode, 1);
    const held = await cli(['run',a.id,'HOLD','--wait','--timeout','1'], directory); assert.equal(held.exitCode, 4); assert(held.id);
    assert.equal((await cli(['status',a.id,held.id], directory)).turn.status, 'running');
    await request(`/api/agents/${a.id}/turns/${held.id}/cancel`, { id: randomUUID() });
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
    let drop = true;
    const proxy = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const response = await fetch(app.origin + req.url, { method: req.method, headers: { Authorization: req.headers.authorization!, 'Content-Type': 'application/json' }, body: body || undefined });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (req.method === 'POST' && drop) { drop = false; res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address(); assert(proxyAddress && typeof proxyAddress !== 'string');
    try {
      writeFileSync(connectionFile, JSON.stringify({ ...JSON.parse(saved), url: `http://127.0.0.1:${proxyAddress.port}` }));
      const lost = await cli(['run',a.id,'Lost response'], directory); assert.equal(lost.exitCode, 5); assert(lost.id);
      const recovered = await cli(['run',a.id,'Lost response','--id',lost.id,'--wait','--timeout','3'], directory);
      assert.equal(recovered.exitCode, 0); assert.equal(recovered.id, lost.id); assert.equal(calls, 5);
    } finally { writeFileSync(connectionFile, saved); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
    const collision = await request('/api/agents', { id: randomUUID(), name: a.id, model: 'test', instructions: 'Help' });
    await request(`/api/agents/${collision.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
    assert.equal((await cli(['status',a.id,id], directory)).exitCode, 0);
    assert.equal((await cli(['status',a.id.toUpperCase(),id], directory)).exitCode, 0);
    await app.close(); app = await startApp(options);
    assert.equal((await cli(['status',a.id,id], directory)).turn.reply, 'Answer'); assert.equal(calls, 5);
    await request(`/api/agents/${a.id}/scripts`, { id: randomUUID(), revision: 1, enabled: false });
    assert.equal((await cli(['status',a.id,id], directory)).exitCode, 5);
    const file = join(directory, 'connection.json'), original = readFileSync(file);
    writeFileSync(file, JSON.stringify({ url: 'https://example.com', token: 'x'.repeat(32) }));
    assert.equal((await cli(['list'], directory)).exitCode, 5); writeFileSync(file, original);
    await assert.rejects(cli(['run',a.id,'Hello','--id'], directory));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
