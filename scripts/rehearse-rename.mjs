#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { durableWrite, fileManifest, selectRelease } from './release-lib.mjs';
import { stageBridgeAliases } from './rename-compat.mjs';
import { freePort, stop } from './production-env-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync('/tmp/mb-');
const home = join(scratch, 'h'), oldTree = join(scratch, 'old');
const legacy = join(home, '.local/share/briefsip'), current = join(home, '.local/share/minarbot');
const oldConfig = join(home, '.config/briefsip'), newConfig = join(home, '.config/minarbot');
const units = join(home, '.config/systemd/user');
const releases = join(legacy, 'releases'), data = join(legacy, 'data');
const legacyDb = join(data, 'briefsip.sqlite'), newDb = join(current, 'data/minarbot.sqlite');
const start = join(legacy, 'scripts/start.sh'), control = join(data, 'launcher.sock');
let child, closed, provider, worktree = false, log = '';

function buildBinaries(tree) {
  const target = join(scratch, 'build');
  const slot = join(process.env.HOME ?? '', '.cache/briefsip-cargo-slot.sh');
  const args = ['cargo', 'build', '--workspace', '--locked'];
  const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: '0', CARGO_BUILD_JOBS: '4' };
  if (existsSync(slot)) execFileSync(slot, ['env', 'CARGO_BUILD_JOBS=4', ...args], { cwd: tree, env, stdio: 'inherit' });
  else execFileSync(args[0], args.slice(1), { cwd: tree, env, stdio: 'inherit' });
  return join(target, 'debug');
}

function boot(command, args = []) {
  log = '';
  child = spawn(command, args, {
    env: { HOME: home, PATH: process.env.PATH, SHELL: '/bin/sh', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = once(child, 'exit');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-8000); });
}

async function down() {
  if (child) await stop(child, closed);
  child = undefined;
}

function seal(bin, version, commit, bridge, fail = false) {
  const id = version + '-' + commit.slice(0, 8), dir = join(releases, id);
  const destination = join(dir, 'bin'), name = bridge ? 'minarbot' : 'briefsip';
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const kind of ['server', 'launcher']) {
    const binary = join(destination, name + '-' + kind);
    copyFileSync(join(bin, name + '-' + kind), binary);
    chmodSync(binary, 0o700);
  }
  if (fail) {
    const server = join(destination, 'minarbot-server');
    copyFileSync(server, server + '.real');
    writeFileSync(join(dir, 'invalid-cert'), 'invalid PEM\n', { mode: 0o600 });
    rmSync(server);
    writeFileSync(server, '#!/bin/sh\nexport MINARBOT_TLS_CERT="$PWD/invalid-cert" MINARBOT_TLS_KEY="$PWD/invalid-cert"\nexec "$0.real" "$@"\n', { mode: 0o700 });
  }
  if (bridge) {
    stageBridgeAliases(destination);
    if (fail) copyFileSync(join(destination, 'minarbot-server.real'), join(destination, 'briefsip-server.real'));
  }
  durableWrite(join(dir, 'package.json'), JSON.stringify({ version }));
  const release = { id, commit, version, node: 'rust', notes: 'rename rehearsal', created: new Date().toISOString(), files: fileManifest(dir) };
  durableWrite(join(dir, 'release.json'), JSON.stringify(release));
  return release;
}

async function until(probe, description) {
  const deadline = Date.now() + 30_000;
  let failure;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) { failure = error; }
    if (child && (child.exitCode !== null || child.signalCode !== null)) break;
    await new Promise(ready => setTimeout(ready, 100));
  }
  throw new Error(`Timed out waiting for ${description}\n${log}`, { cause: failure });
}

