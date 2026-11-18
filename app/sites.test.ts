import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('local sites retain URLs, isolate owners, reject stale writes and recover without resurrection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-sites-')), options = { database: join(directory, 'test.sqlite'), port: 0 };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' }, 201);
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' }, 201);
    const path = `/api/agents/${a.id}/sites`, other = `/api/agents/${b.id}/sites`;
    const command = { id: randomUUID(), name: 'Report', source: '<h1 style="color:red">One</h1><script>fetch("/api/agents")</script><meta http-equiv="refresh" content="0;url=https://example.com"><form action="/api/agents"><input></form><iframe src="/api/agents"></iframe><img src="https://example.com">' };
    const site = await request(path, command); assert.equal(site.revision, 1);
    assert.equal((await request(path, command)).id, site.id);
    assert.equal((await request(path)).sites.length, 1);
    const page = await fetch(`${app.origin}/sites/${site.id}`), html = await page.text();
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /sandbox/); assert.match(page.headers.get('content-security-policy')!, /script-src 'none'/);
    assert.match(html, /<h1 style="color:red">One<\/h1>/); assert.doesNotMatch(html, /fetch\(|http-equiv="refresh"|<form|<iframe|<img/);
    await request(`${other}/${site.id}`, undefined, 404); await request(other, command, 409);
    await request(other, { id: randomUUID(), site: site.id, revision: 1, delete: true }, 404);
    const edit = { id: randomUUID(), site: site.id, revision: 1, name: 'Two', source: '<p>Two</p>' };
    assert.equal((await request(path, edit)).revision, 2);
    await request(path, { ...edit, id: randomUUID() }, 409);
    assert.equal((await request(path, command)).revision, 2);
    const crossOrigin = await fetch(app.origin + path, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(edit) }); assert.equal(crossOrigin.status, 403);
    for (const bad of [null, [], { id: randomUUID(), source: 'x', name: '' }, { id: randomUUID(), source: 'x'.repeat(262145), name: 'Large' }, { id: randomUUID(), source: '界'.repeat(90000), name: 'Large' }, { ...edit, id: randomUUID(), revision: 0 }, { ...edit, id: randomUUID(), agent: b.id }, { id: randomUUID(), delete: true }]) await request(path, bad, 400);
    await app.close(); app = await startApp(options);
    assert.equal((await request(path, edit)).revision, 2);
    assert.match(await (await fetch(`${app.origin}/sites/${site.id}`)).text(), /<p>Two<\/p>/);
    const deletion = { id: randomUUID(), site: site.id, revision: 2, delete: true };
    assert.equal((await request(path, deletion)).deleted, 1);
    for (const prior of [command, edit, deletion]) assert.equal((await request(path, prior)).deleted, 1);
    assert.equal((await request(path)).sites.length, 0);
    assert.equal((await fetch(`${app.origin}/sites/${site.id}`)).status, 404);
    await request(path, { ...edit, id: randomUUID(), revision: 3 }, 410);
    for (let n = 0; n < 21; n++) await request(path, { id: randomUUID(), name: `Site ${n}`, source: '<p>Page</p>' });
    const first = await request(path), next = await request(`${path}?after=${first.next_after}`);
    assert.equal(first.sites.length, 20); assert.equal(next.sites.length, 1); assert.equal(new Set([...first.sites, ...next.sites].map(row => row.id)).size, 21);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
