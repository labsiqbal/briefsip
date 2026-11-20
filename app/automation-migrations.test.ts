import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './test-support/database.ts';
import { startCanonicalApp } from './test-bridge.ts';
import { digestCommand } from './shared/protocol.ts';
import { installFrozenNodeSchema } from './test-support/canonical-schema.ts';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://fixture.clerk.accounts.dev';
const origin = 'http://127.0.0.1';
const now = Date.now();
const due = now - 960000;
const graph = JSON.stringify({ entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-old-automation-'));
  const database = join(dir, 'state.sqlite'), db = testDatabase(database);
  const owner = randomUUID(), project = randomUUID(), agent = randomUUID(), home = randomUUID(), installation = randomUUID();
  installFrozenNodeSchema(db);
  db.prepare("INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,'user_owner',?)").run(owner, issuer, now);
  db.prepare("INSERT INTO projects(id,account,name,private) VALUES (?,?,'Private',1)").run(project, owner);
  db.prepare("INSERT INTO project_members VALUES (?,?,'owner',1,0)").run(project, owner);
  db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES (?,'Agent','fixture','Help')").run(agent);
  db.prepare("INSERT INTO agent_projects VALUES (?,?,'',?,1,0)").run(project, agent, JSON.stringify({ v: 1, tools: [], resources: [] }));
  db.prepare("INSERT INTO installations VALUES (?,?,'key','thumb',1,0,1,?)").run(installation, owner, now);
  db.prepare(`INSERT INTO devices VALUES (?,?,?,'key','key','sig','enc','{}',1,0,'offline','Asia/Jakarta',1,NULL,'["execution"]',1)`).run(home, installation, owner);
  db.prepare('INSERT INTO agent_authority VALUES (?,?,?,NULL,1)').run(agent, owner, home);
  const generation = String(db.prepare('SELECT generation FROM authority_state WHERE id=1').get()!.generation);
  const scope = (table: string, key: unknown[], kind: string, root: string) => {
    db.prepare("INSERT INTO record_scopes VALUES (?,?,?,?,'owner',?,?)").run(table, JSON.stringify(key), owner, project, kind, root);
  };
  scope('agents', [agent], 'agent', agent);
  let app: Awaited<ReturnType<typeof startCanonicalApp>> | undefined;
  const start = async () => {
    app = await startCanonicalApp({
      database, fixedClock: now, syncKey: () => new Uint8Array(32),
      auth: { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer, origin, development: true, jwtKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    });
  };
  const request = async (path: string, body?: { requestId: string; [key: string]: unknown }, status = 200, subject = 'user_owner') => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: subject, sid: `sess_${subject}`, azp: app!.origin, nbf: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 300 })).toString('base64url');
    const input = `${header}.${payload}`;
    const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url')}`;
    const response = await fetch(app!.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': body?.requestId ?? randomUUID(), 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: app!.origin },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data.ok ? (body ? data : data.data) : data.error;
  };
  const sync = (cursor?: string, status = 200, subject = 'user_owner') => {
    const query = new URLSearchParams({ projectId: project });
    if (cursor) query.set('cursor', cursor);
    return request('/api/sync?' + query, undefined, status, subject);
  };
  const ready = () => db.prepare("UPDATE devices SET status='ready',last_seen=? WHERE id=?").run(now, home);
  const install = (name: string) => db.exec(readFileSync(new URL(`./test-support/fixtures/${name}.sql`, import.meta.url), 'utf8'));
  const workflow = (interval: number | null, at = due) => {
    const id = randomUUID();
    db.prepare("INSERT INTO workflows VALUES (?,?,'Legacy workflow',1,0)").run(id, agent);
    db.prepare('INSERT INTO workflow_versions VALUES (?,1,?)').run(id, graph);
    db.prepare("INSERT INTO workflow_schedules VALUES (?,7,?,?,'Private input',1)").run(id, at, interval);
    scope('workflows', [id], 'workflow', id);
    scope('workflow_versions', [id, 1], 'workflow', id);
    scope('workflow_schedules', [id], 'workflow', id);
    return id;
  };
  const occurrence = (workflow: string, at: number, run: string | null, missed: number) => {
    db.prepare('INSERT INTO workflow_occurrences VALUES (?,?,?,?,?)').run(workflow, at, run, missed, run ? null : 'busy');
    scope('workflow_occurrences', [workflow, at], 'workflow', workflow);
  };
  return { db, owner, project, home, agent, generation, scope, start, request, sync, ready, install, workflow, occurrence,
    path: (id: string) => `/api/projects/${project}/workflows/${id}/schedule`,
    stop: async () => { await app?.close(); app = undefined; },
    close: async () => { await app?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;
const scopeRevision = (f: Fixture) => f.db.prepare('SELECT revision FROM sync_scope_revisions WHERE project=?').get(f.project)?.revision;
const count = (f: Fixture, table: string) => f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
async function admission(f: Fixture, path: string, total: number) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const current = await f.request(path);
    if (current.occurrences.length === total && current.occurrences[0].state === 'admitted') return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Workflow schedule did not admit its overdue occurrence');
}
const foreignKeys = (f: Fixture) => assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
const failInvalidation = "CREATE TRIGGER fail_upgrade BEFORE INSERT ON sync_scope_revisions BEGIN SELECT RAISE(ABORT,'fixture invalidation failure'); END";
const command = (revision: number, spec: unknown, enabled = true) => {
  const id = randomUUID();
  return { requestId: id, id, revision, spec, enabled, input: 'Private input' };
};

function saveReceipt(f: Fixture, path: string, input: { requestId: string }, record: string, data: unknown) {
  const payloadDigest = digestCommand(['briefsip-retained-command-v1', f.owner, f.project, 'POST', path, input]);
  const receipt = { requestId: input.requestId, actorId: f.owner, projectId: f.project, payloadDigest, status: 201, recordId: record, recordRevision: 1, committedAt: now };
  f.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,201,?,?)')
    .run(input.requestId, f.owner, f.project, `retained:${path}`, payloadDigest, JSON.stringify({ status: 201, receipt, data }), now);
  return receipt;
}

