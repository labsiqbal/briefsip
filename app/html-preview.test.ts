import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('preview endpoint preserves file bytes and enforces direct/channel/thread scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minarbot-html-'));
  const app = await startApp({ database: join(dir, 'db.sqlite') });
  async function post(path: string, body: unknown) {
    const res = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert(res.ok); return res.json();
  }
  try {
    const a = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' });
    const c = await post('/api/channels', { id: randomUUID(), name: 'C', instructions: 'Help', members: [a.id], lead: a.id });
    const t = await post(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const scopes = [`/api/agents/${a.id}/files`, `/api/channels/${c.id}/files`, `/api/threads/${t.id}/files`];
    const bytes = Buffer.from('<h1>Hello</h1><details><summary>Show</summary>Details</details><script>alert(1)</script>');
    for (const scope of scopes) {
      const id = randomUUID(), path = `${scope}/${id}`;
      const uploaded = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'report.html' }, body: bytes }); assert.equal(uploaded.status, 200);
      const preview = await fetch(app.origin + path + '?preview=html'); assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type')!, /application\/json/);
      const result = await preview.json(); assert.match(result.html, /<h1>Hello<\/h1>/); assert(!result.html.includes('alert(1)')); assert.equal(result.id, id);
      const rendered = await fetch(app.origin + path + '?preview=render'); assert.equal(rendered.status, 200); assert.match(rendered.headers.get('content-type')!, /text\/html/); assert.equal(await rendered.text(), result.html);
      assert.match(rendered.headers.get('content-security-policy')!, /sandbox; frame-ancestors 'self'/); assert.match(rendered.headers.get('content-security-policy')!, /script-src 'none'/); assert.match(rendered.headers.get('permissions-policy')!, /camera=\(\)/);
      const original = await fetch(app.origin + path); assert.match(original.headers.get('content-disposition')!, /^attachment/); assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      for (const other of scopes.filter(p => p !== scope)) assert.equal((await fetch(app.origin + `${other}/${id}?preview=html`)).status, 404);
      const rejected = await fetch(app.origin + path + '?preview=html', { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(rejected.status, 403);
    }
    for (const [name, bytes] of [['wrong.txt', Buffer.from('<h1>Text</h1>')], ['binary.html', Buffer.from([0xff])], ['large.html', Buffer.alloc(256 * 1024 + 1)]] as const) {
      const path = `${scopes[0]}/${randomUUID()}`;
      assert.equal((await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: bytes })).status, 200);
      assert.equal((await fetch(app.origin + path + '?preview=render')).status, 415);
      assert.equal((await fetch(app.origin + path + '?preview=html')).status, 415);
    }
    const home = await fetch(app.origin); assert.match(home.headers.get('content-security-policy')!, /frame-src 'self'/); assert.match(home.headers.get('content-security-policy')!, /script-src 'self'/);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
