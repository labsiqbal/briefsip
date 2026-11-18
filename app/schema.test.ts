import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeCanonicalSchema, schemaVersion, SCHEMA_VERSION } from './schema.ts';

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
  for (const table of ['accounts', 'projects', 'project_members', 'agent_projects', 'collaborator_agents', 'response_policies', 'invitations', 'mail_outbox', 'receipts', 'record_scopes', 'sync_scope_revisions', 'wait_provisions']) assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
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

test('routine outcome schema upgrade retains old turns and saved flags across restart', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeCanonicalSchema(db);
    const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    db.exec("ALTER TABLE turns DROP COLUMN no_update; INSERT INTO agents(id,name,model,instructions) VALUES ('agent','Agent','fixture','Help'); INSERT INTO turns(id,agent,text,reply,status,created) VALUES ('turn','agent','Old request','Old reply','done','fixture')");
    initializeCanonicalSchema(db);
    assert.deepEqual({...db.prepare('SELECT text,reply,status,no_update FROM turns').get()!},{text:'Old request',reply:'Old reply',status:'done',no_update:0});
    db.exec('UPDATE turns SET no_update=1');initializeCanonicalSchema(db);
    assert.equal(db.prepare('SELECT no_update FROM turns').get()!.no_update,1);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),migrations);
  } finally { db.close(); }
});
