import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeCanonicalSchema, initializeDeviceSchema, schemaVersion, SCHEMA_VERSION } from './schema.ts';

test('canonical v1 schema initializes empty and current SQLite stores idempotently', () => {
  const db = new DatabaseSync(':memory:');
  initializeCanonicalSchema(db, 1000);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'active');
  initializeCanonicalSchema(db, 2000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, SCHEMA_VERSION);
  const checksum = db.prepare('SELECT checksum FROM schema_migrations WHERE version=3').get()!.checksum;
  db.exec('DROP TRIGGER task_successor_provenance');
  initializeCanonicalSchema(db, 3000);
  assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE version=3').get()!.checksum, checksum);
  assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_successor_provenance'").get());
  for (const table of ['accounts', 'projects', 'project_members', 'agent_projects', 'collaborator_agents', 'response_policies', 'invitations', 'mail_outbox', 'receipts', 'record_scopes', 'wait_provisions']) assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
  db.close();
});

test('schema rollback leaves no partial v1 tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT UNIQUE,checksum TEXT,applied_at INTEGER)");
  db.prepare('INSERT INTO schema_migrations VALUES (99,?,?,?)').run('future', 'x', 1);
  assert.throws(() => initializeCanonicalSchema(db));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='projects'").get()!.n, 0);
  db.close();
});

test('device schema stays separate from canonical authority and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  initializeDeviceSchema(db); initializeDeviceSchema(db);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
  for (const table of ['device_state', 'device_resource_bindings', 'device_provider_bindings', 'device_journal', 'device_outbox', 'device_wait_secrets']) assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projects'").get(), undefined);
  db.close();
});

test('device schema refuses canonical database', () => {
  const db = new DatabaseSync(':memory:'); initializeCanonicalSchema(db);
  assert.throws(() => initializeDeviceSchema(db), /Canonical/); db.close();
});
