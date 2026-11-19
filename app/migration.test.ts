import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './test-support/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeCanonicalSchema, schemaVersion } from './test-support/legacy-schema.ts';
import { startApp } from './test-bridge.ts';

test('v1 migration preserves actual legacy rows without inferring ownership or scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-migration-')); const database = join(dir, 'legacy.sqlite');
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database });
    const agentId = randomUUID();
    const created = await fetch(`${app.origin}/api/agents`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: agentId, name: 'Private', model: 'fixture', instructions: 'Private legacy fixture' }) });
    assert.equal(created.status, 201); await app.close(); app = undefined;
    let db = testDatabase(database);
    const before = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId);
    initializeCanonicalSchema(db);
    assert.deepEqual(db.prepare('SELECT * FROM agents WHERE id=?').get(agentId), before);
    for (const table of ['accounts', 'projects', 'project_members', 'record_scopes']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal'); assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    const generation = db.prepare('SELECT generation FROM authority_state').get()!.generation;
    db.close(); db = testDatabase(database); initializeCanonicalSchema(db);
    assert.equal(db.prepare('SELECT generation FROM authority_state').get()!.generation, generation);
    db.close();
  } finally { await app?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mid-migration SQL failure rolls back DDL and preserves legacy content', () => {
  const db = testDatabase(':memory:');
  try {
    db.exec("CREATE TABLE legacy_private(id TEXT PRIMARY KEY,body TEXT); INSERT INTO legacy_private VALUES ('old','private'); CREATE TABLE invitations(id TEXT)");
    assert.throws(() => initializeCanonicalSchema(db), /already exists/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='accounts'").get()!.n, 0);
    assert.equal(db.prepare('SELECT body FROM legacy_private').get()!.body, 'private');
  } finally { db.close(); }
});

test('v4 sync migration preserves v3 record identities and rolls back conflicting DDL', () => {
  const db = testDatabase(':memory:');
  try {
    initializeCanonicalSchema(db, 1000, 3);
    const account = randomUUID(), project = randomUUID();
    db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(account, 'https://fixture.example', 'owner', 1000);
    db.prepare('INSERT INTO projects VALUES (?,?,?,1,0,1)').run(project, account, 'Private v3 record');
    const before = db.prepare('SELECT * FROM projects').all(), oldMigrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    db.exec('CREATE TABLE retention_floors(conflict TEXT)');
    assert.throws(() => initializeCanonicalSchema(db, 2000), /already exists/);
    assert.equal(schemaVersion(db), 3);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_events'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM projects').all(), before);
    db.exec('DROP TABLE retention_floors');
    initializeCanonicalSchema(db, 3000); initializeCanonicalSchema(db, 4000);
    assert.equal(schemaVersion(db), 4); assert.deepEqual(db.prepare('SELECT * FROM projects').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<4 ORDER BY version').all(), oldMigrations);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});


test('additive role migration preserves existing local and canonical databases and defaults empty', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules/.role-migration-')), database = join(dir, 'legacy.sqlite');
  const db = testDatabase(database), agent = randomUUID();
  db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,model TEXT NOT NULL,instructions TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO agents VALUES (?,?,?,?)').run(agent, 'Legacy', 'fixture', 'Preserve'); db.close();
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database });
    const directory = await (await fetch(app.origin + '/api/agents')).json(); assert.equal(directory.agents[0].role, ''); assert.equal(directory.agents[0].instructions, 'Preserve');
    await app.close(); app = undefined;
    const canonical = testDatabase(':memory:');
    try {
      initializeCanonicalSchema(canonical);
      canonical.exec('ALTER TABLE agents DROP COLUMN role');
      canonical.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(agent, 'Legacy', 'fixture', 'Preserve');
      initializeCanonicalSchema(canonical); initializeCanonicalSchema(canonical);
      assert.equal(canonical.prepare('SELECT role FROM agents').get()!.role, '');
      const column = canonical.prepare('PRAGMA table_info(agents)').all().find(row => row.name === 'role')!;
      assert.equal(column.notnull, 1); assert.equal(column.dflt_value, "''");
    } finally { canonical.close(); }
  } finally { await app?.close(); rmSync(dir, { recursive: true, force: true }); }
});
