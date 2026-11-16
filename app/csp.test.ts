import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

test('SPA has a fresh matching style nonce while scripts, API and assets keep strict CSP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-csp-'));
  const app = await startApp({ database: join(dir, 'state.sqlite') });
  try {
    const nonces: string[] = [];
    let asset = '';
    for (const path of ['/', '/', '/agents/00000000-0000-4000-8000-000000000000', '/agents/00000000-0000-4000-8000-000000000000/conversations/00000000-0000-4000-8000-000000000001', '/rooms/deleted', '/projects/deleted', '/settings/appearance?from=%2Frooms%2Fdeleted']) {
      const response = await fetch(app.origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const csp = response.headers.get('content-security-policy')!;
      const styles = csp.split('; ').find(directive => directive.startsWith('style-src '))!;
      const matches = [...styles.matchAll(/'nonce-([^']+)'/g)];
      assert.equal(matches.length, 1);
      const nonce = matches[0][1];
      assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
      assert.equal(styles, `style-src 'self' 'nonce-${nonce}'`);
      assert.equal(csp.split('; ').find(directive => directive.startsWith('script-src ')), "script-src 'self'");
      assert.equal(csp, policy.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
      const html = await response.text();
      const tags = [...html.matchAll(/<meta name="csp-nonce" content="([^"]+)">/g)];
      assert.equal(tags.length, 1);
      assert.equal(tags[0][1], nonce);
      assert(html.indexOf(tags[0][0]) < html.indexOf('</head>'));
      nonces.push(nonce);
      asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)![1];
    }
    assert.equal(new Set(nonces).size, nonces.length);
    for (const path of ['/missing.txt', '/assets/missing.js', '/api/missing']) { const response = await fetch(app.origin + path); assert.equal(response.status, 404); await response.arrayBuffer(); }
    for (const path of ['/api/agents', asset]) {
      const response = await fetch(app.origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-security-policy'), policy);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.arrayBuffer();
    }
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
