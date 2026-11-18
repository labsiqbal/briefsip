import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildEnvironmentCaptureCommand, hydratePosixHome, hydratePosixPath, listLoginShellCandidates, mergePathEntries, readEnvironmentFromLoginShell } from './t3/path.ts';
import { harnessEnv } from './harness.ts';

const serverURL = new URL('./test-bridge.ts', import.meta.url).href;
const rust = process.env.BRIEFSIP_TEST_SERVER === 'rust';

for (const broken of [false, true]) test(broken ? 'broken login shell keeps service startup working' : 'service launch discovers Codex exported only by the login shell', { skip: rust, timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-login-path-'));
  const bin = join(directory, 'bin'), shell = join(directory, 'login-shell');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(directory, 'harness-env.json'))}, JSON.stringify(process.env));\nconsole.log('codex fixture 1.0');\n`, { mode: 0o700 });
  // sh does not support -ilc on every platform; emulate login initialization and run the capture command.
  writeFileSync(shell, `#!/bin/sh\nprintf x >> '${join(directory, 'probes')}'\nprintf 'profile noise\\n'\nexport PATH='${bin}:/usr/bin:/bin'\nexport __MISE_DIFF=fixture JAVA_HOME=/fixture/java SHELL_SECRET=hidden\nexec /bin/sh -c "$2"\n`, { mode: 0o700 });
  if (broken) {
    writeFileSync(shell, '#!/bin/sh\necho synthetic-secret >&2\nexit 7\n');
    for (const profile of ['.bash_profile', '.zprofile', '.zshrc']) writeFileSync(join(directory, profile), 'exit 7\n');
  }
  const source = `import { startApp } from ${JSON.stringify(serverURL)};
    const app = await startApp({ database: ${JSON.stringify(join(directory, 'state.sqlite'))} });
    const second = await startApp({ database: ${JSON.stringify(join(directory, 'second.sqlite'))} });
    process.send({ origin: app.origin, path: process.env.PATH, mise: process.env.__MISE_DIFF, java: process.env.JAVA_HOME, secret: process.env.SHELL_SECRET });
    process.on('message', async () => { await app.close(); await second.close(); process.disconnect(); });`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: { HOME: directory, PATH: '/usr/bin:/bin', SHELL: shell, TMPDIR: directory, AMBIENT_SECRET: 'synthetic-secret' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let error = ''; child.stderr!.on('data', data => { error += data; });
  try {
    const [message] = await Promise.race([once(child, 'message'), delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`Startup timed out: ${error}`); })]);
    const response = await fetch(message.origin + '/api/runtimes');
    assert.equal(response.status, 200);
    const runtimes = await response.json();
    if (broken) {
      assert.equal(runtimes.defaultRuntime, 'api');
      assert.equal(message.path, '/usr/bin:/bin');
      assert.equal(error.split('Login environment hydration failed').length - 1, 1);
      assert(!error.includes('synthetic-secret'));
      return;
    }
    assert.equal(runtimes.choices.find((choice: { runtime: string }) => choice.runtime === 'codex').available, true);
    assert.equal(runtimes.defaultRuntime, 'codex');
    await fetch(message.origin + '/api/runtimes');
    assert.equal(readFileSync(join(directory, 'probes'), 'utf8'), 'x');
    assert.equal(message.path, `${bin}:/usr/bin:/bin`);
    assert.equal(message.mise, 'fixture'); assert.equal(message.java, '/fixture/java'); assert.equal(message.secret, undefined);
    const childEnv = JSON.parse(readFileSync(join(directory, 'harness-env.json'), 'utf8'));
    assert.equal(childEnv.PATH, message.path);
    assert.deepEqual(Object.keys(childEnv).sort(), ['HOME', 'PATH', 'TMPDIR']);
  } finally {
    const exited = once(child, 'exit');
    if (child.connected) child.send('close'); else child.kill('SIGKILL');
    await Promise.race([exited, delay(3000, undefined, { ref: false }).then(() => { child.kill('SIGKILL'); })]);
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
