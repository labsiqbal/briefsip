// Opt-in latency regression check against the recorded JPEG/SSE baseline.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startApp } from '../test-bridge.ts';
import { connectVnc } from './agent-desktop-test-client.ts';

async function until(check: () => boolean) { for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Benchmark screen did not change.'); }
async function sample(send: () => void | Promise<unknown>, state: { frames: number; marker: number; changed: number }) {
  await until(() => state.frames > 0);
  const latency: number[] = [], input: number[] = [];
  for (let i = 0; i < 10; i++) {
    const previous = state.marker, started = performance.now(); await send(); input.push(performance.now() - started);
    await until(() => state.marker !== previous); latency.push(state.changed - started);
    await new Promise(resolve => setTimeout(resolve, 37));
  }
  const before = state.frames, started = performance.now(); await new Promise(resolve => setTimeout(resolve, 3000));
  const sorted = latency.toSorted((a, b) => a - b);
  return { samples: latency.map(value => Math.round(value * 10) / 10), medianMs: Math.round(sorted[5] * 10) / 10, p95Ms: Math.round(sorted[9] * 10) / 10, inputRoundTripMs: Math.round(input.reduce((sum, value) => sum + value, 0) / input.length * 10) / 10, fps: Math.round((state.frames - before) * 10000 / (performance.now() - started)) / 10 };
}
export async function benchmarkDesktop() {
  const baseline = JSON.parse(readFileSync(new URL('../../work/rebuild/agent-computer/performance.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-bench-'));
  let loaded = false;
  const fixture = createServer((req, res) => {
    if (req.url === '/loaded') loaded = true;
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Desktop latency fixture</title><body style="margin:0;background:#dedee8"><div id="marker" style="position:fixed;left:0;top:0;width:64px;height:64px;background:white"></div><div id="tick" style="position:fixed;left:80px;top:0;width:64px;height:64px"></div><script>let color=false,frame=0;document.addEventListener("keydown",e=>{if(e.key==="a"){color=!color;marker.style.background=color?"black":"white"}});setInterval(()=>tick.style.background="rgb("+((++frame*37)%255)+",80,120)",33);fetch("/loaded")</script>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve)); const address = fixture.address(); assert(address && typeof address !== 'string');
  const target = { hostname: 'benchmark.example.test', port: address.port }, agent = randomUUID(), url = `http://${target.hostname}:${target.port}/`;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database: join(dir,'after.sqlite'), desktop: { dataDir: join(dir,'after'), leaseDir: join(dir,'leases-after'), enabled: true, testOnlyProxyTarget: target } });
    const path = `/api/agents/${agent}/computer`;
    const post = async (path: string, data: unknown) => { const res = await fetch(app!.origin + path, { method: 'POST', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); assert(res.ok, await res.clone().text()); return res.json(); };
    await post('/api/agents', { id: agent, name: 'Latency fixture', model: 'fixture', instructions: 'Test only.' }); await post(path, { id: randomUUID(), revision: 0, enabled: true }); await post(path + '/start', {}); await post(path + '/control', { id: randomUUID(), revision: 0, operation: 'take' });
    const input = (name: string, args: unknown) => post(path + '/input', { revision: 1, name, args });
    loaded = false; await input('computer_key', { keys: ['Control_L','l'] }); await input('computer_type', { text: url }); await input('computer_key', { keys: ['Return'] }); await until(() => loaded); await input('computer_key', { keys: ['F11'] }); await new Promise(resolve => setTimeout(resolve, 500));
    const ticket = await post(path + '/vnc-ticket', { mode: 'control', revision: 1 }), client = await connectVnc(app.origin + path + '/vnc?ticket=' + ticket.ticket, app.origin);
    const next = { frames: 0, marker: -1, changed: 0 }; let done = false;
    try {
      await client.handshake(); client.requestFrame(false);
      const receive = (async () => { try { while (!done) { const frame = await client.frame(); const marker = frame[(10 * client.width + 10) * 4] > 128 ? 1 : 0; if (marker !== next.marker) { next.changed = performance.now(); next.marker = marker; } next.frames++; client.requestFrame(); } } catch (error) { if (!done) throw error; } })();
      const after = await sample(() => { client.key(97, true); client.key(97, false); }, next);
      done = true; client.close(); await receive;
      assert(after.fps > baseline.before.fps, JSON.stringify(after)); assert(after.medianMs < baseline.before.medianMs, JSON.stringify(after));
      return { baseline: baseline.baseline, before: baseline.before, after };
    } finally { done = true; client.close(); }
  } finally { await app?.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}
