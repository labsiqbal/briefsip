import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildEnvironmentCaptureCommand, hydratePosixHome, hydratePosixPath, listLoginShellCandidates, mergePathEntries, readEnvironmentFromLoginShell } from './t3/path.ts';
import { harnessEnv } from './harness.ts';
import { rustBinary } from './rust-binary.ts';

const { freePort, stop } = await import(new URL('../scripts/production-env-gate.mjs', import.meta.url).href);

for (const broken of [false, true]) test(broken ? 'broken login shell keeps service startup working' : 'service launch discovers Codex exported only by the login shell', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-login-path-'));
  const bin = join(directory, 'bin'), shell = join(directory, 'login-shell');
  const probes = join(directory, 'probes'), environment = join(directory, 'harness-env.json');
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(environment)}, JSON.stringify(process.env));
console.log('codex fixture 1.0');
`, { mode: 0o700 });
  writeFileSync(shell, broken
    ? '#!/bin/sh\necho synthetic-secret >&2\nexit 7\n'
    : `#!/bin/sh
printf x >> '${probes}'
printf 'profile noise\\n'
export PATH='${bin}:/usr/bin:/bin'
export SHELL_SECRET=synthetic-secret
exec /bin/sh -c "$2"
`, { mode: 0o700 });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(binary, [], {
    env: { HOME: directory, PATH: '/usr/bin:/bin', SHELL: shell, TMPDIR: directory, PORT: String(port), BRIEFSIP_DATA_DIR: directory, AMBIENT_SECRET: 'synthetic-secret' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = new Promise(ready => child.once('close', ready));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 10000;
    let response: Response | undefined;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, stderr);
      response = await fetch(origin + '/api/runtimes', { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      if (response) break;
      await delay(50);
    }
    assert.equal(response?.status, 200, stderr);
    const runtimes = await response!.json();
    assert(!stderr.includes('synthetic-secret'));
    if (broken) {
      assert.notEqual(runtimes.choices.find((choice: { runtime: string }) => choice.runtime === 'codex').version, 'codex fixture 1.0');
      return;
    }
    assert.equal(runtimes.choices.find((choice: { runtime: string }) => choice.runtime === 'codex').version, 'codex fixture 1.0');
    assert.equal(runtimes.defaultRuntime, 'codex');
    await (await fetch(origin + '/api/runtimes')).arrayBuffer();
    assert.equal(readFileSync(probes, 'utf8'), 'x');
    const childEnv = JSON.parse(readFileSync(environment, 'utf8'));
    assert.equal(childEnv.PATH, `${bin}:/usr/bin:/bin`);
    assert.equal(childEnv.AMBIENT_SECRET, undefined);
    assert.equal(childEnv.SHELL_SECRET, undefined);
  } finally {
    await stop(child, closed);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('login shell candidates, PATH ordering, HOME fallback and capture scope', () => {
  assert.deepEqual(listLoginShellCandidates('darwin', ' /opt/bin/fish ', '/bin/zsh'), ['/opt/bin/fish', '/bin/zsh']);
  assert.deepEqual(listLoginShellCandidates('linux', 'bash', '/bin/bash'), ['/bin/bash']);
  assert.equal(mergePathEntries('/custom:/usr/bin:/custom::', '/usr/bin:/bin'), '/custom:/usr/bin:/bin');
  const env = { HOME: ' ' }; hydratePosixHome(env, () => '/account'); assert.equal(env.HOME, '/account');
  hydratePosixHome(env, () => { throw new Error('must preserve HOME'); });
  const capture = buildEnvironmentCaptureCommand('/bin/bash');
  assert(capture.startsWith('(trap - DEBUG)'));
  assert.deepEqual([...capture.matchAll(/printenv ([A-Z_]+)/g)].map(match => match[1]), ['PATH', '__MISE_DIFF', 'JAVA_HOME']);
  assert.match(buildEnvironmentCaptureCommand('/bin/nu'), /ENV_CONVERSIONS/);
  assert.deepEqual(harnessEnv({ PATH: '/custom', __MISE_DIFF: 'hidden', JAVA_HOME: 'hidden', SECRET: 'hidden' }), { PATH: '/custom' });
});

test('failed and hanging login probes preserve PATH with bounded process-tree cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-broken-shell-'));
  const broken = join(directory, 'broken'), hanging = join(directory, 'hanging');
  const working = join(directory, 'working'), noisy = join(directory, 'noisy');
  writeFileSync(broken, '#!/bin/sh\necho synthetic-secret >&2\nexit 7\n', { mode: 0o700 });
  writeFileSync(hanging, '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o700 });
  writeFileSync(working, '#!/bin/sh\nexport PATH=/custom:/usr/bin:/bin JAVA_HOME=/new __MISE_DIFF=fixture\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  writeFileSync(noisy, '#!/bin/sh\nhead -c 1048577 /dev/zero\n', { mode: 0o700 });
  try {
    const env = { PATH: '/usr/bin::/bin:/usr/bin', JAVA_HOME: '/existing', HOME: directory };
    assert.equal(await hydratePosixPath(env, 'linux', [broken]), false);
    assert.equal(env.PATH, '/usr/bin::/bin:/usr/bin');
    assert.equal(env.JAVA_HOME, '/existing');
    const started = Date.now();
    assert.deepEqual(await readEnvironmentFromLoginShell(hanging, env, 100), {});
    assert(Date.now() - started < 2000);
    assert.deepEqual(await readEnvironmentFromLoginShell(join(directory, 'missing'), env), {});
    assert.deepEqual(await readEnvironmentFromLoginShell(noisy, env), {});
    assert.equal(await hydratePosixPath(env, 'linux', [broken, working]), true);
    assert.equal(env.PATH, '/custom:/usr/bin:/bin');
    assert.equal(env.JAVA_HOME, '/existing');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