function launcher(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(control);
    socket.once('error', reject);
    socket.setTimeout(3000, () => socket.destroy(new Error('Launcher did not respond')));
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    let response = '';
    socket.on('data', bytes => { response += bytes; });
    socket.on('end', () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
}

function decrypt(database, project, secret) {
  const databaseFile = new DatabaseSync(database, { readOnly: true });
  try {
    const { name, ciphertext } = databaseFile.prepare('SELECT name,ciphertext FROM project_environment WHERE project=?').get(project);
    const encrypted = Buffer.from(ciphertext, 'base64');
    const decoder = createDecipheriv('aes-256-gcm', readFileSync(database + '.project-env-key'), encrypted.subarray(0, 12));
    decoder.setAAD(Buffer.from(project + ':' + name));
    decoder.setAuthTag(encrypted.subarray(-16));
    assert(Buffer.concat([decoder.update(encrypted.subarray(12, -16)), decoder.final()]).equals(Buffer.from(secret)));
    assert(!readFileSync(database).includes(Buffer.from(secret)));
  } finally { databaseFile.close(); }
}

try {
  assert([0, 2].includes(process.argv.length - 2), 'Pass both old and new bin directories, or neither.');
  let [oldBin, newBin] = process.argv.slice(2).map(path => resolve(path));
  if (!oldBin) {
    execFileSync('git', ['worktree', 'add', '--detach', oldTree, 'bd6b96e'], { cwd: root, stdio: 'inherit' });
    worktree = true;
    oldBin = buildBinaries(oldTree);
    newBin = buildBinaries(root);
  }
  for (const path of [data, releases, oldConfig, units, join(legacy, 'scripts'), join(releases, 'feed')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const update = async (path, value, status) => {
    const response = await fetch(origin + path, {
      ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }),
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    assert(status === undefined ? response.ok : response.status === status, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const ready = (version) => until(async () => (await update('/api/environment')).version === version, version);
  const switchInApp = async (release, status) => {
    durableWrite(join(releases, 'feed/latest.json'), JSON.stringify(release));
    const id = randomUUID();
    await until(async () => (await update('/api/updates/apply', { id, version: release.version, source: 'Local feed' })).accepted, 'update admission');
    await waitAttempt(id, status);
  };
  const waitAttempt = (id, status) => until(async () => {
    const attempt = (await launcher({ type: 'status' })).lastAttempt;
    return attempt?.id === id && attempt.status === status;
  }, status);
  const old = seal(oldBin, '0.13.13', 'bd6b96e0'.padEnd(40, '0'), false);
  const { version } = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8'));
  const bridge = seal(newBin, version, '1'.repeat(40), true);
  const bad = seal(newBin, version + '-failed', '2'.repeat(40), true, true);
  const next = seal(newBin, version + '-failed-again', '3'.repeat(40), true, true);
  selectRelease(releases, 'current', old.id);
  const launcherConfig = join(oldConfig, 'launcher.json');
  durableWrite(launcherConfig, JSON.stringify({ dataDir: data, releasesDir: releases, port, trialTimeoutMs: 8000 }));
  writeFileSync(join(oldConfig, 'ninerouter.env'), '# rehearsal fixture\n', { mode: 0o600 });
  writeFileSync(start, '#!/bin/sh\nset -eu\nexport BRIEFSIP_STREAM=1 BRIEFSIP_AGENT_DESKTOP=1 BRIEFSIP_WORKSPACES="[]"\n' +
    'export BRIEFSIP_DATA_DIR="$HOME/.local/share/briefsip/data"\n' +
    'exec "$HOME/.local/share/briefsip/releases/current/bin/briefsip-launcher" --config "$HOME/.config/briefsip/launcher.json"\n', { mode: 0o700 });
  durableWrite(join(units, 'briefsip.service'), Buffer.from('[Unit]\nDescription=Briefsip\n[Service]\nExecStart=%h/.local/share/briefsip/scripts/start.sh\n'));
  boot(start);
  await ready(old.version);
  const agent = await update('/api/agents', { id: randomUUID(), name: 'Rename rehearsal', model: 'fixture', instructions: 'Keep fixture data.', runtime: 'api' }, 201);
  const project = await update('/api/projects', { id: randomUUID(), name: 'Rename rehearsal', members: [{ agent: agent.id, write: false }] });
  const providerSecret = randomUUID(), account = randomUUID();
  provider = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + providerSecret || request.url !== '/v1/models') {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  await update('/api/provider-accounts', {
    id: account, provider: 'openai-compatible', name: 'Provider fixture',
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, defaultModel: 'fixture', apiKey: providerSecret,
  }, 201);
  const checkProvider = async () => assert.deepEqual((await update('/api/models?account=' + account)).models, ['fixture']);
  const secret = randomUUID();
  const setSecret = { id: randomUUID(), name: 'RENAME_CANARY', value: secret };
  const secretRoute = `/api/projects/${project.id}/environment`;
  await update(secretRoute, setSecret);
  decrypt(legacyDb, project.id, secret);
  await until(async () => { await checkProvider(); return true; }, "provider account");
  console.log('0.13.13 starts with legacy-only environment; project and encrypted secret seeded.');

  await switchInApp(bad, 'rolled-back');
  await ready(old.version);
  decrypt(legacyDb, project.id, secret);
  await until(async () => { await checkProvider(); return true; }, "provider account");
  console.log('Failed bridge trial under 0.13.13 restores old snapshot and decrypts secret.');

  await switchInApp(bridge, 'done');
  await ready(bridge.version);
  assert.equal(realpathSync(legacyDb), newDb);
  assert(lstatSync(legacy).isSymbolicLink());
  assert(lstatSync(oldConfig).isSymbolicLink());
  assert.equal(readlinkSync(join(releases, 'current')), bridge.id);
  assert(existsSync(join(units, 'minarbot.service')));
  await until(async () => (await update('/api/agents')).agents.some(row => row.id === agent.id), 'migrated agent');
  assert((await update(secretRoute)).items.some(row => row.name === setSecret.name));
  decrypt(newDb, project.id, secret);
  await until(async () => { await checkProvider(); return true; }, "provider account");
  console.log('Old launcher commits bridge update; Minarbot uses migrated DB, project and secret.');

  await down();
  boot(join(releases, 'current/bin/minarbot-launcher'), ['--config', join(newConfig, 'launcher.json')]);
  await ready(bridge.version);
  const rollback = randomUUID();
  assert.equal((await launcher({ type: 'apply', id: rollback, target: old.id, version: old.version })).accepted, true);
  await waitAttempt(rollback, 'done');
  await ready(old.version);
  decrypt(legacyDb, project.id, secret);
  await until(async () => { await checkProvider(); return true; }, "provider account");
  const failed = randomUUID();
  await until(async () => (await launcher({ type: 'apply', id: failed, target: next.id, version: next.version })).accepted, 'failed trial admission');
  await waitAttempt(failed, 'rolled-back');
  await ready(old.version);
  assert.equal(readlinkSync(join(releases, 'current')), old.id);
  decrypt(legacyDb, project.id, secret);
  await until(async () => { await checkProvider(); return true; }, "provider account");
  console.log('Minarbot launcher starts 0.13.13 and rolls a failed trial back with its secret intact.');
} finally {
  await down();
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)); }
  if (worktree) execFileSync('git', ['worktree', 'remove', oldTree], { cwd: root, stdio: 'inherit' });
  rmSync(scratch, { recursive: true, force: true });
}
