import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeCanonicalSchema, schemaVersion } from './schema.ts';

test('canonical v1 schema initializes empty and current SQLite stores idempotently', () => {
  const db = new DatabaseSync(':memory:');
  initializeCanonicalSchema(db, 1000);
  assert.equal(schemaVersion(db), 1);
  assert.equal(db.prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'active');
  initializeCanonicalSchema(db, 2000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, 1);
  for (const table of ['accounts', 'projects', 'project_members', 'agent_projects', 'collaborator_agents', 'response_policies', 'invitations', 'mail_outbox', 'receipts', 'record_scopes']) assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
  db.close();
});

test('schema rollback leaves no partial v1 tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT UNIQUE,checksum TEXT,applied_at INTEGER)");
  db.prepare('INSERT INTO schema_migrations VALUES (2,?,?,?)').run('future', 'x', 1);
  assert.throws(() => initializeCanonicalSchema(db));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='projects'").get()!.n, 0);
  db.close();
});
