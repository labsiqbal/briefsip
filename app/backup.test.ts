import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, linkSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { canonicalServerLock, restoreWorkspace, workspaceSnapshot } from './backup.ts';
import { ProtocolError } from './protocol.ts';
import { initializeCanonicalSchema } from './schema.ts';
import { createApplicationSync } from './application-sync.ts';
import { createProjectAccess } from './project-access.ts';
import type { HumanActor } from './auth.ts';

test('canonical server guard fences aliases and processes, releases on SIGKILL and rejects unsafe files', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-server-lock-')),database=join(dir,'canonical.sqlite'),guardPath=database+'.server-lock.sqlite';
  new DatabaseSync(database).close();
  const source=`import { canonicalServerLock } from ${JSON.stringify(new URL('./backup.ts',import.meta.url).href)}; const guard=canonicalServerLock(process.argv[1]); process.on('message',()=>{guard.close();process.disconnect();}); process.send('locked');`;
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',source,database],{stdio:['ignore','ignore','pipe','ipc']});
  let guard:DatabaseSync|undefined;
  try {
    assert.deepEqual(await once(child,'message',{signal:AbortSignal.timeout(10000)}),['locked',undefined]);
    const busy=(error:unknown)=>error instanceof ProtocolError&&error.code==='canonical_server_busy';
    assert.throws(()=>canonicalServerLock(database),busy);
    const alias=join(dir,'alias.sqlite');symlinkSync(database,alias);assert.throws(()=>canonicalServerLock(alias),busy);
    // A failed same-process acquisition must not release the other process's lock.
    assert.throws(()=>canonicalServerLock(database),busy);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    guard=canonicalServerLock(alias);assert.equal(statSync(guardPath).mode&0o777,0o600);
    assert.throws(()=>canonicalServerLock(database),busy);assert.throws(()=>canonicalServerLock(alias),busy);
    const probeSource=`import { canonicalServerLock } from ${JSON.stringify(new URL('./backup.ts',import.meta.url).href)}; try { const guard=canonicalServerLock(process.argv[1]);guard.close();process.send('unexpected'); } catch(error) {process.send(error.code);} process.disconnect();`;
    const probe=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',probeSource,database],{stdio:['ignore','ignore','ignore','ipc']}),probeExited=once(probe,'exit');
    try { assert.deepEqual(await once(probe,'message',{signal:AbortSignal.timeout(10000)}),['canonical_server_busy',undefined]); }
    finally { if(probe.exitCode===null&&probe.signalCode===null)probe.kill('SIGKILL');await probeExited; }
    guard.close();guard=undefined;
    const retained=statSync(guardPath);guard=canonicalServerLock(database);assert.equal(statSync(guardPath).ino,retained.ino);guard.close();guard=undefined;
    const hard=join(dir,'hard.sqlite');linkSync(database,hard);assert.throws(()=>canonicalServerLock(hard),/hard link/);rmSync(hard);
    const initial=readFileSync(guardPath);rmSync(guardPath);symlinkSync(join(dir,'missing'),guardPath);assert.throws(()=>canonicalServerLock(database),/privat/);rmSync(guardPath);
    writeFileSync(guardPath,initial,{mode:0o644});assert.throws(()=>canonicalServerLock(database),/privat/);chmodSync(guardPath,0o600);
    const linked=join(dir,'guard-link');linkSync(guardPath,linked);assert.throws(()=>canonicalServerLock(database),/privat/);rmSync(linked);
    writeFileSync(guardPath,'not sqlite');assert.throws(()=>canonicalServerLock(database));assert.equal(readFileSync(guardPath,'utf8'),'not sqlite');writeFileSync(guardPath,initial);
    guard=canonicalServerLock(database);
  } finally {
    guard?.close();
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    rmSync(dir,{recursive:true,force:true});
  }
});

