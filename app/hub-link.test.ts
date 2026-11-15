import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startApp } from './server.ts';
import { attachNodeLink, signedNodeMessage, verifiedNodeMessage } from './hub/node-link.ts';
import { initializeHubSchema } from './hub/schema.ts';
import { createHubAuthority, type ParticipationPolicy, type InvocationPolicy } from './hub/project-authority.ts';
import { createHubRouting, type RoutingFrame } from './hub/routing.ts';
import { canonicalJson, ProtocolError, sha256 } from './protocol.ts';
type App = Awaited<ReturnType<typeof startApp>>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => unknown | Promise<unknown>, label = 'condition') {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
        if (await check())
            return;
        await sleep(25);
    }
    assert.fail(`Timed out: ${label}`);
}
async function api(app: App, path: string, body?: unknown, status = 200): Promise<any> { const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', Connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; }
const who = (subject: string) => ({ issuer: 'https://identity.test', subject, verifiedMailboxes: [`${subject}@example.test`] });
async function fixture(t: test.TestContext, providerScript?: (body: any) => unknown | Promise<unknown>, stream = false) {
    const dir = mkdtempSync(join(tmpdir(), 'briefsip-hub-link-')), hubDb = new DatabaseSync(join(dir, 'hub.sqlite'));
    initializeHubSchema(hubDb);
    let clock = Date.now();
    const a = createHubAuthority(hubDb, { domain: 'briefsip.test', mailboxKey: Buffer.alloc(32, 8), now: () => clock });
    const r = createHubRouting(a), signer = generateKeyPairSync('ed25519').privateKey, hubKey = createPublicKey(signer).export({ type: 'spki', format: 'der' }).toString('base64url');
    const alice = a.provisionAccount(who('alice'), true), bob = a.provisionAccount(who('bob'), true), eve = a.provisionAccount(who('eve'), true), project = a.createProject(alice, 'alpha', 'Alpha');
    const ctx = (account: string) => a.resolveProject(project.host, account, project.projectId);
    const invitation = a.invite(ctx(alice), { mailbox: 'bob@example.test', role: 'member', expiresAt: clock + 60000 });
    a.acceptInvite(ctx(bob), invitation.invitationId, invitation.token, who('bob'));
    let transport: ReturnType<typeof attachNodeLink>;
    const server = createServer((req, res) => {
        void transport.handleHttp(req, res).then(handled => {
            if (!handled) {
                res.writeHead(404);
                res.end();
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    transport = attachNodeLink(server, { authority: a, routing: r, origin, signingKey: signer, development: true, now: () => clock });
    let providerCalls = 0;
    const provider = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req)
            raw += chunk;
        providerCalls++;
        const body = JSON.parse(raw), result = providerScript ? await providerScript(body) : `Reply from ${body.model}`;
        if (res.destroyed)
            return;
        if (result && typeof result === 'object' && 'streamText' in result) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: String(result.streamText) }, finish_reason: null }] })}\n\n`);
            await sleep(300);
            res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
            return;
        }
        res.end(JSON.stringify({ choices: [{ finish_reason: typeof result === 'string' ? 'stop' : 'tool_calls', message: typeof result === 'string' ? { content: result } : { tool_calls: [result] } }] }));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const p = provider.address();
    assert(p && typeof p !== 'string');
    const providerPort = p.port;
    const keys = new Map<string, string>(), entry = (service: string, name: string) => ({ getPassword: () => keys.get(`${service}/${name}`) ?? null, setPassword: (value: string) => { keys.set(`${service}/${name}`, value); } }), apps: App[] = [];
    async function node(name: string, account: string) {
        const database = join(dir, `${name}.sqlite`), options = { database, stream, baseURL: `http://127.0.0.1:${providerPort}/v1`, hubLink: { origin, hubSigningPublicKey: hubKey, development: true, entry, reconnectMs: 10, now: () => clock } };
        let app = await startApp(options);
        apps.push(app);
        const agent = await api(app, '/api/agents', { id: randomUUID(), name, model: name, instructions: 'Answer section requests.' }, 201);
        const started = await api(app, '/api/hub-link/enrollment/start', {});
        assert.match(started.humanCode, /^[A-F0-9]{12}$/);
        assert.equal(started.deviceCode, undefined);
        assert.equal(started.privateKey, undefined);
        const inspected = transport.inspectEnrollment(account, started.humanCode);
        assert.equal(inspected.nodeId, started.nodeId);
        assert.equal(inspected.accountId, account);
        transport.approveEnrollment(account, started.humanCode);
        await api(app, '/api/hub-link/enrollment/poll', {});
        await until(() => app.hubLink!.status().connected, 'node online');
        const agentId = a.registerAgent(account, String(started.nodeId), randomUUID(), name);
        return { get app() { return app; }, agent, agentId, nodeId: String(started.nodeId), database, account, options, async restart() { await app.close(); app = await startApp(options); apps.push(app); await until(() => app.hubLink!.status().connected, 'reconnected'); }, async participate(invocation: InvocationPolicy = { mode: 'owner' }) { const policy: ParticipationPolicy = { sectionIds: [project.sectionId], invocation, scopes: ['read', 'invoke'], localPolicyDigest: (await api(app, `/api/hub-link/agents/${agent.id}/policy`)).localPolicyDigest, payerBindingRef: 'local_provider', maxCostMicros: 10000 }; const proposal = a.propose(ctx(account), agentId, policy); a.consent(ctx(alice), proposal.participationId, proposal.revision, proposal.policyDigest, 'project'); await api(app, '/api/hub-link/grants/approve', { projectId: project.projectId, participationId: proposal.participationId, agentId, localAgentId: agent.id, revision: proposal.revision, policy, providerMaxCostMicros: 100 }); await until(() => r.grants({ nodeId: String(started.nodeId), accountId: account, nodeGeneration: 1, connectionGeneration: Number(a.one('SELECT connection_generation FROM nodes WHERE id=?', String(started.nodeId))!.connection_generation) }).some(g => g.participationId === proposal.participationId)); return proposal; } };
    }
    t.after(async () => {
        for (const app of apps)
            await app.close().catch(() => { });
        await transport.close();
        server.closeAllConnections();
        provider.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]);
        hubDb.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const post = (account: string, mentions: string[]) => r.post(ctx(account), { requestId: randomUUID(), sectionId: project.sectionId, text: 'Explain transport', mentions });
    return { dir, a, r, ctx, alice, bob, eve, project, node, post, transport, keys, origin, signer, hubKey, get calls() { return providerCalls; }, advance(ms: number) { clock += ms; }, async done(turnId: string, account = alice) { await until(() => { const state = r.turn(ctx(account), turnId).state; assert(!['failed', 'unknown', 'revoked'].includes(String(state)), `Unexpected hub turn state: ${state}`); return state === 'done'; }, 'hub final'); return r.history(ctx(account), project.sectionId).results.filter(f => f.turnId === turnId); } };
}
test('signed envelopes reject forged payloads, keys and directions', () => {
    const pair = generateKeyPairSync('ed25519'), key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), body = { kind: 'heartbeat' };
    const envelope = signedNodeMessage(body, pair.privateKey, 'hub');
    assert.deepEqual(verifiedNodeMessage(envelope, key, 'hub'), body);
    for (const value of [{ ...envelope, body: { kind: 'turn.request' } }, { ...envelope, signature: 'x' }, { ...envelope, keyId: '0'.repeat(64) }])
        assert.throws(() => verifiedNodeMessage(value, key, 'hub'));
    assert.throws(() => verifiedNodeMessage(envelope, key, 'node'));
});
test('browser-approved enrollment, two real local engines, attribution and local key custody', async (t) => {
    const f = await fixture(t), alice = await f.node('AliceNode', f.alice), bob = await f.node('BobNode', f.bob), pa = await alice.participate(), pb = await bob.participate({ mode: 'all-members' });
    const post = f.post(f.alice, [pa.participationId, pb.participationId]);
    for (const turnId of post.turnIds) {
        const results = await f.done(turnId);
        assert.equal(results[0].kind, 'turn.admitted');
        assert.equal(results.at(-1)!.kind, 'turn.final');
        assert(results.some(result => result.kind === 'turn.effect.receipt'));
        assert.equal(results.at(-1)!.requesterAccountId, f.alice);
        assert.equal(results.at(-1)!.payload.text, results.at(-1)!.nodeId === alice.nodeId ? 'Reply from AliceNode' : 'Reply from BobNode');
        assert.equal(results.at(-1)!.payerAccountId, results.at(-1)!.nodeId === alice.nodeId ? f.alice : f.bob);
        assert.deepEqual(results.map(r => r.sequence), results.map((_, i) => i + 1));
    }
    assert.equal(f.calls, 2);
    for (const filename of readdirSync(f.dir)) {
        const bytes = readFileSync(join(f.dir, filename));
        for (const secret of f.keys.values()) {
            assert(!bytes.includes(Buffer.from(secret)), `key leaked into ${filename}`);
            assert(!bytes.includes(Buffer.from(secret, 'base64url')), `raw key leaked into ${filename}`);
        }
    }
    assert.equal(f.keys.size, 6);
});
test('owner-only default, specific-member and all-member grants; offline refuses without hub execution', async (t) => { const f = await fixture(t), bob = await f.node('Bob', f.bob), p = await bob.participate(); assert.throws(() => f.post(f.alice, [p.participationId]), e => e instanceof ProtocolError && e.code === 'authority_denied'); let post = f.post(f.bob, [p.participationId]); await f.done(post.turnIds[0], f.bob); const specific = await bob.participate({ mode: 'members', accountIds: [f.alice] }); post = f.post(f.alice, [specific.participationId]); await f.done(post.turnIds[0]); const all = await bob.participate({ mode: 'all-members' }); post = f.post(f.alice, [all.participationId]); await f.done(post.turnIds[0]); await bob.app.close(); await until(() => f.a.one('SELECT status FROM nodes WHERE id=?', bob.nodeId)!.status === 'offline'); assert.throws(() => f.post(f.alice, [all.participationId]), e => e instanceof ProtocolError && e.code === 'node_offline'); assert.equal(f.calls, 3); assert.throws(() => f.post(f.eve, []), e => e instanceof ProtocolError); });
test('dangerous tool waits for exact local owner approval; hub/browser roles cannot approve it', async (t) => {
    let toolCalls = 0;
    const f = await fixture(t, body => {
        if (body.messages.some((m: any) => m.role === 'tool'))
            return 'Tool finished';
        toolCalls++;
        return { id: 'write-once', type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'result.txt', text: 'Private file created locally.' }) } };
    }), node = await f.node('Writer', f.alice), p = await node.participate(), post = f.post(f.alice, [p.participationId]);
    await until(() => node.app.hubLink!.approvals().length === 1, 'owner approval wait');
    const prompt = node.app.hubLink!.approvals()[0];
    assert.equal(f.calls, 1);
    const before = await api(node.app, `/api/threads/${(await api(node.app, `/api/agents/${node.agent.id}/threads`))[0]?.id}/turns`);
    assert(!before.some((turn: any) => turn.generatedFiles?.length));
    await api(node.app, '/api/hub-link/approvals', { actionId: prompt.actionId, actionDigest: '0'.repeat(64), approved: true }, 403);
    const denied = await fetch(node.app.origin + '/api/hub-link/approvals', { method: 'POST', headers: { Origin: 'https://alpha.briefsip.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: prompt.actionId, actionDigest: prompt.actionDigest, approved: true }) });
    assert.equal(denied.status, 403);
    await api(node.app, '/api/hub-link/approvals', { actionId: prompt.actionId, actionDigest: prompt.actionDigest, approved: true });
    const results = await f.done(post.turnIds[0]);
    assert(results.some(result => result.kind === 'turn.approval.request' && result.payload.requiredApproverAccountId === f.alice));
    assert(results.some(result => result.kind === 'turn.effect.receipt'));
    assert.equal(results.at(-1)!.payload.text, 'Tool finished');
    assert.equal(toolCalls, 1);
    assert.equal(f.calls, 2);
});
test('duplicate delivery, final ACK loss and restart never execute twice', async (t) => {
    const f = await fixture(t), node = await f.node('Once', f.alice), p = await node.participate();
    const original = WebSocket.prototype.send;
    let duplicated = false, dropped = false;
    WebSocket.prototype.send = function (data: any, ...args: any[]) {
        const wire = typeof data === 'string' ? JSON.parse(data) : undefined;
        if (wire?.body?.kind === 'turn.request' && !duplicated) {
            duplicated = true;
            Reflect.apply(original, this, [data, ...args]);
        }
        if (wire?.body?.kind === 'response' && wire.body.result?.accepted && wire.body.result.sequence >= 3 && !dropped) {
            dropped = true;
            this.close(4409, 'Injected ACK loss');
            return;
        }
        return Reflect.apply(original, this, [data, ...args]);
    };
    t.after(() => { WebSocket.prototype.send = original; });
    const post = f.post(f.alice, [p.participationId]);
    await until(() => f.calls === 1);
    await until(() => dropped, 'result ACK dropped');
    await until(() => f.a.one('SELECT connection_generation FROM nodes WHERE id=?', node.nodeId)!.connection_generation !== 1, 'generation fenced');
    await node.restart();
    await sleep(400);
    assert.equal(f.calls, 1);
    assert(duplicated);
    const turn = f.r.turn(f.ctx(f.alice), post.turnIds[0]);
    assert(['done', 'unknown'].includes(String(turn.state)));
});
test('revocation mid-stream stops local work before another effect and does not execute offline', async (t) => { let release: (text: string) => void = () => { }; const f = await fixture(t, () => new Promise<string>(resolve => { release = resolve; })), node = await f.node('Held', f.alice), p = await node.participate(), post = f.post(f.alice, [p.participationId]); await until(() => f.calls === 1); f.a.withdraw(f.ctx(f.alice), p.participationId); f.transport.flush(); await until(async () => { const status = await api(node.app, '/api/hub-link'); return !status.connected || f.r.turn(f.ctx(f.alice), post.turnIds[0]).state === 'unknown'; }); release('Late answer'); await sleep(300); assert.equal(f.calls, 1); assert.equal(f.r.turn(f.ctx(f.alice), post.turnIds[0]).state, 'unknown'); assert.throws(() => f.post(f.alice, [p.participationId]), e => e instanceof ProtocolError); });
test('foreign project and forged signed hub frames never reach local engine', async (t) => {
    const f = await fixture(t), node = await f.node('Isolated', f.alice), p = await node.participate();
    const original = WebSocket.prototype.send;
    let injected = false;
    WebSocket.prototype.send = function (data: any, ...args: any[]) {
        const wire = typeof data === 'string' ? JSON.parse(data) : undefined;
        if (wire?.body?.kind === 'turn.request' && !injected) {
            injected = true;
            const foreign = { ...wire.body, projectId: randomUUID() };
            return Reflect.apply(original, this, [canonicalJson(signedNodeMessage(foreign, f.signer, 'hub')), ...args]);
        }
        return Reflect.apply(original, this, [data, ...args]);
    };
    t.after(() => { WebSocket.prototype.send = original; });
    const post = f.post(f.alice, [p.participationId]);
    await until(() => injected);
    await until(() => f.r.turn(f.ctx(f.alice), post.turnIds[0]).state === 'unknown');
    assert.equal(f.calls, 0);
});
test('local owner endpoints require exact Origin and refuse bearer callers; unenrolled app stays idle', async (t) => { const f = await fixture(t), node = await f.node('Boundary', f.alice); const r = await fetch(node.app.origin + '/api/hub-link', { headers: { Origin: 'https://foreign.test', Connection: 'close' } }); assert.equal(r.status, 403); const bearer = await fetch(node.app.origin + '/api/hub-link', { headers: { Origin: node.app.origin, Authorization: 'Bearer rejected', Connection: 'close' } }); assert.equal(bearer.status, 403); assert.equal(f.calls, 0); await api(node.app, '/api/hub-link/revoke', {}); await until(() => f.a.one('SELECT status FROM nodes WHERE id=?', node.nodeId)!.status === 'revoked'); assert.equal(node.app.hubLink!.status().disabled, true); });
async function childApp(options: Record<string, unknown>, keys: Map<string, string>) {
    const code = `import {startApp} from ${JSON.stringify(new URL('./server.ts', import.meta.url).href)};process.on('message',async message=>{try{const keys=new Map(message.keys);const app=await startApp({...message.options,hubLink:{...message.options.hubLink,entry:(service,name)=>({getPassword:()=>keys.get(service+'/'+name)??null,setPassword:value=>keys.set(service+'/'+name,value)})}});process.send({kind:'ready',origin:app.origin});}catch{process.send({kind:'failed'});process.exitCode=1;}});`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.send({ options, keys: [...keys] });
    const [message] = await ready;
    assert.equal(message.kind, 'ready');
    return child;
}
async function killChild(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
}
test('SIGKILL after dispatch and before result ACK keeps durable uncertainty without replay', async (t) => { let release: () => void = () => { }; const f = await fixture(t, () => new Promise<string>(resolve => { release = () => resolve('Effect already happened'); })), node = await f.node('Crash', f.alice), p = await node.participate(); await node.app.close(); const { entry: unused, now: unusedClock, ...linkOptions } = node.options.hubLink; const options = { ...node.options, hubLink: linkOptions }; let child = await childApp(options, f.keys); t.after(async () => { await killChild(child); }); await until(() => f.a.one('SELECT status FROM nodes WHERE id=?', node.nodeId)!.status === 'ready'); const post = f.post(f.alice, [p.participationId]); await until(() => f.calls === 1, 'provider dispatched'); await killChild(child); release(); await until(() => f.r.turn(f.ctx(f.alice), post.turnIds[0]).state === 'unknown'); child = await childApp(options, f.keys); await until(() => f.a.one('SELECT status FROM nodes WHERE id=?', node.nodeId)!.status === 'ready'); await sleep(500); assert.equal(f.calls, 1); assert.equal(f.r.turn(f.ctx(f.alice), post.turnIds[0]).state, 'unknown'); });
test('provider partial snapshots stream over real WebSockets before final', async (t) => { const f = await fixture(t, () => ({ streamText: 'Streamed local answer' }), true), node = await f.node('Stream', f.alice), p = await node.participate(), post = f.post(f.alice, [p.participationId]); const results = await f.done(post.turnIds[0]); assert(results.some(frame => frame.kind === 'turn.partial' && frame.payload.text === 'Streamed local answer')); assert.equal(results.at(-1)!.kind, 'turn.final'); assert.equal(results.at(-1)!.payload.text, 'Streamed local answer'); assert.equal(f.calls, 1); });
test('browser code alone cannot redeem enrollment; node upgrade rejects browser credentials', async (t) => {
    const f = await fixture(t);
    for (const path of ['/api/nodes/enrollment/poll', '/api/nodes/session']) {
        const response = await fetch(f.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: 'BADCODE' }) });
        assert([400, 403].includes(response.status));
    }
    const ws = new WebSocket(f.origin.replace('http', 'ws') + '/node', { headers: { Origin: f.origin, Cookie: 'session=forbidden' } });
    const error = await once(ws, 'error');
    assert(error[0] instanceof Error);
});
test('reconnect fences old generation; session expiry renews with node key and never replays completed work', async (t) => { const f = await fixture(t), node = await f.node('Renew', f.alice), p = await node.participate(), post = f.post(f.alice, [p.participationId]); await f.done(post.turnIds[0]); const before = Number(f.a.one('SELECT connection_generation FROM nodes WHERE id=?', node.nodeId)!.connection_generation); f.advance(900001); f.transport.flush(); await until(() => Number(f.a.one('SELECT connection_generation FROM nodes WHERE id=?', node.nodeId)!.connection_generation) > before, 'signed renewal'); assert.equal(f.calls, 1); assert.equal(f.r.turn(f.ctx(f.alice), post.turnIds[0]).state, 'done'); });
test('local provider spend ceiling refuses next request before dispatch', async (t) => {
    const f = await fixture(t, body => body.messages.some((m: any) => m.role === 'tool') ? 'Second paid call' : ({ id: 'budget-tool', type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'budget.txt', text: 'One local file' }) } })), node = await f.node('Budget', f.alice);
    const policy: ParticipationPolicy = { sectionIds: [f.project.sectionId], invocation: { mode: 'owner' }, scopes: ['read', 'invoke'], localPolicyDigest: (await api(node.app, `/api/hub-link/agents/${node.agent.id}/policy`)).localPolicyDigest, payerBindingRef: 'local_provider', maxCostMicros: 100 };
    const p = f.a.propose(f.ctx(f.alice), node.agentId, policy);
    f.a.consent(f.ctx(f.alice), p.participationId, p.revision, p.policyDigest, 'project');
    await api(node.app, '/api/hub-link/grants/approve', { projectId: f.project.projectId, participationId: p.participationId, agentId: node.agentId, localAgentId: node.agent.id, revision: p.revision, policy, providerMaxCostMicros: 100 });
    const post = f.post(f.alice, [p.participationId]);
    await until(() => node.app.hubLink!.approvals().length === 1);
    const prompt = node.app.hubLink!.approvals()[0];
    await api(node.app, '/api/hub-link/approvals', { actionId: prompt.actionId, actionDigest: prompt.actionDigest, approved: true });
    await until(() => f.r.turn(f.ctx(f.alice), post.turnIds[0]).state === 'failed');
    assert.equal(f.calls, 1);
});
test('lost enrollment redemption response recovers with signed node proof', async (t) => {
    const f = await fixture(t), original = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = async (input, init) => { const response = await original(input, init); if (String(input) === f.origin + '/api/nodes/enrollment/poll' && !dropped) {
        dropped = true;
        await response.arrayBuffer();
        throw new Error('Injected response loss');
    } return response; };
    t.after(() => { globalThis.fetch = original; });
    const node = await f.node('RecoveredEnrollment', f.alice);
    assert(dropped);
    assert.equal(node.app.hubLink!.status().enrolled, true);
    assert.equal(f.calls, 0);
});
test('changed local agent policy rejects an existing hub grant before provider dispatch', async (t) => {
    const f = await fixture(t), node = await f.node('Changed', f.alice), p = await node.participate();
    await api(node.app, `/api/agents/${node.agent.id}/edit`, { id: randomUUID(), revision: node.agent.revision, name: 'Changed config', model: 'Changed', instructions: 'Updated policy' });
    const post = f.post(f.alice, [p.participationId]);
    await until(() => f.r.turn(f.ctx(f.alice), post.turnIds[0]).state === 'unknown');
    assert.equal(f.calls, 0);
});

