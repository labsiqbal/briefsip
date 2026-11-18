import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from './test-bridge.ts';
import { initializeMcpSessions, mintAgentSession, verifyBearer, revokeAgentSession } from './t3/mcp-session-registry.ts';
import type { McpScope } from './shared/mcp-scopes.ts';
const allScopes: McpScope[] = ['agents:read','agents:message','history:read'];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-mcp-server-')), database = join(dir, 'state.sqlite');
  let release: (() => void) | undefined, hold = false, calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume synthetic provider request */ }
    calls++; if (hold) await new Promise<void>(resolve => { release = resolve; });
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Reply from fixture.' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database, baseURL: `http://127.0.0.1:${address.port}/v1`, allowedOrigins: ['https://briefsip.example:4317'] };
  let app = await startApp(options);
  const clients: Client[] = [];
  async function post(path: string, body: unknown, expected = 200) { const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value; }
  async function peer(name = 'Laptop', scopes = allScopes) { return post('/api/mcp-server/peer-tokens', { id: randomUUID(), name, scopes }); }
  async function client(token: string) { const client = new Client({ name: 'briefsip-test', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(app.origin + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } })); return client; }
  async function rpc(token: string | undefined, method = 'tools/list', params: unknown = {}, headers: Record<string,string> = {}) { return fetch(app.origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); }
  const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Local agent', role: 'Personal agent', model: 'fixture', instructions: 'Help.' }, 201);
  return { get app() { return app; }, database, agent, post, peer, client, rpc, get calls() { return calls; }, hold() { hold = true; }, release() { hold = false; release?.(); }, async restart() { await Promise.all(clients.splice(0).map(client => client.close())); await app.close(); app = await startApp(options); }, async close() { hold = false; release?.(); await Promise.all(clients.map(client => client.close())); await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result)); return result.structuredContent as Record<string, any>;
}
async function waitFor(check: () => Promise<boolean>) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('MCP fixture did not settle'); }

test('real MCP client calls all tools, isolated peer history, stable send receipts and payload conflict', async () => {
  const f = await fixture();
  try {
    const ownerId = randomUUID(); await f.post(`/api/agents/${f.agent.id}/turns`, { id: ownerId, text: 'OWNER_PRIVATE_CANARY' }, 202);
    const a = await f.peer('Laptop A'), b = await f.peer('Laptop B');
    const ca = await f.client(a.token), cb = await f.client(b.token);
    assert.deepEqual((await ca.listTools()).tools.map(tool => tool.name).sort(), ['cancel_message','get_message_status','list_agents','read_history','send_message']);
    const list = await call(ca, 'list_agents'); assert.equal(list.agents[0].id, f.agent.id); assert.equal(list.agents[0].model, 'fixture'); assert(list.agents[0].description); assert.equal(list.agents[0].role, 'Personal agent'); assert(['idle','working'].includes(list.agents[0].status));
    const requestId = randomUUID(), args = { requestId, recipient: f.agent.id, text: 'PEER_A_CANARY' };
    const delivery = await call(ca, 'send_message', args); assert.equal(delivery.status, 'queued');
    await waitFor(async () => (await call(ca, 'get_message_status', { requestId })).status === 'done');
    assert.equal((await call(ca, 'get_message_status', { requestId })).reply, 'Reply from fixture.');
    assert.deepEqual(await call(ca, 'send_message', args), delivery);
    const drift = await f.rpc(a.token, 'tools/call', { name: 'send_message', arguments: { ...args, text: 'Changed' } }); assert.equal(drift.status, 409);
    const before = f.calls;
    assert.deepEqual(await call(ca, 'send_message', args), delivery); assert.equal(f.calls, before);
    const second = { requestId: randomUUID(), recipient: f.agent.id, text: 'PEER_A_SECOND' }; await call(ca, 'send_message', second);
    await call(cb, 'send_message', { requestId: randomUUID(), recipient: f.agent.id, text: 'PEER_B_CANARY' });
    const page = await call(ca, 'read_history', { limit: 1 }); assert.equal(page.messages.length, 1); assert(page.next_before);
    const older = await call(ca, 'read_history', { limit: 1, before: page.next_before }); assert.equal(older.messages[0].id, delivery.turn); assert.equal(older.next_before, null);
    const historyB = await call(cb, 'read_history'); assert.equal(historyB.messages.length, 1); assert.equal(historyB.messages[0].text, 'PEER_B_CANARY');
    assert(!JSON.stringify([page, older, historyB]).includes('OWNER_PRIVATE_CANARY')); assert(!JSON.stringify(historyB).includes('PEER_A_CANARY'));
    const denied = await cb.callTool({ name: 'get_message_status', arguments: { requestId } }); assert(denied.isError); assert(!JSON.stringify(denied).includes(delivery.turn));
    const transcript = await (await fetch(f.app.origin + `/api/threads/${delivery.thread}/turns`)).json(); assert.equal(transcript[0].origin, 'peer:Laptop A'); assert.equal(transcript[0].messageOrigin.name, 'Laptop A'); assert.equal(transcript[0].messageOrigin.kind, 'peer');
    await f.restart(); const restarted = await f.client(a.token); assert.deepEqual(await call(restarted,'send_message', args), delivery);
    assert.equal((await call(restarted,'read_history')).messages.length, 2);
  } finally { await f.close(); }
});

