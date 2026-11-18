import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startRustServer } from './rust-test-server.ts';

test('Rust forks preserve bounded persisted transcripts and restart receipts', { timeout: 20000 }, async () => {
  const { boundedTranscript } = await import('./dispatch.ts');
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-fork-')), database = join(root, 'db.sqlite');
  let app: Awaited<ReturnType<typeof startRustServer>> | undefined;
  try {
    const initial = await startRustServer({ database }); await initial.close();
    const db = new DatabaseSync(database), agent = randomUUID(), cutoff = randomUUID();
    db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES(?,'Fork fixture','fixture','Help')").run(agent);
    for (let i = 0; i < 42; i++) db.prepare("INSERT INTO turns(id,agent,text,reply,status,created) VALUES(?,?,?,?,'done','2026-01-02T03:04:05.000Z')").run(i === 41 ? cutoff : randomUUID(), agent, 'Question ' + i + 'x'.repeat(17000), 'Answer ' + i + 'y'.repeat(25000));
    const seq = Number(db.prepare('SELECT seq FROM turns WHERE id=?').get(cutoff)!.seq), scope = { agent, channel: null, thread: null };
    db.prepare('INSERT INTO compactions VALUES(?,?,?,?)').run(`agents:${agent}`, randomUUID(), seq - 1, 'Prior summary');
    const expected = JSON.parse(boundedTranscript(db, scope, seq)); db.close();
    app = await startRustServer({ database });
    const path = `/api/agents/${agent}/turns/${cutoff}/fork`, command = { id: randomUUID() };
    const fork = async () => { const res = await fetch(app!.origin + path, { method: 'POST', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(command) }); assert.equal(res.status, 200); return res.json(); };
    const created = await fork();
    assert.deepEqual(await (await fetch(app.origin + `/api/threads/${created.id}/fork-context`)).json(), expected);
    assert.deepEqual(await fork(), created);
    await app.close(); app = await startRustServer({ database }); assert.deepEqual(await fork(), created);
    assert.equal((await fetch(app.origin + `/api/threads/${created.id}/fork-context`, { headers: { Authorization: 'Bearer fixture' } })).status, 403);
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Rust data reads preserve seeded history and local CRUD receipts across restart', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-data-')), database = join(root, 'db.sqlite');
  let initial: Awaited<ReturnType<typeof startRustServer>> | undefined;
  let rust: Awaited<ReturnType<typeof startRustServer>> | undefined;
  try {
    initial = await startRustServer({ database });
    const agent = randomUUID(), turn = randomUUID();
    await initial.close(); initial = undefined;
    const db = new DatabaseSync(database);
    db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES(?,?,?,?)').run(agent, 'Saved agent', 'fixture', 'Help');
    db.prepare("INSERT INTO turns(id,agent,text,status,reply,created) VALUES(?,?,?,'done',?,?)").run(turn, agent, 'Saved question', 'Saved answer', '2026-01-02T03:04:05.000Z');
    const call = db.prepare("INSERT INTO provider_calls(turn,agent,model,origin,purpose,status,created) VALUES(?,?,?,'test','completion','received',?)").run(turn, agent, 'fixture', '2026-01-02T03:04:05.000Z').lastInsertRowid;
    db.prepare('INSERT INTO provider_streams VALUES(?,?)').run(call, 'Saved answer');
    db.prepare("INSERT INTO provider_stream_segments VALUES(?,0,'text-0','text',?,'',1,3)").run(call, 'Saved answer');
    db.prepare('INSERT INTO harness_approvals(id,turn,agent,runtime,workspace,kind,description,input,state) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), turn, agent, 'codex', '/fixture', 'command', 'Saved approval', '{"command":"pwd"}', 'decided');
    db.prepare('INSERT INTO composio_calls VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(turn, 'saved-tool', agent, JSON.stringify({ function: { name: 'fixture', arguments: '{"query":"saved"}' } }), JSON.stringify({ toolkit: 'fixture', name: 'Lookup', slug: 'LOOKUP', account: 'saved' }), 'done', 'approved', '{}', 0, 0, 1);
    const thread = randomUUID(), delivery = randomUUID(), request = randomUUID();
    db.prepare('INSERT INTO threads(id,agent,name) VALUES(?,?,?)').run(thread, agent, 'Saved delivery');
    db.prepare("INSERT INTO turns(id,agent,thread,text,status,reply,created) VALUES(?,?,?,?,'done',?,?)").run(delivery, agent, thread, 'Teammate task', 'Teammate result', '2026-01-02T03:04:06.000Z');
    db.prepare('INSERT INTO agent_requests VALUES(?,?,?,1,1)').run(request, turn, 'saved-request');
    db.prepare('INSERT INTO agent_deliveries VALUES(?,?)').run(request, delivery);
    const channel = randomUUID(), room = randomUUID();
    db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES(?,'Saved room','Help',?)").run(channel, agent);
    db.prepare('INSERT INTO channel_members VALUES(?,?)').run(channel, agent);
    db.prepare("INSERT INTO turns(id,agent,channel,text,status,created) VALUES(?,?,?,'Room question','interrupted','2026-01-02T03:04:07.000Z')").run(room, agent, channel);
    db.prepare('INSERT INTO room_discussions(root,members,lead,mentioned) VALUES(?,?,?,0)').run(room, JSON.stringify([agent]), agent);
    db.prepare('INSERT INTO room_turns(turn,root,round,speaker) VALUES(?,?,0,?)').run(room, room, agent);
    const roomCall = db.prepare("INSERT INTO provider_calls(turn,agent,model,origin,purpose,status,created) VALUES(?,?,?,'test','completion','interrupted',?)").run(room, agent, 'fixture', '2026-01-02T03:04:07.000Z').lastInsertRowid;
    db.prepare('INSERT INTO provider_streams VALUES(?,?)').run(roomCall, '“[SILENT]”');
    db.prepare("INSERT INTO provider_stream_segments VALUES(?,0,'text-0','text',?,'',0,1)").run(roomCall, '“[SILENT]”');
    db.close();
    const paths = [`/api/agents/${agent}/turns`, '/api/usage', '/api/conversations/settings', `/api/agents/${agent}/threads`, '/api/channels', `/api/channels/${channel}/turns`, `/api/agents/${agent}/panel`, `/api/threads/${thread}/panel/files`];
    initial = await startRustServer({ database });
    const expected = [];
    for (const path of paths) { const res: Response = await fetch(initial.origin + path); assert.equal(res.status, 200); expected.push(await res.json()); }
    await initial.close(); initial = undefined;
      rust = await startRustServer({ database });
    for (let i = 0; i < paths.length; i++) { const res: Response = await fetch(rust.origin + paths[i]); assert.equal(res.status, 200, paths[i] + ' ' + await (res.status === 200 ? Promise.resolve('') : res.text())); assert.deepEqual(await res.json(), expected[i], paths[i]); }
    const post = async (path: string, body: unknown, status = 200) => { const res: Response = await fetch(rust!.origin + path, { method: 'POST', headers: { Origin: rust!.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await res.json(); assert.equal(res.status, status, JSON.stringify(result)); return result; };
    const command = { id: randomUUID(), name: 'Side' }, path = `/api/agents/${agent}/threads`;
    const created = await post(path, command);
    assert.deepEqual(await post(path, command), created);
    await post(path, { ...command, name: 'Conflict' }, 409);
    const deletion = { id: randomUUID(), revision: 1 };
    assert.equal((await post(`/api/threads/${created.id}/delete`, deletion)).deleted, 1);
    assert.equal((await post(`/api/threads/${created.id}/delete`, deletion)).deleted, 1);
  } finally { await initial?.close(); await rust?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Rust deletion rolls back FK closure, preserves room history and retries external cleanup', { timeout: 20000 }, async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-delete-')), database = join(root, 'db.sqlite');
  let app: Awaited<ReturnType<typeof startRustServer>> | undefined;
  try {
    const initial = await startRustServer({ database }); await initial.close();
    const db = new DatabaseSync(database), agent = randomUUID(), other = randomUUID(), direct = randomUUID(), room = randomUUID(), channel = randomUUID();
    const desktop = join(root, 'agent-desktops', agent), workspace = join(root, 'workspace');
    mkdirSync(desktop, { recursive: true }); writeFileSync(join(desktop, 'saved'), 'saved'); mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture', '--allow-empty']);
    const hash = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), ref = `refs/briefsip/checkpoints/${direct}`;
    execFileSync('git', ['-C', workspace, 'update-ref', ref, hash]);
    for (const id of [agent, other]) db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES(?,'Fixture','fixture','Help')").run(id);
    db.prepare("INSERT INTO channels(id,name,instructions,lead) VALUES(?,'Room','Help',?)").run(channel, agent);
    db.prepare('INSERT INTO channel_members VALUES(?,?)').run(channel, agent);
    db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES(?,?,'Private','done','fixture')").run(direct, agent);
    db.prepare("INSERT INTO turns(id,agent,channel,text,reply,status,created) VALUES(?,?,?,'Shared','Saved reply','done','fixture')").run(room, agent, channel);
    db.prepare('INSERT INTO room_discussions(root,members,lead,mentioned) VALUES(?,?,?,0)').run(room, JSON.stringify([agent, other]), agent);
    db.prepare('INSERT INTO room_turns(turn,root,round,speaker) VALUES(?,?,0,?)').run(room, room, agent);
    db.prepare("INSERT INTO room_messages(root,turn,kind,agent,text) VALUES(?,?,'reply',?,'Saved reply')").run(room, room, agent);
    db.prepare("INSERT INTO workspace_checkpoints VALUES(?,?,?,?,?,'done',0)").run(direct, agent, workspace, ref, hash);
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'fixture'); END;"); db.close();
    app = await startRustServer({ database });
    const command = { id: randomUUID() }, path = `/api/agents/${agent}/delete`;
    const remove = () => fetch(app!.origin + path, { method: 'POST', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal((await remove()).status, 500); assert(existsSync(desktop));
    const retry = new DatabaseSync(database);
    assert(retry.prepare('SELECT 1 FROM agents WHERE id=?').get(agent)); assert(retry.prepare('SELECT 1 FROM turns WHERE id=?').get(direct));
    assert.equal(retry.prepare('SELECT agent FROM turns WHERE id=?').get(room)!.agent, agent);
    retry.exec('DROP TRIGGER fail_delete'); retry.close();
    assert.equal((await remove()).status, 200); assert(!existsSync(desktop));
    assert.equal((await remove()).status, 200);
    assert.equal(execFileSync('git', ['-C', workspace, 'for-each-ref', ref], { encoding: 'utf8' }), '');
    const history = await (await fetch(app.origin + `/api/channels/${channel}/turns`)).json();
    assert.equal(history[0].agent, null); assert.equal(history[0].reply, 'Saved reply'); assert.equal(history[0].agent_name, 'Deleted agent');
    const saved = new DatabaseSync(database); assert.deepEqual(saved.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(saved.prepare('SELECT count(*) AS n FROM agent_delete_checkpoints').get()!.n, 0); saved.close();
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Rust canonical projects preserve ownership, CAS and durable command receipts', { timeout: 20000 }, async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { installFrozenNodeSchema } = await import('./test-support/canonical-schema.ts');
  const { createProjectAccess } = await import('./project-access.ts');
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-projects-')), database = join(root, 'db.sqlite');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://briefsip.example', development: true, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const account = randomUUID(), project = randomUUID(), now = Math.floor(Date.now() / 1000);
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: auth.issuer, sub: 'user_fixture', sid: 'sess_fixture', azp: auth.origin, exp: now + 60, nbf: now - 1, iat: now - 1 })).toString('base64url')}`;
  const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  const reference = new DatabaseSync(':memory:'), disk = new DatabaseSync(database);
  for (const db of [reference, disk]) { installFrozenNodeSchema(db); db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(account, auth.issuer, 'user_fixture', Date.now()); }
  disk.close();
  const actor = { accountId: account, issuer: auth.issuer, subject: 'user_fixture', sessionId: 'sess_fixture', expiresAt: Date.now() + 60000 };
  const { retainedToolNames } = await import('./test-bridge.ts');
  const access = createProjectAccess(reference, { requireCurrent: value => value, verifiedMailboxes: async () => [] }, () => { throw new Error('No mail in project fixture'); }, retainedToolNames);
  const app = await startRustServer({ database, auth });
  const send = async (path: string, method = 'GET', body?: { requestId: string; [key: string]: unknown }) => { const res: Response = await fetch(app.origin + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': body?.requestId ?? randomUUID() }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
  try {
    assert.equal((await send('/api/agents')).status, 404);
    const command = { requestId: randomUUID(), id: project, name: ' Shared project ' }, expected = access.createProject(actor, command);
    const created = await send('/api/projects', 'POST', command); assert.equal(created.status, 201);
    assert.deepEqual(created.body.data, expected.data); assert.deepEqual({ ...created.body.receipt, committedAt: 0 }, { ...expected.receipt, committedAt: 0 });
    assert.deepEqual((await send('/api/projects', 'POST', command)).body, created.body);
    assert.deepEqual((await send('/api/projects')).body.data, JSON.parse(JSON.stringify(access.listProjects(actor))));
    assert.deepEqual((await send(`/api/projects/${project}`)).body.data, JSON.parse(JSON.stringify(access.requireProjectMember(actor, project))));
    const home = randomUUID(), installation = randomUUID(), binding = randomUUID(), fixture = new DatabaseSync(database);
    for (const db of [reference, fixture]) {
      db.prepare("INSERT INTO installations(id,account,signing_public_key,signing_thumbprint,revision,created) VALUES(?,?,'fixture',?,1,0)").run(installation, account, installation);
      db.prepare("INSERT INTO devices(id,installation,account,signing_public_key,encryption_public_key,signing_thumbprint,encryption_thumbprint,descriptor_json,generation,connection_generation,status,zone,zone_revision,capabilities_json,revision) VALUES(?,?,?,'fixture','fixture','fixture','fixture','{}',1,0,'offline','UTC',1,'[\"execution\"]',1)").run(home, installation, account);
      db.prepare("INSERT INTO provider_bindings VALUES(?,?,?,'openai-compatible','fixture','Fixture','ready',1)").run(binding, home, account);
    }
    fixture.close();
    const aid = randomUUID(), creation = { requestId: aid, id: aid, name: ' Agent ', role: ' Helper ', model: 'fixture', backupModel: '', instructions: 'Help', threadLimit: 2, projectId: project, homeDeviceId: home, expectedProjectRevision: 1, expectedHomeDeviceRevision: 1, providerBinding: null, setup: false };
    const expectedAgent = await access.createAgent(actor, creation), createdAgent = await send('/api/agents', 'POST', creation);
    assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent));
    assert.deepEqual(createdAgent.body.data, expectedAgent.data);
    assert.equal(createdAgent.body.receipt.payloadDigest, expectedAgent.receipt.payloadDigest);
    assert.deepEqual((await send('/api/agents', 'POST', creation)).body, createdAgent.body);
    const setupId = randomUUID(), setup = { ...creation, requestId: setupId, id: setupId, providerBinding: { bindingId: binding, expectedRevision: 1 }, setup: true };
    const expectedSetup = await access.createAgent(actor, setup), createdSetup = await send('/api/agents', 'POST', setup);
    assert.equal(createdSetup.status, 201, JSON.stringify(createdSetup)); assert.deepEqual(createdSetup.body.data, expectedSetup.data);
    const saved = new DatabaseSync(database);
    const taskFields = 'id,logical_turn,project,agent,initiator_account,home_device,assignment_revision,capability_revision,capability_digest,capability_snapshot_json,provider_binding_id,provider_binding_revision,provider_binding_owner,state,payload_digest,payload_json,revision';
    assert.deepEqual({ ...saved.prepare(`SELECT ${taskFields} FROM tasks WHERE id=?`).get(setupId) }, { ...reference.prepare(`SELECT ${taskFields} FROM tasks WHERE id=?`).get(setupId) });
    saved.close();
    const second = randomUUID(), projectCommand = { requestId: randomUUID(), id: second, name: 'Second' };
    access.createProject(actor, projectCommand); assert.equal((await send('/api/projects', 'POST', projectCommand)).status, 201);
    const participation = { requestId: randomUUID(), expectedProjectRevision: 1, expectedAgentRevision: 1, expectedAuthorityRevision: 1, expectedParticipationRevision: 0, rules: 'Project rules\nSecond line', capabilities: { v: 1, tools: ['read_history'], resources: [] } };
    const expectedParticipation = access.agentParticipation(actor, second, aid, participation), actualParticipation = await send(`/api/projects/${second}/agents/${aid}`, 'PUT', participation);
    assert.equal(actualParticipation.status, 201, JSON.stringify(actualParticipation)); assert.deepEqual(actualParticipation.body.data, expectedParticipation.data);
    assert.equal(actualParticipation.body.receipt.payloadDigest, expectedParticipation.receipt.payloadDigest);
    for (const kind of ['rules', 'capabilities'] as const) {
      const change = kind === 'rules' ? { requestId: randomUUID(), expectedParticipationRevision: 1, rules: 'Changed rules' } : { requestId: randomUUID(), expectedRevision: 2, capabilities: { v: 1, tools: ['read_history', 'ask_user'], resources: [] } };
      const expectedChange = kind === 'rules' ? access.editAgentRules(actor, second, aid, change) : access.editAgentCapabilities(actor, second, aid, change);
      const changed = await send(`/api/projects/${second}/agents/${aid}/${kind}`, 'PUT', change);
      assert.equal(changed.status, 200, JSON.stringify(changed)); assert.deepEqual(changed.body.data, expectedChange.data); assert.equal(changed.body.receipt.payloadDigest, expectedChange.receipt.payloadDigest);
    }
    const collaborator = randomUUID(), current = new DatabaseSync(database);
    for (const db of [reference, current]) { db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(collaborator, auth.issuer, 'user_member', Date.now()); db.prepare("INSERT INTO project_members VALUES(?,?,'member',1,0)").run(project, collaborator); }
    current.close();
    const revocation = { requestId: randomUUID(), expectedRevision: 1, deleted: true }, expectedRevocation = access.editMember(actor, project, collaborator, revocation);
    const revoked = await send(`/api/projects/${project}/members/${collaborator}`, 'PATCH', revocation);
    assert.equal(revoked.status, 200); assert.deepEqual(revoked.body.data, expectedRevocation.data);
    assert.deepEqual((await send(`/api/projects/${project}/members/${collaborator}`, 'PATCH', revocation)).body, revoked.body);
    const edit = { requestId: randomUUID(), expectedRevision: 1, name: 'Renamed' }, expectedEdit = access.editProject(actor, project, edit);
    assert.deepEqual((await send(`/api/projects/${project}`, 'PATCH', edit)).body.data, expectedEdit.data);
    assert.equal((await send(`/api/projects/${project}`, 'PATCH', { ...edit, requestId: randomUUID() })).body.error.code, 'stale_revision');
    assert.equal((await send('/api/projects', 'POST', { ...command, name: 'Changed' })).body.error.code, 'payload_conflict');
    await app.close();
    const reopened = await startRustServer({ database, auth });
    try { const res = await fetch(reopened.origin + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': command.requestId }, body: JSON.stringify(command) }); assert.equal(res.status, 200); assert.deepEqual(await res.json(), created.body); }
    finally { await reopened.close(); }
  } finally { await app.close(); reference.close(); rmSync(root, { recursive: true, force: true }); }
});
