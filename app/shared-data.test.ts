import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('Rust shared SQL keeps schema ownership, host restrictions and bounded results', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-shared-sql-'));
  let args: { sql: string; parameters: unknown[] } = { sql: '', parameters: [] };
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const result = body.messages.findLast((message: { role: string }) => message.role === 'tool');
    const call = {
      id: 'sql', type: 'function',
      function: { name: 'query_data', arguments: JSON.stringify(args) },
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{
      finish_reason: result ? 'stop' : 'tool_calls',
      message: result ? { content: result.content } : { tool_calls: [call] },
    }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const app = await startApp({
    database: join(dir, 'state.sqlite'),
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  }).catch(error => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  });
  t.after(async () => {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(path: string) {
    const response = await fetch(app.origin + path);
    assert(response.ok, await (response.ok ? Promise.resolve('') : response.text()));
    return response.json();
  }
  async function post(path: string, body: unknown, status: number) {
    const response = await fetch(app.origin + path, {
      method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function agent(name: string): Promise<string> {
    const row = await post('/api/agents', { id: randomUUID(), runtime: 'api', name, model: 'fixture', instructions: 'Run SQL' }, 201);
    return row.id;
  }
  const alpha = await agent('Alpha'), beta = await agent('Beta');
  const execute = async (sql: string, owner = alpha, parameters: unknown[] = []) => {
    args = { sql, parameters };
    const path = `/api/agents/${owner}/turns`, id = randomUUID();
    await post(path, { id, text: 'Run shared query' }, 202);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const result = (await get(path)).find((row: { id: string }) => row.id === id);
      if (result?.status === 'done') {
        const value = JSON.parse(result.reply);
        if (value.error) throw new Error(value.error);
        return value;
      }
      if (result?.status === 'failed') assert.fail(JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('Shared SQL turn did not finish: ' + sql);
  };
  const list = async (after = '') => get('/api/data?after=' + encodeURIComponent(after));

  await execute('CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)');
  await execute('INSERT INTO notes(text) VALUES (?)', beta, ['shared']);
  await assert.rejects(execute('ALTER TABLE notes RENAME TO briefsip_hidden'), /Table name is protected or exceeds 128 characters\./);
  await assert.rejects(execute('ALTER TABLE notes RENAME TO "' + 'n'.repeat(129) + '"'), /128/);
  assert.deepEqual((await execute('SELECT * FROM notes', beta)).rows, [[1, 'shared']]);
  for (const sql of ['DROP TABLE notes', 'ALTER TABLE notes ADD COLUMN private TEXT', 'CREATE INDEX bad_index ON notes(text)']) {
    await assert.rejects(execute(sql, beta), /authorized|prohibited/i);
  }
  await execute('ALTER TABLE notes ADD COLUMN n INTEGER');
  await execute('ALTER TABLE notes RENAME TO renamed');
  await assert.rejects(execute('DROP TABLE renamed', beta), /authorized|prohibited/i);
  await execute('CREATE INDEX note_index ON renamed(text)');
  await assert.rejects(execute('DROP INDEX note_index', beta), /authorized|prohibited/i);
  await execute('DROP INDEX note_index');

  for (const [name, owner, other] of [
    ['briefsipXnotes', beta, alpha], ['sqliteXnotes', beta, alpha],
    ['É', alpha, beta], ['é', beta, alpha], ['k', alpha, beta], ['K', beta, alpha],
  ]) {
    await execute(`CREATE TABLE "${name}"(x)`, owner);
    await assert.rejects(execute(`ALTER TABLE "${name}" ADD COLUMN y`, other), /authorized/);
    await execute(`ALTER TABLE "${name}" ADD COLUMN y`, owner);
  }
  const named: { name: string; owner: string }[] = (await list()).tables;
  assert.equal(named.length, 7);
  for (const table of named.filter(row => row.name !== 'renamed')) await execute(`DROP TABLE "${table.name}"`, table.owner);

  for (const sql of [
    "ATTACH DATABASE ':memory:' AS other", "VACUUM INTO '/dev/null'", 'PRAGMA writable_schema=ON',
    'SELECT * FROM briefsip_owners', 'DELETE FROM briefsip_owners', 'DROP TABLE briefsip_owners',
    'ALTER TABLE briefsip_owners RENAME TO blocked', 'CREATE TABLE briefsip_hidden(x)',
    'CREATE TEMP TABLE temp_data(x)', 'CREATE VIEW view_data AS SELECT * FROM renamed',
    'CREATE TRIGGER trigger_data AFTER INSERT ON renamed BEGIN DELETE FROM renamed; END',
    "SELECT load_extension('/tmp/not-an-extension')", 'BEGIN', 'CREATE VIRTUAL TABLE search USING fts5(text)',
  ]) await assert.rejects(execute(sql), /authorized|prohibited|attached|transaction/i, sql);
  const readonly = await post('/api/data/query', { id: randomUUID(), revision: (await list()).revision, sql: "INSERT INTO renamed(text) VALUES ('no')" }, 400);
  assert.match(readonly.error, /authorized|prohibited/i);
  const large = await execute("SELECT 9223372036854775807 AS exact, x'00ff' AS bytes");
  assert.deepEqual(large.rows, [[{ integer: '9223372036854775807' }, { base64: 'AP8=' }]]);
  await assert.rejects(execute("INSERT INTO renamed(text) VALUES (hex(zeroblob(100000))) RETURNING text"), /128 KiB/);
  assert.deepEqual((await execute('SELECT text FROM renamed ORDER BY id')).rows, [['shared']]);
  assert.equal((await list()).revision, large.revision);
  const started = performance.now();
  await assert.rejects(execute('WITH RECURSIVE count(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM count) SELECT sum(n) FROM count'), /interrupted|timed out|resource/);
  assert(performance.now() - started < 5000);
  await assert.rejects(execute('SELECT ?', alpha, [Number.MAX_SAFE_INTEGER + 1]), /parameters/);
  await assert.rejects(execute('SELECT 1; DELETE FROM renamed'), /one statement/);
  const listing = await list();
  assert.deepEqual(listing.tables.map((row: { name: string; owner: string }) => [row.name, row.owner]), [['renamed', alpha]]);
  await post('/api/data/drop', { id: randomUUID(), revision: listing.revision, table: 'renamed' }, 200);
  assert.deepEqual((await list()).tables, []);

  const expected = Array.from({ length: 21 }, (_, n) => 'page_' + String(n).padStart(2, '0'));
  for (const name of expected) await execute(`CREATE TABLE ${name}("${'long_column_'.repeat(500)}" TEXT)`);
  const names: string[] = [];
  let after = '';
  do {
    const page = await list(after);
    assert(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024);
    names.push(...page.tables.map((row: { name: string }) => row.name));
    after = page.next_after;
  } while (after);
  assert.deepEqual(names, expected);
});
