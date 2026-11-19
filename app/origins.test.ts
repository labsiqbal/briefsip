import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from './test-bridge.ts';

function call(origin: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: payload ? 'POST' : 'GET', headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject); req.end(payload);
  });
}

const tailnet = 'https://briefsip.example.test:4317';
const agent = () => ({ id: randomUUID(), name: 'Origin check', model: 'test-model', instructions: 'Check origins.', threadLimit: 2 });

test('extra browser origins are denied unless explicitly configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-origins-'));
  const app = await startApp({ database: join(dir, 'state.sqlite') });
  try {
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: 'briefsip.example.test:4317' })).status, 403);
    const loopbackHost = new URL(app.origin).host;
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: loopbackHost, Origin: tailnet }, agent())).status, 403);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: loopbackHost, Origin: app.origin }, agent())).status, 201);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a configured https origin is accepted for host and writes while other origins stay denied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-origins-'));
  const app = await startApp({ database: join(dir, 'state.sqlite'), allowedOrigins: [tailnet] });
  try {
    const host = 'briefsip.example.test:4317';
    const read = await call(app.origin, '/api/agents', { runtime: 'api', Host: host });
    assert.equal(read.status, 200);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: host, Origin: tailnet }, agent())).status, 201);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: host, Origin: 'https://evil.example.test:4317' }, agent())).status, 403);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: host, Origin: 'http://briefsip.example.test:4317' }, agent())).status, 403);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: 'other.example.test:4317' })).status, 403);
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: host, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const loopbackHost = new URL(app.origin).host;
    assert.equal((await call(app.origin, '/api/agents', { runtime: 'api', Host: loopbackHost, Origin: app.origin }, agent())).status, 201);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
