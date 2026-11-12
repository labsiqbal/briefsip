import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeCanonicalSchema } from './schema.ts';
import { startApp } from './server.ts';

test('v1 migration preserves actual legacy rows without inferring ownership or scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-migration-')); const database = join(dir, 'legacy.sqlite');
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database });
    const agentId = randomUUID();
    const created = await fetch(`${app.origin}/api/agents`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: agentId, name: 'Private', model: 'fixture', instructions: 'Private legacy fixture' }) });
    assert.equal(created.status, 201); await app.close(); app = undefined;
    let db = new DatabaseSync(database);
    const before = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId);
    initializeCanonicalSchema(db);
    assert.deepEqual(db.prepare('SELECT * FROM agents WHERE id=?').get(agentId), before);
    for (const table of ['accounts', 'projects', 'project_members', 'record_scopes']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal'); assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    const generation = db.prepare('SELECT generation FROM authority_state').get()!.generation;
    db.close(); db = new DatabaseSync(database); initializeCanonicalSchema(db);
    assert.equal(db.prepare('SELECT generation FROM authority_state').get()!.generation, generation);
    db.close();
  } finally { await app?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mid-migration SQL failure rolls back DDL and preserves legacy content', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE legacy_private(id TEXT PRIMARY KEY,body TEXT); INSERT INTO legacy_private VALUES ('old','private'); CREATE TABLE invitations(id TEXT)");
    assert.throws(() => initializeCanonicalSchema(db), /already exists/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='accounts'").get()!.n, 0);
    assert.equal(db.prepare('SELECT body FROM legacy_private').get()!.body, 'private');
  } finally { db.close(); }
});
