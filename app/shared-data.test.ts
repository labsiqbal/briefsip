import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSharedData, dataRequest, prepareData, commitData } from './shared-data.ts';

test('SQLite authorizer enforces schema ownership, blocks host access and keeps revision conflicts atomic', async () => {
  const db = new DatabaseSync(':memory:'); initializeSharedData(db);
  const execute = async (sql: string, owner = 'alpha', parameters: unknown[] = [], readonly = false) => {
    const prepared = await prepareData(db, dataRequest('query', { sql, parameters }), owner, AbortSignal.timeout(5000), readonly);
    db.exec('BEGIN'); try { const result = commitData(db, prepared); db.exec('COMMIT'); return result as any; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    await execute('CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)');
    await execute('INSERT INTO notes(text) VALUES (?)', 'beta', ['shared']);
    await assert.rejects(execute('ALTER TABLE notes RENAME TO briefsip_hidden'), /dilindungi/);
    await assert.rejects(execute('ALTER TABLE notes RENAME TO "' + 'n'.repeat(129) + '"'), /128/);
    assert.deepEqual((await execute('SELECT * FROM notes', 'beta')).rows, [[1, 'shared']]);
    for (const sql of ['DROP TABLE notes', 'ALTER TABLE notes ADD COLUMN private TEXT', 'CREATE INDEX bad_index ON notes(text)']) await assert.rejects(execute(sql, 'beta'), /authorized|prohibited/i);
    await execute('ALTER TABLE notes ADD COLUMN n INTEGER');
    await execute('ALTER TABLE notes RENAME TO renamed');
    await assert.rejects(execute('DROP TABLE renamed', 'beta'), /authorized|prohibited/i);
    await execute('CREATE INDEX note_index ON renamed(text)');
    await assert.rejects(execute('DROP INDEX note_index', 'beta'), /authorized|prohibited/i);
    await execute('DROP INDEX note_index');
    for (const name of ['briefsipXnotes', 'sqliteXnotes', '\u00c9', '\u00e9', 'k', '\u212a']) {
      const creator = name === 'k' || name === '\u00c9' ? 'alpha' : 'beta';
      await execute(`CREATE TABLE "${name}"(x)`, creator);
      await assert.rejects(execute(`ALTER TABLE "${name}" ADD COLUMN y`, creator === 'alpha' ? 'beta' : 'alpha'), /authorized/);
      await execute(`ALTER TABLE "${name}" ADD COLUMN y`, creator);
    }
    const named = (await prepareData(db, dataRequest('list', {}), null, AbortSignal.timeout(5000), true)).result.tables as any[];
    assert.equal(named.length, 7);
    for (const table of named.filter(table => table.name !== 'renamed')) await execute(`DROP TABLE "${table.name}"`, table.owner);
    for (const sql of ["ATTACH DATABASE '/tmp/briefsip-forbidden.sqlite' AS other", "VACUUM INTO '/tmp/briefsip-forbidden.sqlite'", 'PRAGMA writable_schema=ON', 'SELECT * FROM briefsip_owners', 'DELETE FROM briefsip_owners', 'DROP TABLE briefsip_owners', 'ALTER TABLE briefsip_owners RENAME TO hacked', 'CREATE TABLE briefsip_hidden(x)', 'CREATE TEMP TABLE temp_data(x)', 'CREATE VIEW view_data AS SELECT * FROM renamed', 'CREATE TRIGGER trigger_data AFTER INSERT ON renamed BEGIN DELETE FROM renamed; END', "SELECT load_extension('/tmp/not-an-extension')", 'BEGIN', 'CREATE VIRTUAL TABLE search USING fts5(text)']) await assert.rejects(execute(sql), /authorized|prohibited|attached|transaction/i, sql);
    await assert.rejects(execute('INSERT INTO renamed(text) VALUES (\'no\')', 'alpha', [], true), /authorized|prohibited/i);
    const large = await execute('SELECT 9223372036854775807 AS exact, x\'00ff\' AS bytes');
    assert.deepEqual(large.rows, [[{ integer: '9223372036854775807' }, { base64: 'AP8=' }]]);
    const oldRevision = (await execute('SELECT * FROM renamed')).revision;
    const one = await prepareData(db, dataRequest('query', { sql: "INSERT INTO renamed(text) VALUES ('one')" }), 'beta', AbortSignal.timeout(5000));
    const two = await prepareData(db, dataRequest('query', { sql: "INSERT INTO renamed(text) VALUES ('two')" }), 'beta', AbortSignal.timeout(5000));
    assert.equal(commitData(db, one).revision, oldRevision + 1); assert.throws(() => commitData(db, two), /Data changed/);
    assert.deepEqual((await execute('SELECT text FROM renamed ORDER BY id')).rows, [['shared'], ['one']]);
    await assert.rejects(execute("INSERT INTO renamed(text) VALUES (hex(zeroblob(100000))) RETURNING text"), /128 KiB/);
    assert.equal((await execute('SELECT count(*) FROM renamed')).rows[0][0], 2);
    const started = Date.now(); await assert.rejects(execute('WITH RECURSIVE forever(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM forever) SELECT sum(n) FROM forever'), /interrupted|timed out|resource/); assert(Date.now() - started < 5000);
    assert.throws(() => dataRequest('query', { sql: 'SELECT ?', parameters: [Number.MAX_SAFE_INTEGER + 1] }), /parameters/);
    await assert.rejects(execute('SELECT 1; DELETE FROM renamed'), /one statement/);
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(prepareData(db, dataRequest('query', { sql: 'SELECT 1' }), 'alpha', aborted.signal), /cancelled/);
    const listing = await prepareData(db, dataRequest('list', {}), null, AbortSignal.timeout(5000), true);
    assert.deepEqual((listing.result.tables as any[]).map(row => [row.name, row.owner]), [['renamed', 'alpha']]);
    const dropped = await prepareData(db, dataRequest('drop', { table: 'renamed' }), null, AbortSignal.timeout(5000), false, true); commitData(db, dropped);
    assert.deepEqual((await prepareData(db, dataRequest('list', {}), null, AbortSignal.timeout(5000), true)).result.tables, []);
    for (let n = 0; n < 21; n++) await execute(`CREATE TABLE page_${String(n).padStart(2, '0')}("${'long_column_'.repeat(500)}" TEXT)`);
    const names: string[] = []; let after = '';
    do {
      const page = (await prepareData(db, dataRequest('list', { after }), null, AbortSignal.timeout(5000), true)).result;
      assert(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024);
      names.push(...(page.tables as any[]).map(row => row.name)); after = page.next_after as string;
    } while (after);
    assert.equal(names.length, 21); assert.equal(new Set(names).size, 21);
    const cancel = new AbortController();
    const slow = prepareData(db, dataRequest('query', { sql: 'WITH RECURSIVE forever(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM forever) SELECT sum(n) FROM forever' }), 'alpha', cancel.signal);
    setTimeout(() => cancel.abort(), 50); await assert.rejects(slow, /cancelled/);
  } finally { db.close(); }
});