test('v4 backup retains sync floors, monotonic heads, tombstones and receipts while restored authority stays fenced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-sync-backup-')), db = new DatabaseSync(join(dir, 'source.sqlite'));
  initializeCanonicalSchema(db);
  const owner: HumanActor = { accountId: randomUUID(), issuer: 'https://fixture.example', subject: 'owner', sessionId: 'session_owner', expiresAt: Date.now() + 60000 };
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(owner.accountId, owner.issuer, owner.subject, Date.now());
  let now = Date.now();
  const auth = { requireCurrent: (actor: HumanActor) => actor, verifiedMailboxes: async () => [] };
  const sync = createApplicationSync(db, auth, { key: () => Buffer.alloc(32, 7), now: () => now });
  const access = createProjectAccess(db, auth, () => { throw new Error('No mail'); }, [], sync), project = randomUUID();
  let backup: Awaited<ReturnType<typeof workspaceSnapshot>> | undefined;
  try {
    access.createProject(owner, { requestId: randomUUID(), id: project, name: 'Retained tombstone' });
    db.prepare("INSERT INTO record_scopes VALUES ('projects',?,?,?,'owner','project',?)").run(JSON.stringify([project]), owner.accountId, project, project);
    db.prepare("UPDATE record_scopes SET visibility='project' WHERE project=?").run(project);
    access.editProject(owner, project, { requestId: randomUUID(), expectedRevision: 1, deleted: true });
    now += 90 * 86400_000 + 1; assert.equal(sync.prune().removed, 2);
    const retained = Object.fromEntries(['sync_heads','retention_floors','sync_scope_revisions','receipts','projects'].map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
    backup = await workspaceSnapshot(db, owner.accountId);
    const destination = join(dir, 'restored.sqlite'); restoreWorkspace(backup.file, destination, { canonicalOnly: true });
    const restored = new DatabaseSync(destination);
    try {
      for (const [table, rows] of Object.entries(retained)) assert.deepEqual(restored.prepare('SELECT * FROM ' + table).all(), rows);
      const recoverySync = createApplicationSync(restored, auth, { key: () => Buffer.alloc(32, 7) });
      try { assert.throws(() => recoverySync.read(owner, { projectId: project }), error => error instanceof ProtocolError && error.code === 'authority_unavailable'); } finally { recoverySync.close(); }
      assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'read_only_recovery');
    } finally { restored.close(); }
  } finally { backup?.cleanup(); sync.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('live backup restores history while holding pending work and disabling automation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-backup-test-'));
  let accepted!: () => void, calls = 0;
  const receipt = new Promise<void>(resolve => { accepted = resolve; });
  const provider = createServer(async req => { for await (const _chunk of req) {} calls++; accepted(); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'source.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options), restored: Awaited<ReturnType<typeof startApp>> | undefined;
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  }
  try {
    const agent = await request('/api/agents', { id: randomUUID(), name: 'Backup', model: 'fixture', instructions: 'Help.' });
    await app.close();
    const seed = new DatabaseSync(options.database);
    seed.prepare('INSERT INTO routines(id,agent,name,prompt,next_at,enabled,revision) VALUES (?,?,?,?,?,1,1)').run(randomUUID(), agent.id, 'Future', 'Help', Date.now() + 3600000);
    seed.prepare('INSERT INTO script_permissions VALUES (?,1,1)').run(agent.id);
    seed.prepare('INSERT INTO files(id,scope,name,digest,bytes,created) VALUES (?,?,?,?,?,?)').run(randomUUID(), `agents:${agent.id}`, 'binary.bin', 'fixture', Buffer.from([0, 255, 1]), new Date().toISOString());
    seed.close();
    app = await startApp(options);
    const turn = randomUUID(); await request(`/api/agents/${agent.id}/turns`, { id: turn, text: 'Pending provider result' }); await receipt;
    const workflow = await request(`/api/agents/${agent.id}/workflows`, { id: randomUUID(), revision: 0, name: 'Waiting approval', graph: { entry: 'approval', maxSteps: 2, nodes: [{ id: 'approval', kind: 'approval', prompt: 'Continue?', yes: 'out' }, { id: 'out', kind: 'output' }] } });
    const hook = await request(`/api/workflows/${workflow.id}/webhook`, { id: randomUUID(), revision: 0, rotate: true, enabled: true });
    await request(`/api/workflows/${workflow.id}/run`, { id: randomUUID(), revision: 1, input: 'Retain' });
    await request(`/api/workflows/${workflow.id}/schedule`, { id: randomUUID(), revision: 0, nextAt: Date.now() + 3600000, intervalSeconds: null, input: 'Future', enabled: true });
    const denied = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: false }) });
    assert.equal(denied.status, 400);
    const response = await fetch(app.origin + '/api/backup', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /attachment/);
    const file = join(dir, 'backup.sqlite'), bytes = Buffer.from(await response.arrayBuffer()); writeFileSync(file, bytes, { mode: 0o600 });
    assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    const destination = join(dir, 'restored.sqlite'); restoreWorkspace(file, destination);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(file), bytes);
    const db = new DatabaseSync(destination);
    assert.equal(db.prepare('SELECT enabled FROM routines').get()!.enabled, 0);
    assert.equal(db.prepare('SELECT enabled FROM workflow_webhooks').get()!.enabled, 0);
    assert.equal(db.prepare('SELECT secret FROM workflow_webhooks').get()!.secret, hook.secret);
    assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM files').get()!.bytes as Uint8Array), Buffer.from([0, 255, 1]));
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_creations').get()!.n, 1);
    assert.equal(db.prepare('SELECT enabled FROM script_permissions').get()!.enabled, 0);
    assert.equal(db.prepare('SELECT enabled FROM workflow_schedules').get()!.enabled, 0);
    assert.equal(db.prepare('SELECT status FROM workflow_runs').get()!.status, 'failed');
    assert.equal(db.prepare('SELECT paused FROM turns WHERE id=?').get(turn)!.paused, 1); db.close();
    restored = await startApp({ ...options, database: destination });
    const turns = await (await fetch(restored.origin + `/api/agents/${agent.id}/turns`)).json();
    assert.equal(turns[0].text, 'Pending provider result'); assert.equal(turns[0].status, 'interrupted');
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, 1);
    assert.throws(() => restoreWorkspace(file, destination), /database baru/);
    const symlink = join(dir, 'symlink.sqlite'); symlinkSync(destination, symlink); assert.throws(() => restoreWorkspace(file, symlink), /database baru/);
    const dangling = join(dir, 'dangling.sqlite'); symlinkSync(join(dir, 'missing'), dangling + '-wal');
    assert.throws(() => restoreWorkspace(file, dangling), /database baru/);
    const unknown = join(dir, 'unknown.sqlite'), unknownDb = new DatabaseSync(unknown); unknownDb.exec("CREATE TABLE briefsip_backup(format TEXT,version INTEGER); INSERT INTO briefsip_backup VALUES ('briefsip-workspace',99)"); unknownDb.close();
    assert.throws(() => restoreWorkspace(unknown, join(dir, 'unknown-target.sqlite')), /Format backup/);
    const corrupt = join(dir, 'corrupt'); writeFileSync(corrupt, 'not sqlite'); assert.throws(() => restoreWorkspace(corrupt, join(dir, 'invalid.sqlite')));
  } finally { await restored?.close(); await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