function routine(f: Fixture) {
  const id = randomUUID(), run = randomUUID();
  f.db.prepare("INSERT INTO routines VALUES (?,?,'Routine','Private prompt',?,NULL,0,2)").run(id, f.agent, now);
  f.db.prepare("INSERT INTO routine_schedule_bindings VALUES (?,?,?,1,?,?,'Asia/Jakarta',1)").run(id, f.project, f.owner, f.generation, f.home);
  f.db.prepare("INSERT INTO routine_occurrences VALUES (23,?,?,?, ?,1,?,1,?,?,'Asia/Jakarta',1,2,'done',NULL,NULL)").run(run, id, f.project, due, f.owner, f.generation, f.home);
  f.db.prepare("INSERT INTO routine_steps VALUES (?,?,NULL,'done','Report')").run(run, f.agent);
  const path = `/api/projects/${f.project}/agents/${f.agent}/routines`;
  const input = { id, requestId: id, revision: 0, name: 'Routine', prompt: 'Private prompt', nextAt: due, intervalSeconds: 65, enabled: true };
  const receipt = saveReceipt(f, path, input, id, { id, next_at: due, interval_ms: 65000, enabled: 1 });
  f.db.prepare("INSERT INTO sync_events VALUES (33,?,?,?,0,'routine_occurrence',?,1,'upsert','{}',?)").run(f.owner, f.project, f.generation, run, now);
  f.db.prepare("INSERT INTO sync_heads VALUES (?,?,33)").run(f.owner, f.project);
  f.scope('routines', [id], 'agent', f.agent);
  f.scope('routine_occurrences', [run], 'agent', f.agent);
  f.db.exec("UPDATE sqlite_sequence SET seq=5000 WHERE name='routine_occurrences'");
  return { id, run, path, input, receipt };
}