test('revoking alpha preserves simultaneous beta work on the same node',async t=>{
  const held:((value:string)=>void)[]=[];
  const f=await fixture(t,()=>new Promise<string>(resolve=>held.push(resolve))),node=await f.node('TwoProjects',f.alice),alpha=await node.participate();
  const beta=f.a.createProject(f.alice,'beta','Beta'),betaCtx=f.a.resolveProject(beta.host,f.alice,beta.projectId);
  const policy:ParticipationPolicy={sectionIds:[beta.sectionId],invocation:{mode:'owner'},scopes:['read','invoke'],localPolicyDigest:(await api(node.app,`/api/hub-link/agents/${node.agent.id}/policy`)).localPolicyDigest,payerBindingRef:'local_provider',maxCostMicros:10_000};
  const bp=f.a.propose(betaCtx,node.agentId,policy);f.a.consent(betaCtx,bp.participationId,bp.revision,bp.policyDigest,'project');
  await api(node.app,'/api/hub-link/grants/approve',{projectId:beta.projectId,participationId:bp.participationId,agentId:node.agentId,localAgentId:node.agent.id,revision:bp.revision,policy,providerMaxCostMicros:100});
  const a=f.post(f.alice,[alpha.participationId]);await until(()=>held.length===1);
  const b=f.r.post(betaCtx,{requestId:randomUUID(),sectionId:beta.sectionId,text:'Beta work',mentions:[bp.participationId]});await until(()=>held.length===2);
  const generation=f.a.one('SELECT connection_generation FROM nodes WHERE id=?',node.nodeId)!.connection_generation;
  f.a.withdraw(f.ctx(f.alice),alpha.participationId);f.transport.flush();await until(()=>f.r.turn(f.ctx(f.alice),a.turnIds[0]).state==='unknown');
  held[0]('Late alpha');held[1]('Beta stays connected');await until(()=>f.r.turn(betaCtx,b.turnIds[0]).state==='done');
  assert.equal(f.a.one('SELECT connection_generation FROM nodes WHERE id=?',node.nodeId)!.connection_generation,generation);assert.equal(node.app.hubLink!.status().connected,true);assert.equal(f.calls,2);
});
