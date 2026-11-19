import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileManifest } from './release-lib.mjs';
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
export async function measureRustLauncher(binary, server, budgets) {
  const budget = budgets.rustLauncher;
  if (!Number.isFinite(budget?.idleRssMiB) || budget.idleRssMiB <= 0) throw new Error('Invalid Rust launcher budget: idleRssMiB');
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-launcher-budget-'));
  const releases = join(directory, 'releases'), id = '1.0.0-00000000', release = join(releases, id);
  let child, closed;
  try {
    const socket = createServer();
    await new Promise((ready, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', ready); });
    const port = socket.address().port;
    await new Promise(ready => socket.close(ready));
    mkdirSync(release, { recursive: true });
    mkdirSync(join(release, 'bin'));
    cpSync(resolve(server), join(release, 'bin/briefsip-server'));
    writeFileSync(join(release, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
    writeFileSync(join(release, 'release.json'), JSON.stringify({ id, version: '1.0.0', files: fileManifest(release) }));
    symlinkSync(id, join(releases, 'current'));
    const config = join(directory, 'launcher.json');
    writeFileSync(config, JSON.stringify({ dataDir: join(directory, 'data'), releasesDir: releases, port }), { mode: 0o600 });
    child = spawn(resolve(binary), ['--config', config], { stdio: ['ignore', 'ignore', 'pipe'] });
    closed = new Promise(ready => child.once('close', ready));
    // Warnings on stderr are kept for the error message; only exit or spawn failure ends the gate.
    let stderr = '', failure = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr = (stderr + value).slice(-4096); });
    child.once('error', error => { failure = error.message; });
    const deadline = performance.now() + 10000;
    let ready = false;
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || failure) throw new Error(`Rust launcher gate exited: ${failure || stderr}`);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/environment`, { signal: AbortSignal.timeout(500) }); ready = response.ok && (await response.json()).version === '1.0.0'; } catch {}
      if (ready) break;
      await new Promise(done => setTimeout(done, 50));
    }
    if (!ready) throw new Error(`Rust launcher gate readiness timed out${stderr ? `: ${stderr}` : ''}`);
    await new Promise(done => setTimeout(done, 200));
    const idleRssMiB = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1]) / 1024;
    if (!Number.isFinite(idleRssMiB)) throw new Error('Cannot read Rust launcher RSS from /proc');
    const result = { idleRssMiB };
    console.log(JSON.stringify({ rustLauncher: result, budget }));
    if (idleRssMiB > budget.idleRssMiB) throw new Error('Rust launcher resource budget exceeded');
    return result;
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[4]) throw new Error('Rust launcher binary is required by the resource gate');
  const budgets = JSON.parse(readFileSync(process.argv[3] ?? new URL('./budgets.json', import.meta.url), 'utf8'));
  await measureRustLauncher(process.argv[4], process.argv[2], budgets);
  await measureRust(process.argv[2], budgets);
}