test('MCP scope, credential failures, schema checks and browser boundaries', async () => {
  const f = await fixture();
  try {
    const read = await f.peer('Read only', ['agents:read']), client = await f.client(read.token);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_agents']);
    const forbiddenBodies: unknown[] = [];
    for (const name of ['send_message','get_message_status','read_history','unknown_tool']) {
      const response = await f.rpc(read.token,'tools/call',{ name, arguments: {} }); assert.equal(response.status, 403); forbiddenBodies.push(await response.json());
    }
    assert(forbiddenBodies.every(body => JSON.stringify(body) === JSON.stringify(forbiddenBodies[0])));
    const schema = await f.rpc(read.token,'tools/call',{ name: 'list_agents', arguments: { extra: 'not allowed' } }); assert.equal(schema.status, 400);
    const denied = await f.rpc(read.token,'tools/call',{ name: 'read_history', arguments: { limit: -1 } }); assert.equal(denied.status, 403);
    const full = await f.peer();
    for (const args of [{ limit: 51 }, { before: 0 }, { agent: f.agent.id }, { before: 1.5 }]) assert.equal((await f.rpc(full.token,'tools/call',{ name: 'read_history', arguments: args })).status, 400);
    const expired = f.app.mcpServer.mintAgentSession({ agent: f.agent.id, scopes: allScopes, ttlMs: 1 }); await new Promise(resolve => setTimeout(resolve, 5));
    const revoked = await f.peer('Revoked'); await f.post(`/api/mcp-server/peer-tokens/${revoked.id}/revoke`, { id: randomUUID() });
    const bodies: string[] = [];
    for (const token of [undefined, 'wrong-token', 'A'.repeat(43), revoked.token, expired.token]) { const response = await f.rpc(token); assert.equal(response.status, 401); bodies.push(await response.text()); }
    assert(bodies.every(body => body === bodies[0])); assert.equal(bodies[0], JSON.stringify(forbiddenBodies[0]));
    assert.equal((await f.rpc(full.token,'tools/list',{}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.rpc(full.token,'tools/list',{}, { Origin: 'https://briefsip.example:4317' })).status, 200);
    assert.equal((await f.rpc(full.token,'tools/list',{}, { Origin: f.app.origin })).status, 200);
    assert.equal((await f.rpc(undefined,'tools/list',{}, { Cookie: `token=${full.token}`, Origin: f.app.origin })).status, 401);
    const host = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(f.app.origin + '/mcp', { method:'POST', headers:{ Host:'evil.example', Authorization:`Bearer ${full.token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error',reject); req.end(); }); assert.equal(host, 403);
    const allowedHost = await f.rpc(full.token,'tools/list',{}, { Host: 'briefsip.example:4317' }); assert.equal(allowedHost.status, 200);
    assert.equal((await fetch(f.app.origin + '/mcp', { headers: { Authorization:`Bearer ${full.token}` } })).status, 405);
    assert.equal((await f.rpc(full.token,'tools/list',{}, { 'Content-Type':'text/plain' })).status, 415);
  } finally { await f.close(); }
});

test('cancel_message cannot cancel another peer or owner work', async () => {
  const f = await fixture();
  try {
    f.hold();
    const a = await f.peer('A'), b = await f.peer('B'), ca = await f.client(a.token), cb = await f.client(b.token);
    const requestId = randomUUID(), delivery = await call(ca, 'send_message', { requestId, recipient: f.agent.id, text: 'Peer work' });
    await waitFor(async () => f.calls === 1);
    assert((await cb.callTool({ name: 'cancel_message', arguments: { requestId } })).isError);
    assert.equal((await call(ca, 'get_message_status', { requestId })).status, 'running');
    const owner = randomUUID(); await f.post(`/api/agents/${f.agent.id}/turns`, { id: owner, text: 'Owner work' }, 202);
    assert((await ca.callTool({ name: 'cancel_message', arguments: { requestId: owner } })).isError);
    assert.equal((await call(ca, 'cancel_message', { requestId })).status, 'cancelled');
    assert.equal((await call(ca, 'cancel_message', { requestId })).status, 'cancelled');
    const turns = await (await fetch(f.app.origin + `/api/threads/${delivery.thread}/turns`)).json(); assert.equal(turns[0].status, 'cancelled');
    const ownerTurns = await (await fetch(f.app.origin + `/api/agents/${f.agent.id}/turns`)).json(); assert.notEqual(ownerTurns.find((row: any) => row.id === owner).status, 'cancelled');
  } finally { f.release(); await f.close(); }
});

test('owner peer token routes are idempotent, reveal once, validate boundaries and never persist bearer canaries', async () => {
  const f = await fixture(); let log = ''; const original = console.error; console.error = (...args) => { log += args.join(' '); };
  let canary = '', sessionCanary = '';
  try {
    const input = { id: randomUUID(), name: 'Work laptop', scopes: allScopes };
    const result = await f.post('/api/mcp-server/peer-tokens',input); canary = result.token; assert.match(canary,/^[A-Za-z0-9_-]{43}$/);
    const repeat = await f.post('/api/mcp-server/peer-tokens',input); assert(!repeat.token); assert(repeat.alreadyCreated);
    assert(!(await (await fetch(f.app.origin + '/api/mcp-server/peer-tokens')).text()).includes(canary));
    await f.post('/api/mcp-server/peer-tokens',{ ...input, name:'drift' },409);
    for (const patch of [{ scopes: [] }, { scopes:['history:read','history:read'] }, { scopes:['root:all'] }, { name:'' }, { name:'bad\nname' }, { id:'bad' }, { extra:true }]) await f.post('/api/mcp-server/peer-tokens',{ ...input, id:randomUUID(), ...patch },400);
    const badHeaders: Record<string, string>[] = [{ 'Content-Type':'application/json' }, { Origin:'https://evil.example','Content-Type':'application/json' }, { Origin:f.app.origin,'Content-Type':'text/plain' }, { Origin:f.app.origin,'Content-Type':'application/json', Authorization:`Bearer ${canary}` }];
    for (const headers of badHeaders) {
      const response = await fetch(f.app.origin + '/api/mcp-server/peer-tokens',{ method:'POST',headers,body:JSON.stringify({ id:randomUUID(),name:'Untrusted',scopes:allScopes }) }); assert.equal(response.status,403);
    }
    const session = f.app.mcpServer.mintAgentSession({ agent:f.agent.id,scopes:allScopes,ttlMs:60_000 }); sessionCanary = session.token;
    assert(f.app.mcpServer.verifyBearer(`Bearer ${canary}`));
    await f.restart(); assert(!f.app.mcpServer.verifyBearer(`Bearer ${sessionCanary}`)); assert(f.app.mcpServer.verifyBearer(`Bearer ${canary}`));
    const revoke = { id: randomUUID() }, path = `/api/mcp-server/peer-tokens/${input.id}/revoke`;
    const revoked = await f.post(path,revoke); assert.deepEqual(await f.post(path,revoke),revoked);
    assert(!f.app.mcpServer.verifyBearer(`Bearer ${canary}`));
    const listed = await (await fetch(f.app.origin+'/api/mcp-server/peer-tokens')).json(); assert(listed.items[0].revoked); assert(listed.items[0].lastUsed); assert(!JSON.stringify(listed).includes(canary));
    assert(!readFileSync(f.database).includes(Buffer.from(canary))); assert(!readFileSync(f.database).includes(Buffer.from(sessionCanary))); assert(!log.includes(canary)); assert(!log.includes(sessionCanary));
  } finally { console.error = original; await f.close(); }
});

test('agent session binds agent/turn, reuses conversation history rules, and revokes at run end', async () => {
  const f = await fixture();
  try {
    const owner = randomUUID(); await f.post(`/api/agents/${f.agent.id}/turns`,{ id:owner,text:'Earlier same-agent message' },202);
    await waitFor(async () => (await (await fetch(f.app.origin+`/api/agents/${f.agent.id}/turns`)).json()).some((row: any) => row.id===owner && row.status==='done'));
    f.hold(); const active = randomUUID(); await f.post(`/api/agents/${f.agent.id}/turns`,{ id:active,text:'Current session' },202);
    await waitFor(async () => (await (await fetch(f.app.origin+`/api/agents/${f.agent.id}/turns`)).json()).some((row: any) => row.id===active && row.status==='running'));
    const session = f.app.mcpServer.mintAgentSession({ agent:f.agent.id,turn:active,scopes:allScopes,ttlMs:60_000 });
    const identity = f.app.mcpServer.verifyBearer(`Bearer ${session.token}`); assert.equal(identity?.kind,'session'); assert.equal(identity?.agent,f.agent.id); assert.equal(identity?.turn,active);
    const client = await f.client(session.token), history = await call(client,'read_history'); assert.deepEqual(history.messages.map((row: any) => row.id),[owner]);
    assert(!(await call(client,'list_agents')).agents.length);
    f.release(); await waitFor(async () => !f.app.mcpServer.verifyBearer(`Bearer ${session.token}`));
    assert.equal((await f.rpc(session.token)).status,401);
    const unbound = f.app.mcpServer.mintAgentSession({ agent:f.agent.id,scopes:['agents:read'],ttlMs:60_000 }); f.app.mcpServer.revokeAgentSession(unbound.id); assert(!f.app.mcpServer.verifyBearer(`Bearer ${unbound.token}`));
    assert.throws(() => f.app.mcpServer.mintAgentSession({ agent:randomUUID(),scopes:allScopes,ttlMs:60_000 }));
    assert.throws(() => f.app.mcpServer.mintAgentSession({ agent:f.agent.id,turn:owner,scopes:allScopes,ttlMs:60_000 }));
  } finally { await f.close(); }
});

test('session registry uses exact hash lookup, bounded expiry and explicit revocation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY); CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT,status TEXT)'); initializeMcpSessions(db);
    const agent = randomUUID(), turn = randomUUID(); db.prepare('INSERT INTO agents VALUES (?)').run(agent); db.prepare("INSERT INTO turns VALUES (?,?,'running')").run(turn,agent);
    const token = mintAgentSession(db,{ agent,turn,scopes:['history:read'],ttlMs:100 },1000);
    assert(verifyBearer(db,`Bearer ${token.token}`,1099)); assert(!verifyBearer(db,`Bearer ${token.token}`,1100)); assert(!verifyBearer(db,token.token,1001));
    revokeAgentSession(db,token.id,1002); assert(!verifyBearer(db,`Bearer ${token.token}`,1003));
    assert(!JSON.stringify(db.prepare('SELECT * FROM mcp_server_tokens').all()).includes(token.token));
    for (const ttlMs of [0,-1,1.5,86_400_001,Infinity]) assert.throws(() => mintAgentSession(db,{ agent,scopes:['agents:read'],ttlMs }));
  } finally { db.close(); }
});

test('failed bearer authentication is rate-limited with uniform responses', async () => {
  const f = await fixture();
  try {
    for (let i=0;i<12;i++) { const response = await f.rpc('A'.repeat(43)); assert.equal(response.status,401); assert.deepEqual(await response.json(),{ error:'MCP authorization failed.' }); if (i>=10) assert.equal(response.headers.get('retry-after'),'60'); }
  } finally { await f.close(); }
});

test('interrupted peer work keeps its original receipt across restart and never replays', async () => {
  const f = await fixture();
  try {
    const peer = await f.peer(), client = await f.client(peer.token);
    f.hold();
    const args = { requestId: randomUUID(), recipient: f.agent.id, text: 'Interrupt this delivery' };
    const receipt = await call(client, 'send_message', args);
    await waitFor(async () => f.calls === 1);
    await f.restart(); f.release();
    const restarted = await f.client(peer.token);
    const status = await call(restarted, 'get_message_status', { requestId: args.requestId });
    assert(!['queued','running'].includes(status.status));
    assert.deepEqual(await call(restarted, 'send_message', args), receipt);
    assert.deepEqual(await call(restarted, 'get_message_status', { requestId: args.requestId }), status);
    assert.equal(f.calls, 1);
    const history = await call(restarted, 'read_history');
    assert.deepEqual(history.messages.map((row: any) => row.id), [receipt.turn]);
  } finally { await f.close(); }
});