test('Rust upgrades old routine source, observations and timing using historical receipts atomically', async () => {
  const f = fixture();
  try {
    f.install('node-routines-before-occurrence-upgrades');
    const { id, run, path, input, receipt } = routine(f);
    const receipts = f.db.prepare('SELECT * FROM receipts').all(), steps = f.db.prepare('SELECT * FROM routine_steps').all();
    const events = f.db.prepare('SELECT * FROM sync_events').all();
    f.db.exec(failInvalidation);
    await assert.rejects(f.start(), /fixture invalidation failure/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM pragma_table_info('routine_occurrences') WHERE name IN('source','schedule_kind','observation_revision')").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT max(version) AS v FROM schema_migrations").get()!.v, 4);
    assert.equal(scopeRevision(f), undefined);
    assert.deepEqual(f.db.prepare('SELECT * FROM sync_events').all(), events);
    assert.deepEqual(f.db.prepare('SELECT * FROM receipts').all(), receipts);
    assert.deepEqual(f.db.prepare('SELECT * FROM routine_steps').all(), steps);
    f.db.exec('DROP TRIGGER fail_upgrade');
    await f.start();
    for (let restart = 0; restart < 2; restart++) {
      const row = f.db.prepare('SELECT seq,id,due_at,source,schedule_kind,observation_revision,missed_count FROM routine_occurrences').get();
      assert.deepEqual({ ...row }, { seq: 23, id: run, due_at: due, source: 'schedule', schedule_kind: 'interval', observation_revision: 1, missed_count: 2 });
      const binding = f.db.prepare('SELECT spec_json FROM routine_schedule_bindings WHERE routine=?').get(id);
      assert.deepEqual(JSON.parse(String(binding?.spec_json)), { kind: 'instant', at: now });
      assert.deepEqual(f.db.prepare('SELECT * FROM receipts').all(), receipts);
      assert.deepEqual(f.db.prepare('SELECT * FROM routine_steps').all(), steps);
      assert.deepEqual(f.db.prepare('SELECT * FROM sync_events').all().map(row => ({ ...row })), events.map(e => ({ ...e, body_json: '{"source":"schedule"}' })));
      assert.equal(f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='routine_occurrences'").get()!.seq, 5000);
      assert.equal(scopeRevision(f), 1);
      assert.deepEqual((await f.request(path, input)).receipt, receipt);
      const detail = await f.request(`/api/projects/${f.project}/routines/${id}/runs`);
      assert.equal(detail.items[0].source, 'schedule');
      assert.equal(detail.items[0].id, run);
      foreignKeys(f);
      if (restart === 0) { await f.stop(); await f.start(); }
    }
  } finally { await f.close(); }
});

