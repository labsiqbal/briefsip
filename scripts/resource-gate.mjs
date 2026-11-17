import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export async function measureRust(binary, budgets) {
  const budget = budgets.rust;
  for (const key of ['idleRssMiB', 'p95LatencyMs', 'warmupRequests', 'measuredRequests']) if (!Number.isFinite(budget?.[key]) || budget[key] <= 0) throw new Error(`Invalid Rust budget: ${key}`);
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-budget-'));
  const child = spawn(resolve(binary), ['--test-config'], { env: { ...process.env, BRIEFSIP_TEST_SERVER: 'rust' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(ready => child.once('close', () => ready()));
  let error = '', output = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { error = (error + value).slice(-4096); });
  child.stdout.setEncoding('utf8'); child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ database: join(directory, 'db.sqlite'), port: 0 }));
  try {
    const origin = await new Promise((ready, reject) => {
      const timeout = setTimeout(() => reject(new Error('Rust resource gate readiness timed out')), 10000);
      child.once('error', failure => { clearTimeout(timeout); reject(failure); });
      void closed.then(() => { clearTimeout(timeout); reject(new Error(`Rust resource gate exited: ${error}`)); });
      child.stdout.on('data', value => { output += value; const match = /^Briefsip: (http:\/\/[^\r\n]+)$/m.exec(output); if (match) { clearTimeout(timeout); ready(match[1]); } });
    });
    const request = async () => { const response = await fetch(origin + '/api/agents', { signal: AbortSignal.timeout(5000) }); if (response.status !== 200) throw new Error(`Rust workload returned ${response.status}`); const value = await response.json(); if (!Array.isArray(value.agents)) throw new Error('Rust workload returned an invalid body'); };
    for (let index = 0; index < budget.warmupRequests; index++) await request();
    const idleRssMiB = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1]) / 1024;
    if (!Number.isFinite(idleRssMiB)) throw new Error('Cannot read Rust RSS from /proc');
    const durations = [];
    for (let index = 0; index < budget.measuredRequests; index++) { const started = performance.now(); await request(); durations.push(performance.now() - started); }
    durations.sort((left, right) => left - right);
    const result = { idleRssMiB, p95LatencyMs: durations[Math.ceil(durations.length * 0.95) - 1], requests: durations.length };
    console.log(JSON.stringify({ rust: result, budget }));
    if (result.idleRssMiB > budget.idleRssMiB || result.p95LatencyMs > budget.p95LatencyMs) throw new Error('Rust resource budget exceeded');
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    try { await closed; } finally { clearTimeout(timeout); rmSync(directory, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await measureRust(process.argv[2], JSON.parse(readFileSync(process.argv[3] ?? new URL('./budgets.json', import.meta.url), 'utf8')));
}
