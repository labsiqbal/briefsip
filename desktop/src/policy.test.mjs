import test from 'node:test';
import assert from 'node:assert/strict';
import { canGrantPermission, canNotify, isAllowedExternal, isAllowedNavigation, parseServerUrl, trustedSender, validateServer } from './policy.mjs';

test('server URL validation permits HTTPS or loopback HTTP, rejects unsafe and ambiguous URLs', () => {
  for (const url of ['https://nuc.example.test:4317', 'http://localhost:4317', 'http://127.0.0.1:4317', 'http://[::1]:4317']) assert.ok(parseServerUrl(url));
  for (const url of ['', null, 'not a URL', 'file:///tmp/x', 'javascript:alert(1)', 'http://nuc.example.test', 'http://localhost.evil.test', 'https://user:pass@nuc.test', 'https://x.test/?token=x', 'https://x.test/#foo', 'https://x.test/api']) assert.throws(() => parseServerUrl(url));
});
test('navigation requires exact protocol and host, external opening requires HTTP(S)', () => {
  const server = 'https://nuc.example.test:4317/';
  assert.equal(isAllowedNavigation(`${server}chat?id=1`, server), true);
  for (const url of ['https://other.test', 'http://nuc.example.test:4317', 'https://nuc.example.test:4318', 'https://nuc.example.test:4317.evil.test', 'blob:https://nuc.example.test:4317/abc', 'file:///etc/passwd']) assert.equal(isAllowedNavigation(url, server), false, url);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', null, {}]) assert.equal(isAllowedExternal(url), false);
  assert.equal(isAllowedExternal('https://other.test/'), true);
  assert.equal(canNotify('notifications', server, server), true);
  assert.equal(canNotify('camera', server, server), false);
  assert.equal(canNotify('notifications', 'https://nuc.example.test:4317.evil.test', server), false);
});
test('IPC permits configured main frame or exact bundled page only', () => {
  const mainFrame = { url: 'https://nuc.example.test:4317/chat', origin: 'https://nuc.example.test:4317' };
  const contents = { mainFrame };
  const event = { sender: contents, senderFrame: mainFrame };
  const local = 'file:///app/connect.html';
  assert.equal(trustedSender(event, contents, mainFrame.origin, local), true);
  assert.equal(trustedSender({ ...event, senderFrame: { ...mainFrame } }, contents, mainFrame.origin, local), false);
  mainFrame.url = `${local}?error=offline`; assert.equal(trustedSender(event, contents, null, local), true);
  mainFrame.url = 'file:///app/evil.html'; assert.equal(trustedSender(event, contents, null, local), false);
  assert.equal(trustedSender({ ...event, senderFrame: null }, contents, null, local), false);
});
test('validation falls back from missing environment endpoint to identified Minarbot HTML', async () => {
  const seen = [];
  assert.equal(await validateServer('http://127.0.0.1:4317', async (url, options) => {
    seen.push(url); assert.equal(options.redirect, 'manual');
    return url.endsWith('/api/environment') ? new Response('', { status: 404 }) : new Response('<title>Minarbot</title>', { headers: { 'content-type': 'text/html' } });
  }), 'http://127.0.0.1:4317/');
  assert.deepEqual(seen, ['http://127.0.0.1:4317/api/environment', 'http://127.0.0.1:4317/']);
});
test('validation accepts environment metadata, rejects redirects, wrong app, HTTP errors', async () => {
  assert.equal(await validateServer('https://nuc.test', async () => Response.json({ environmentId: 'nuc' })), 'https://nuc.test/');
  await assert.rejects(validateServer('https://nuc.test', async () => new Response('', { status: 302 })), /redirected/);
  await assert.rejects(validateServer('https://nuc.test', async () => new Response('', { status: 403 })), /403/);
  await assert.rejects(validateServer('https://nuc.test', async (url) => url.endsWith('/api/environment') ? new Response('', { status: 404 }) : new Response('<title>Other</title>', { headers: { 'content-type': 'text/html' } })), /Minarbot app/);
});

test('validation bounds identity responses from untrusted servers', async () => {
  await assert.rejects(validateServer('https://nuc.test', async () => new Response('x'.repeat(512 * 1024 + 1))), /exceeds 512 KiB/);
});

test('clipboard grants require configured origin and main frame; other permissions stay denied', () => {
  const server = 'https://nuc.example.test:4317/';
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications']) {
    assert.equal(canGrantPermission(permission, server, server, { isMainFrame: true }), true);
    for (const details of [{ isMainFrame: false }, {}, undefined]) assert.equal(canGrantPermission(permission, server, server, details), false);
    for (const url of ['https://other.test', 'https://nuc.example.test:4318', 'http://nuc.example.test:4317', 'file:///app/connect.html', 'about:blank', undefined]) assert.equal(canGrantPermission(permission, url, server, { isMainFrame: true }), false);
    assert.equal(canGrantPermission(permission, server, null, { isMainFrame: true }), false);
  }
  for (const permission of ['camera', 'media', 'geolocation', 'clipboard-write', 'deprecated-sync-clipboard-read', 'unknown']) assert.equal(canGrantPermission(permission, server, server, { isMainFrame: true }), false);
});
