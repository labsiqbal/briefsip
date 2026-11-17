import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startApp } from './server.ts';

test('core serves exact static bytes, strict asset CSP, HTML 404 and local boundary errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-core-static-'));
  const app = await startApp({ database: join(root, 'db.sqlite') });
  try {
    const page = await fetch(app.origin); const html = await page.text();
    assert.equal(page.status, 200); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const asset = html.match(/(?:src|href)="(\/assets\/[^" ]+)"/)?.[1]; assert(asset);
    const response = await fetch(app.origin + asset);
    const expected = await import('node:fs/promises').then(fs => fs.readFile(new URL('./dist' + asset, import.meta.url)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert(!response.headers.get('content-security-policy')!.includes('nonce-'));
    for (const path of ['/missing/path', '/rooms/deleted', '/settings/nope']) {
      const missing = await fetch(app.origin + path); assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type')!, /text\/html/); await missing.text();
    }
    const denied = await fetch(app.origin + '/api/agents', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'Access is only allowed through the local Briefsip address.' });
    const cookies = await fetch(app.origin + '/api/agents', { headers: { Cookie: '__session=untrusted' } });
    assert.equal(cookies.headers.get('set-cookie'), null); assert.equal(cookies.status, 200); await cookies.text();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('core SSE wire format replays persisted snapshots, isolates scopes and closes on shutdown', { timeout: 15000, skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-core-events-')), database = join(root, 'db.sqlite');
  let app = await startApp({ database });
  await app.close();
  const db = new DatabaseSync(database), agent = randomUUID(), other = randomUUID(), turn = randomUUID();
  db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES(?,?,?,?)').run(agent, 'Fixture', 'fixture', 'Help');
  db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES(?,?,?,?)').run(other, 'Other', 'fixture', 'Help');
  db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES(?,?,?,'queued',?)").run(turn, agent, 'Fixture', new Date().toISOString());
  const call = db.prepare("INSERT INTO provider_calls(turn,agent,model,origin,purpose,status,created) VALUES(?,?,?,'test','completion','received',?)").run(turn, agent, 'fixture', new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO provider_streams VALUES(?,?)').run(call, 'Saved answer');
  db.prepare("INSERT INTO provider_stream_segments VALUES(?,0,'text-0','text',?,'',1,3)").run(call, 'Saved answer'); db.close();
  app = await startApp({ database });
  const controller = new AbortController();
  try {
    const active = new DatabaseSync(database); active.prepare("UPDATE turns SET status='running' WHERE id=?").run(turn); active.close();
    const path = `/api/agents/${agent}/turns/stream`;
    for (const [suffix, headers, status] of [['?q=x', {}, 400], ['', { Origin: 'https://foreign.example' }, 403], ['', { Authorization: 'Bearer fixture' }, 403]] as const) {
      const response = await fetch(app.origin + path + suffix, { headers }); assert.equal(response.status, status); await response.text();
    }
    const missing = await fetch(app.origin + `/api/agents/${randomUUID()}/turns/stream`); assert.equal(missing.status, 404); await missing.text();
    const stream = await fetch(app.origin + path, { signal: controller.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream'); assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform'); assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    const reader = stream.body!.getReader(), frame = await reader.read();
    assert.equal(Buffer.from(frame.value!).toString(), `data: ${JSON.stringify({ id: turn, partial: { seq: Number(call), text: 'Saved answer', model: 'fixture', status: 'received', segment: 'text-0', revision: 3, final: true } })}\n\n`);
    const isolated = await fetch(app.origin + `/api/agents/${other}/turns/stream`, { signal: controller.signal });
    const otherReader = isolated.body!.getReader(), pending = otherReader.read();
    assert.equal(await Promise.race([pending.then(() => 'unexpected snapshot'), new Promise(resolve => setTimeout(() => resolve('quiet'), 80))]), 'quiet');
    const writer = new DatabaseSync(database); writer.prepare('UPDATE provider_streams SET text=? WHERE call=?').run('Latest answer', call); writer.prepare('UPDATE provider_stream_segments SET text=?,revision=4 WHERE call=?').run('Latest answer',call); writer.close();
    const notify = await fetch(app.origin + `/api/agents/${agent}/visibility`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), revision: 0, hidden: false }) });
    assert.equal(notify.status, 200); await notify.text();
    const changed = await reader.read(); assert.equal(JSON.parse(Buffer.from(changed.value!).toString().slice(6)).partial.text, 'Latest answer');
    for (const [index, write] of [
      { path: `/api/agents/${agent}/files/${randomUUID()}`, type: 'application/octet-stream', body: 'file change' },
      { path: `/api/agents/${agent}/sites`, type: 'application/json', body: JSON.stringify({ id: randomUUID(), name: 'Fixture', source: '<p>Fixture</p>' }) },
      { path: '/api/skills', type: 'application/json', body: JSON.stringify({ id: randomUUID(), revision: 0, name: 'Fixture', description: 'Fixture', content: 'Fixture' }) },
    ].entries()) {
      const revision = index + 5, text = `File lane commit ${revision}`, external = new DatabaseSync(database);
      external.prepare('UPDATE provider_streams SET text=? WHERE call=?').run(text, call);
      external.prepare('UPDATE provider_stream_segments SET text=?,revision=? WHERE call=?').run(text, revision, call); external.close();
      const next = reader.read();
      assert.equal(await Promise.race([next.then(() => 'polled'), new Promise(resolve => setTimeout(() => resolve('quiet'), 80))]), 'quiet');
      const response = await fetch(app.origin + write.path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': write.type, 'X-File-Name': 'fixture.txt' }, body: write.body });
      assert.equal(response.status, 200, await response.text());
      const frame = await next; assert.equal(JSON.parse(Buffer.from(frame.value!).toString().slice(6)).partial.text, text);
    }
    const reconnected = await fetch(app.origin + path, { signal: controller.signal }), reconnectReader = reconnected.body!.getReader();
    const repaired = await reconnectReader.read(); assert.equal(JSON.parse(Buffer.from(repaired.value!).toString().slice(6)).partial.revision,7);
    await app.close(); assert.equal((await reader.read()).done, true);
    assert.equal((await pending).done,true); assert.equal((await reconnectReader.read()).done,true);
  } finally { controller.abort(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Rust test bridge rejects unported options before starting a process', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-core-unported-'));
  try {
    await assert.rejects(startApp({ database: join(root, 'db.sqlite'), scriptToken: 'fixture' }), /not ported: option scriptToken.*PORTING/);
    for (const concurrency of [NaN, Infinity, 0, 33]) await assert.rejects(startApp({ database: join(root, `db-${String(concurrency)}.sqlite`), concurrency }), /BRIEFSIP_CONCURRENCY must be 1\.\.32/);
    assert(!existsSync(join(root, 'db.sqlite')));
  }
  finally { rmSync(root, { recursive: true, force: true }); }
});
