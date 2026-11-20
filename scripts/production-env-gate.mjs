import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileManifest } from './release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function newestSnapshot() {
  const updates = ['minarbot', 'briefsip'].map(product => join(homedir(), '.local/share', product, 'test-20261114/data/.updates'))
    .find(existsSync);
  if (!updates) throw new Error('Production env gate requires a launcher DB snapshot.');
  const files = readdirSync(updates).flatMap(name => ['minarbot.sqlite', 'briefsip.sqlite'].map(filename => join(updates, name, filename))).filter(existsSync);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error('Production env gate requires a launcher DB snapshot.');
  return files[0];
}

export { freePort } from './test-port.mjs';

export async function stop(child, closed) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 8000);
  try { await closed; } finally { clearTimeout(timer); }
}

export async function healthy(child, port, version) {
  let failure = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { failure = (failure + value).slice(-4096); });
  child.once('error', error => { failure = error.message; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Production env startup exited: ${failure}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/environment`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).version === version) return;
    } catch {}
    await new Promise(ready => setTimeout(ready, 50));
  }
  throw new Error(`Production env startup timed out: ${failure}`);
}

function isolateCopy(database) {
  const db = new DatabaseSync(database);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    // Copied jobs and peers cannot run or contact live systems during startup checks.
    for (const [table, sql] of [
      ['turns', "UPDATE turns SET status='cancelled',paused=1 WHERE status NOT IN('done','cancelled')"],
      ['routines', 'UPDATE routines SET enabled=0'],
      ['workflow_runs', "UPDATE workflow_runs SET status='cancelled' WHERE status NOT IN('done','failed','cancelled')"],
      ['flow_steps', "UPDATE flow_steps SET status='skipped' WHERE status IN('waiting','queued')"],
      ['remote_agent_calls', "UPDATE remote_agent_calls SET state='result',cancel_sent=1"],
      ['paired_machines', "UPDATE paired_machines SET state='revoked'"],
    ]) if (tables.has(table)) db.exec(sql);
  } finally { db.close(); }
}

export async function productionEnvGate(server = join(root, 'target/release/minarbot-server'), launcher = join(root, 'target/release/minarbot-launcher'), snapshot = newestSnapshot()) {
  const directory = mkdtempSync('/dev/shm/b102-'); chmodSync(directory, 0o700);
  const version = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8')).version;
  const releases = join(directory, 'releases'), id = `${version}-00000000`, release = join(releases, id);
  try {
    mkdirSync(join(release, 'bin'), { recursive: true, mode: 0o700 });
    cpSync(server, join(release, 'bin/minarbot-server')); chmodSync(join(release, 'bin/minarbot-server'), 0o700);
    writeFileSync(join(release, 'package.json'), JSON.stringify({ version, type: 'module' }));
    writeFileSync(join(release, 'release.json'), JSON.stringify({ id, version, files: fileManifest(release) }));
    symlinkSync(id, join(releases, 'current'));
    for (const shape of ['NUC', 'omarchy']) {
      const home = join(directory, shape), data = join(home, 'data'), workspace = join(home, 'workspace');
      mkdirSync(data, { recursive: true, mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
      const database = join(data, 'minarbot.sqlite'); cpSync(snapshot, database); chmodSync(database, 0o600); isolateCopy(database);
      const port = await freePort(), providerPort = await freePort();
      const workspaces = JSON.stringify([{ agent: '00000000-0000-4000-8000-000000000001', directory: workspace, write: true }]);
      const shared = { MINARBOT_ALLOWED_ORIGINS: 'https://minarbot.example.test:4317', MINARBOT_WORKSPACES: workspaces };
      const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: home };
      let envFile;
      if (shape === 'NUC') Object.assign(env, shared, { OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, OPENAI_API_KEY: 'dummy-production-gate', OPENAI_MODEL: 'fixture', MINARBOT_DATA_DIR: data, PORT: String(port), MINARBOT_STREAM: '1', MINARBOT_STREAM_TERMINATION: 'finish-reason', MINARBOT_AGENT_DESKTOP: '1' });
      else {
        envFile = join(home, 'launcher.env');
        writeFileSync(envFile, Object.entries({ ...shared, PATH: env.PATH }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
      }
      const config = join(home, 'launcher.json');
      writeFileSync(config, JSON.stringify({ dataDir: data, releasesDir: releases, port, ...(envFile ? { envFile } : {}) }), { mode: 0o600 });
      const child = spawn(resolve(launcher), ['--config', config], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      const closed = new Promise(ready => child.once('close', ready));
      let children = [];
      try {
        await healthy(child, port, version);
        const descendants = pid => {
          const path = `/proc/${pid}/task/${pid}/children`;
          const ids = existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean) : [];
          return ids.flatMap(id => [id, ...descendants(id)]);
        };
        children = descendants(child.pid);
        assert(children.length > 0, 'Launcher must own a running server');
        for (const pid of children) assert.match(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0], /minarbot-(?:server|launcher)$/);
        const desktops = join(data, 'agent-desktops');
        assert(!existsSync(desktops) || readdirSync(desktops).length === 0, 'Startup must not start desktops');
        console.log(`${shape} production env: health OK; no desktops started`);
      } finally {
        await stop(child, closed);
        for (const pid of children) assert(!existsSync(`/proc/${pid}`), 'Managed process survived launcher shutdown');
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await productionEnvGate(...process.argv.slice(2));