test('Rust preserves exact legacy elapsed milliseconds during routine catch-up', async () => {
  const f = fixture();
  try {
    f.install('node-routines-before-occurrence-upgrades');
    const { id } = routine(f);
    const anchor = now - (2 * 65000 - 1);
    f.db.prepare('UPDATE routines SET interval_ms=65000,next_at=?,enabled=1 WHERE id=?').run(anchor, id);
    await f.start();
    const path = `/api/projects/${f.project}/routines/${id}`;
    const detail = await f.request(path);
    assert.deepEqual(detail.schedule, { kind: 'interval', amount: 65000 / 60000, unit: 'minute', anchorAt: anchor });
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      const pending = (await f.request(path + '/runs')).items.find((row: { state: string }) => row.state === 'pending');
      if (pending) {
        assert.equal(pending.dueAt, anchor);
        assert.equal(pending.missedCount, 1);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Upgraded routine did not record its offline catch-up');
  } finally { await f.close(); }
});

test('Rust retains an upgraded whole-minute routine anchor on metadata-only edit', async () => {
  const f = fixture();
  try {
    f.install('node-routines-before-occurrence-upgrades');
    const { id } = routine(f);
    f.db.prepare('UPDATE routines SET interval_ms=300000 WHERE id=?').run(id);
    await f.start();
    const path = `/api/projects/${f.project}/routines/${id}`;
    const { schedule } = await f.request(path);
    assert.deepEqual(schedule, { kind: 'interval', amount: 5, unit: 'minute', anchorAt: now });
    // The scheduler advances next_at independently of the original anchor.
    const advanced = now + 300000;
    f.db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(advanced, id);
    const requestId = randomUUID();
    const edited = await f.request(path + '/edit', {
      requestId, id: requestId, revision: 2, name: 'Renamed', prompt: 'Private prompt', schedule, enabled: false,
    });
    assert.equal(edited.data.next_at, advanced);
    assert.deepEqual(edited.data.schedule, schedule);
  } finally { await f.close(); }
});

test('Rust extends the old manual routine source constraint and preserves the existing cursor revision', async () => {
  const f = fixture();
  try {
    f.install('node-routines-before-occurrence-upgrades');
    const { id, run } = routine(f);
    f.db.exec(`DROP INDEX legacy_routine_time;
      ALTER TABLE routines ADD COLUMN trigger TEXT NOT NULL DEFAULT 'schedule';
      ALTER TABLE routines ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 1 CHECK(observation_revision>0);
      ALTER TABLE routine_schedule_bindings ADD COLUMN spec_json TEXT CHECK(spec_json IS NULL OR json_valid(spec_json));
      UPDATE routine_schedule_bindings SET spec_json='{"kind":"instant","at":0}';
      ALTER TABLE routine_occurrences ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 1 CHECK(observation_revision>0);
      ALTER TABLE routine_occurrences ADD COLUMN source TEXT NOT NULL DEFAULT 'schedule' CHECK(source IN('schedule','manual'));
      ALTER TABLE routine_occurrences ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'instant' CHECK(schedule_kind IN('instant','interval','once','cron'));
      INSERT INTO sync_scope_revisions SELECT id,9 FROM projects;`);
    f.db.prepare("INSERT INTO routine_occurrences SELECT 40,'manual',routine,project,due_at,schedule_revision,initiator_account,assignment_revision,authority_generation,home_device,zone,zone_revision,0,'done',NULL,NULL,3,'manual','instant' FROM routine_occurrences WHERE id=?").run(run);
    f.db.prepare("INSERT INTO routine_steps VALUES ('manual',?,NULL,'done','Manual report')").run(f.agent);
    const before = f.db.prepare('SELECT * FROM routine_occurrences ORDER BY seq').all();
    const steps = f.db.prepare('SELECT * FROM routine_steps ORDER BY occurrence').all();
    const receipts = f.db.prepare('SELECT * FROM receipts').all();
    f.db.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE OF body_json ON sync_events BEGIN SELECT RAISE(ABORT,'fixture source failure'); END");
    await assert.rejects(f.start(), /fixture source failure/);
    assert.deepEqual(f.db.prepare('SELECT * FROM routine_occurrences ORDER BY seq').all(), before);
    assert.equal(scopeRevision(f), 9);
    f.db.exec('DROP TRIGGER fail_upgrade');
    await f.start();
    assert.deepEqual(f.db.prepare('SELECT * FROM routine_occurrences ORDER BY seq').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM routine_steps ORDER BY occurrence').all(), steps);
    assert.deepEqual(f.db.prepare('SELECT * FROM receipts').all(), receipts);
    assert.equal(scopeRevision(f), 9);
    const cursor = (await f.sync()).nextCursor;
    await f.stop(); await f.start();
    assert.deepEqual((await f.sync(cursor)).page.events, []);
    assert.equal(f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='routine_occurrences'").get()!.seq, 5000);
    assert.equal(f.db.prepare('SELECT body_json FROM sync_events').get()!.body_json, '{"source":"schedule"}');
    f.db.prepare("UPDATE routine_occurrences SET source='webhook' WHERE id='manual' AND routine=?").run(id);
    foreignKeys(f);
  } finally { await f.close(); }
});

test('Rust imports verified legacy short intervals disabled and permits only exact reactivation', async () => {
  const f = fixture();
  try {
    f.install('node-workflow-legacy-schedules');
    const ids = [60000, 120000, 240000].map(ms => f.workflow(ms));
    const original = f.db.prepare('SELECT * FROM workflow_schedules ORDER BY workflow').all();
    await f.start();
    for (const [index, id] of ids.entries()) {
      const migrated = await f.request(f.path(id));
      assert.equal(migrated.id, id);
      assert.equal(migrated.enabled, false);
      assert.equal(migrated.revision, 7);
      assert.equal(migrated.nextAt, due);
      assert.deepEqual(migrated.spec, { kind: 'legacy_interval', intervalMs: [60000, 120000, 240000][index], anchorAt: due });
      assert.deepEqual(migrated.occurrences, []);
    }
    assert.equal(scopeRevision(f), 1);
    const path = f.path(ids[0]), spec = { kind: 'legacy_interval', intervalMs: 60000, anchorAt: due };
    assert.equal((await f.request(path, command(7, { ...spec, intervalMs: 120000 }), 400)).code, 'invalid_schedule');
    f.ready();
    const activate = command(7, spec);
    const accepted = await f.request(path, activate);
    assert.equal(accepted.data.enabled, true);
    assert.equal(accepted.data.nextAt, due);
    const admitted = await admission(f, path, 1);
    assert.equal(admitted.nextAt, now + 60000);
    assert.equal(admitted.occurrences[0].dueAt, due);
    assert.equal(admitted.occurrences[0].missedCount, 16);
    await f.stop(); await f.start();
    assert.deepEqual(await f.request(path), admitted);
    assert.deepEqual((await f.request(path, activate)).receipt, accepted.receipt);
    assert.equal(scopeRevision(f), 1);
    assert.deepEqual(f.db.prepare('SELECT * FROM workflow_schedules ORDER BY workflow').all(), original);
    foreignKeys(f);
  } finally { await f.close(); }
});

test('Rust leaves incomplete legacy sources private and preserves edited instants', async () => {
  const f = fixture();
  try {
    f.install('node-workflow-legacy-schedules');
    const instant = f.workflow(null), elapsed = f.workflow(60000);
    const ddl = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='workflow_occurrences'").get()!.sql);
    f.db.exec('DROP TABLE workflow_occurrences');
    await f.start();
    assert.equal(count(f, 'schedules'), 0);
    const cursor = (await f.sync()).nextCursor;
    assert(cursor);
    await f.stop();
    f.db.exec(ddl);
    for (const id of [instant, elapsed]) f.occurrence(id, due + 120000, null, 0);
    await f.start();
    assert.equal((await f.sync(cursor, 410)).code, 'resync_required');
    for (const id of [instant, elapsed]) {
      const current = await f.request(f.path(id));
      assert.equal(current.nextAt, due);
      assert.equal(current.enabled, false);
    }
  } finally { await f.close(); }
});

test('Rust rejects unverified legacy workflow schedules without claiming private rows', async () => {
  const cases = [
    "DELETE FROM record_scopes WHERE table_name='workflow_schedules'",
    'UPDATE projects SET private=0',
    "UPDATE record_scopes SET visibility='project' WHERE table_name='workflows'",
    "UPDATE record_scopes SET visibility='project' WHERE table_name='workflow_schedules'",
    "DELETE FROM record_scopes WHERE table_name='workflow_versions'",
    "DELETE FROM record_scopes WHERE table_name='agents'",
    "UPDATE devices SET status='revoked'",
    "UPDATE devices SET capabilities_json='[]'",
    'UPDATE installations SET revoked=1',
    'UPDATE accounts SET blocked=1',
    "INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES('foreign','fixture','other',0); UPDATE record_scopes SET account='foreign' WHERE table_name='workflow_schedules'",
    'UPDATE workflow_schedules SET interval_ms=59999',
    'UPDATE workflow_schedules SET next_at=-1',
    'UPDATE workflow_schedules SET revision=0',
    'INSERT INTO workflow_occurrences SELECT workflow,next_at,NULL,0,NULL FROM workflow_schedules',
    `INSERT INTO workflow_occurrences SELECT workflow,next_at,NULL,-1,NULL FROM workflow_schedules;
     INSERT INTO record_scopes SELECT 'workflow_occurrences',json_array(l.workflow,l.next_at),s.account,s.project,'owner','workflow',l.workflow
     FROM workflow_schedules l JOIN record_scopes s ON s.table_name='workflow_schedules' AND s.root_id=l.workflow`,
  ];
  for (const sql of cases) {
    const f = fixture();
    try {
      f.install('node-workflow-legacy-schedules');
      f.workflow(60000);
      f.db.exec(sql);
      const source = f.db.prepare('SELECT * FROM workflow_schedules').all();
      const before = scopeRevision(f);
      await f.start();
      assert.equal(count(f, 'schedules'), 0, sql);
      assert.equal(count(f, 'occurrences'), 0, sql);
      assert.equal(scopeRevision(f), before, sql);
      assert.deepEqual(f.db.prepare('SELECT * FROM workflow_schedules').all(), source, sql);
    } finally { await f.close(); }
  }
});

test('Rust imports legacy history with original due dates, run links and occurrence identity', async () => {
  const f = fixture();
  try {
    f.install('node-workflow-legacy-schedules');
    const workflow = f.workflow(60000), instant = f.workflow(null), run = randomUUID();
    f.db.prepare("INSERT INTO workflow_runs VALUES (?,?,1,?,?,'old','result','out',1,1,'done',NULL,'',NULL)").run(run, workflow, f.agent, graph);
    f.scope('workflow_runs', [run], 'workflow', workflow);
    f.occurrence(workflow, due, run, 0);
    f.occurrence(workflow, due + 60000, null, 0);
    f.occurrence(workflow, due + 120000, null, 2);
    f.occurrence(instant, due, null, 0);
    const original = f.db.prepare('SELECT * FROM workflow_occurrences ORDER BY workflow,scheduled_at').all();
    await f.start();
    const path = f.path(workflow), elapsed = await f.request(path), once = await f.request(f.path(instant));
    assert.equal(elapsed.nextAt, due + 180000);
    assert.deepEqual(elapsed.occurrences.map((row: Record<string, unknown>) => [row.dueAt, row.state, row.runId, row.missedCount, row.occurrenceId]), [
      [due + 120000, 'consumed', null, 2], [due + 60000, 'consumed', null, 0], [due, 'admitted', run, 0],
    ].map(row => [...row, createHash('sha256').update(JSON.stringify([workflow, 7, 1, row[0], 0])).digest('base64url')]));
    assert.deepEqual(once.spec, { kind: 'instant', at: due });
    assert.equal(once.nextAt, null);
    assert.equal((await f.request(f.path(instant), command(7, once.spec), 409)).code, 'schedule_processed');
    const member = randomUUID();
    f.db.prepare("INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,'user_member',?)").run(member, issuer, now);
    f.db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(f.project, member);
    f.db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(f.project, member, f.agent);
    assert.equal((await f.request(path, undefined, 404, 'user_member')).code, 'resource_not_found');
    const memberSnapshot = await f.sync(undefined, 200, 'user_member');
    assert(!memberSnapshot.page.events.some((event: { recordKind: string }) => event.recordKind.startsWith('workflow_schedule')));
    await f.request(path, command(7, elapsed.spec));
    f.ready();
    const admitted = await admission(f, path, 4);
    assert.equal(admitted.occurrences[0].dueAt, due + 180000);
    assert.equal(admitted.nextAt, now + 60000);
    assert.deepEqual(admitted.occurrences.slice(1), elapsed.occurrences);
    await f.stop(); await f.start();
    assert.deepEqual(await f.request(path), admitted);
    assert.deepEqual(f.db.prepare('SELECT * FROM workflow_occurrences ORDER BY workflow,scheduled_at').all(), original);
    assert.equal(count(f, 'workflow_runs'), 2);
    foreignKeys(f);
  } finally { await f.close(); }
});

test('Rust rolls back legacy workflow conversion and never overwrites edited canonical work', async () => {
  const f = fixture();
  try {
    f.install('node-workflow-legacy-schedules');
    const workflow = f.workflow(60000);
    f.occurrence(workflow, due, null, 0);
    f.db.exec(failInvalidation);
    await assert.rejects(f.start(), /fixture invalidation failure/);
    for (const name of ['schedules', 'workflow_schedule_targets', 'occurrences']) {
      assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name), undefined);
    }
    assert.equal(scopeRevision(f), undefined);
    f.db.exec('DROP TRIGGER fail_upgrade');
    await f.start();
    const path = f.path(workflow);
    const edit = command(7, { kind: 'interval', amount: 5, unit: 'minute', anchorAt: now }, false);
    const saved = await f.request(path, edit), canonical = await f.request(path);
    await f.stop(); await f.start();
    assert.deepEqual(await f.request(path), canonical);
    assert.deepEqual((await f.request(path, edit)).receipt, saved.receipt);
    assert.equal(scopeRevision(f), 1);
  } finally { await f.close(); }
});

test('Rust upgrades workflow observation columns, history and sync revision atomically', async () => {
  const f = fixture();
  try {
    f.install('node-workflow-legacy-schedules');
    f.install('node-workflow-before-observations');
    const workflow = f.workflow(60000), spec = { kind: 'instant', at: due };
    f.db.prepare("INSERT INTO schedules VALUES (?,?,?,?,?,1,?,'instant','Asia/Jakarta',1,?,?,1,1)").run(workflow, f.project, f.agent, f.home, f.owner, f.generation, JSON.stringify(spec), due);
    f.db.prepare("INSERT INTO workflow_schedule_targets VALUES (?,?,'Private input')").run(workflow, workflow);
    f.db.prepare("INSERT INTO occurrences VALUES (?,'historical',?,1,1,?,1,?,NULL,'pending',0,NULL,?)").run(workflow, due, f.owner, f.generation, randomUUID());
    const input = command(0, spec);
    const receipt = saveReceipt(f, f.path(workflow), input, workflow, { id: workflow, spec, revision: 1, enabled: true });
    const schedules = f.db.prepare('SELECT * FROM schedules').all(), history = f.db.prepare('SELECT * FROM occurrences').all(), receipts = f.db.prepare('SELECT * FROM receipts').all();
    f.db.exec(failInvalidation);
    await assert.rejects(f.start(), /fixture invalidation failure/);
    assert.deepEqual(f.db.prepare('SELECT * FROM schedules').all(), schedules);
    assert.deepEqual(f.db.prepare('SELECT * FROM occurrences').all(), history);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='workflow_schedule_cron_cursors'").get(), undefined);
    f.db.exec('DROP TRIGGER fail_upgrade');
    await f.start();
    const observations = (value: { page: { events: { recordKind: string; revision: number }[] } }) =>
      value.page.events.filter(event => event.recordKind.startsWith('workflow_schedule')).map(event => [event.recordKind, event.revision]);
    const snapshot = await f.sync();
    assert.deepEqual(observations(snapshot).sort(), [['workflow_schedule', 1], ['workflow_schedule_occurrence', 1]]);
    for (let restart = 0; restart < 2; restart++) {
      assert.equal(scopeRevision(f), 1);
      assert.deepEqual(f.db.prepare('SELECT * FROM schedules').all().map(row => ({ ...row })), schedules.map(row => ({ ...row, observation_revision: 1 })));
      assert.deepEqual(f.db.prepare('SELECT * FROM occurrences').all().map(row => ({ ...row })), history.map(row => ({ ...row, observation_revision: 1 })));
      assert.deepEqual(f.db.prepare('SELECT * FROM receipts').all(), receipts);
      assert(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='workflow_schedule_cron_cursors'").get());
      assert.deepEqual((await f.request(f.path(workflow), input)).receipt, receipt);
      foreignKeys(f);
      if (restart === 0) { await f.stop(); await f.start(); }
    }
    assert.deepEqual((await f.sync(snapshot.nextCursor)).page.events, []);
    f.ready();
    await admission(f, f.path(workflow), 1);
    assert.deepEqual(observations(await f.sync(snapshot.nextCursor)).sort(), [['workflow_schedule', 2], ['workflow_schedule_occurrence', 2]]);
  } finally { await f.close(); }
});
