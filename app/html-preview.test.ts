import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlPreview, previewPolicy } from './html-preview.ts';
import { startApp } from './test-bridge.ts';

test('HTML preview removes active content and resource URLs while retaining native details and layout', () => {
  const payload = `<!doctype html><html><head><base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example"><style>@import 'https://evil.example/a';</style></head><body onload="alert(1)">
    <script>window.parent.fetch('/api/agents')</script><iframe srcdoc="<script>alert(1)</script>"></iframe>
    <object data="https://evil.example"></object><embed src="https://evil.example"><svg><a href="https://evil.example"><text>evil</text></a></svg><math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>
    <img src="https://evil.example" srcset="https://evil.example"><video poster="https://evil.example"><source src="https://evil.example"></video>
    <form action="/api/agents"><input name="name"><button formaction="https://evil.example">Submit</button></form>
    <a href="javascript:alert(1)" ping="https://evil.example" target="_top">Readable link text</a>
    <details open><summary onclick="alert(1)">Expand me</summary><p style="color:#123456; padding:12px; background-image:url(https://evil.example); position:fixed; font-family:evil">Useful text</p></details>
    <table><tr><th scope="col">Name</th><td colspan="2">Value</td></tr></table></body></html>`;
  const output = htmlPreview('Report.HTML', Buffer.from(payload));
  assert(output.includes(previewPolicy)); assert.match(output, /<details open><summary>Expand me<\/summary>/); assert.match(output, /color:#123456;padding:12px/);
  assert.match(output, /<th scope="col">Name<\/th>/); assert.match(output, /Readable link text/);
  assert.doesNotMatch(output, /evil\.example|window\.parent|alert\(1\)|background-image|position:fixed|font-family:evil/);
  assert.doesNotMatch(output, /<(?:script|iframe|object|embed|svg|math|form|input|button|img|video|source|a|base)\b/i);
  assert.doesNotMatch(output, /\s(?:on\w+|href|src|srcdoc|srcset|formaction|action|ping|target)=/i);
  for (const malicious of [
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">test',
    '<p style="color:expression(alert(1));width:calc(1px + url(x));padding:var(--x);background-color:u\\72l(x)">x</p>',
    '<template><img src=x onerror=alert(1)></template>',
  ]) {
    const safe = htmlPreview('x.htm', Buffer.from(malicious));
    assert.doesNotMatch(safe, /<(?:script|img|svg|math|template)\b|expression\(|url\(/i);
  }
  assert.throws(() => htmlPreview('x.txt', Buffer.from('text')));
  assert.throws(() => htmlPreview('x.html', Buffer.from([0xff])));
  assert.throws(() => htmlPreview('x.html', Buffer.alloc(256 * 1024 + 1)));
});

test('preview endpoint preserves file bytes and enforces direct/channel/thread scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-html-'));
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
