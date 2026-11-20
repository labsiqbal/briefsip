// Adapted from T3 os-jank.ts and shared/shell.ts at 0af2d21647416e3092347d4be82af6cfa6fa6b2d (MIT).
// Copyright (c) 2026 T3 Tools Inc. See NOTICE and provenance.json.
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { basename, isAbsolute } from 'node:path';

const names = ['PATH', '__MISE_DIFF', 'JAVA_HOME'] as const;
const marker = (name: string, edge: string) => `__MINARBOT_ENV_${name}_${edge}__`;

export function listLoginShellCandidates(platform: NodeJS.Platform, shell?: string, userShell?: string | null) {
  if (userShell === undefined) { try { userShell = userInfo().shell; } catch { userShell = null; } }
  return [...new Set([shell, userShell, platform === 'darwin' ? '/bin/zsh' : '/bin/bash']
    .map(value => value?.trim()).filter((value): value is string => !!value && isAbsolute(value)))];
}

export function mergePathEntries(preferred?: string, inherited?: string) {
  return [...new Set([preferred, inherited].flatMap(value => value?.split(':').map(entry => entry.trim()).filter(Boolean) ?? []))].join(':');
}

export function buildEnvironmentCaptureCommand(shell: string) {
  const executable = basename(shell).toLowerCase();
  const capture = names.map(name => {
    if (executable.startsWith('nu')) {
      const fallback = name === 'PATH'
        ? "if ($env.PATH? | describe | str starts-with 'list') { $env.PATH | each {|p| if ($p | str starts-with '~') { $p | path expand --no-symlink } else { $p } } | str join (char esep) } else { $env.PATH? | default '' }"
        : `$env.${name}? | default ''`;
      const value = `if $env.${name}? == null { '' } else if $env.ENV_CONVERSIONS?.${name}?.to_string? != null { $env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} } else { ${fallback} }`;
      return `print '${marker(name, 'START')}'; print (${value}); print '${marker(name, 'END')}'`;
    }
    return `printf '%s\\n' '${marker(name, 'START')}'; printenv ${name} || true; printf '%s\\n' '${marker(name, 'END')}'`;
  }).join('; ');
  return ['bash', 'zsh', 'sh', 'ksh', 'ksh93'].includes(executable)
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${capture}` : capture;
}

function readCommand(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string | undefined> {
  if (timeout <= 0) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const child = spawn(file, args, { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', bytes = 0, settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Probe exited. */ }
      child.stdout.destroy(); child.unref(); resolve(value);
    };
    const timer = setTimeout(() => finish(), timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) finish(); else output += chunk;
    });
    child.once('error', () => finish());
    child.once('close', code => finish(code === 0 ? output : undefined));
  });
}

export async function readEnvironmentFromLoginShell(shell: string, env: NodeJS.ProcessEnv, timeout = 5000) {
  const output = await readCommand(shell, ['-ilc', buildEnvironmentCaptureCommand(shell)], env, timeout);
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const start = output?.indexOf(marker(name, 'START')) ?? -1;
    if (start < 0) continue;
    const offset = start + marker(name, 'START').length, end = output!.indexOf(marker(name, 'END'), offset);
    if (end < 0) continue;
    const value = output!.slice(offset, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (value && !value.includes('\0')) result[name] = value;
  }
  return result;
}

export async function readPathFromLaunchctl(env: NodeJS.ProcessEnv, timeout = 2000) {
  return (await readCommand('/bin/launchctl', ['getenv', 'PATH'], env, timeout))?.trim() || undefined;
}

export function hydratePosixHome(env: NodeJS.ProcessEnv, resolveHome = () => userInfo().homedir) {
  if (!env.HOME?.trim()) { const home = resolveHome(); if (home) env.HOME = home; }
}

export async function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  shells = listLoginShellCandidates(platform, env.SHELL)) {
  const deadline = Date.now() + 5000;
  for (const shell of shells) {
    const captured = await readEnvironmentFromLoginShell(shell, env, deadline - Date.now());
    if (!captured.PATH?.trim()) continue;
    env.PATH = mergePathEntries(captured.PATH, env.PATH);
    if (captured.__MISE_DIFF) env.__MISE_DIFF = captured.__MISE_DIFF;
    if (!env.JAVA_HOME && captured.JAVA_HOME) env.JAVA_HOME = captured.JAVA_HOME;
    return true;
  }
  const launchctlPath = platform === 'darwin' ? await readPathFromLaunchctl(env, Math.min(2000, deadline - Date.now())) : undefined;
  if (!launchctlPath) return false;
  env.PATH = mergePathEntries(launchctlPath, env.PATH);
  return true;
}

let hydration: Promise<void> | undefined;
export function fixPath() {
  return hydration ??= (async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    let failed = false;
    try { hydratePosixHome(process.env); } catch { failed = true; }
    try { if (!await hydratePosixPath(process.env, process.platform)) failed = true; } catch { failed = true; }
    if (failed) process.stderr.write('[server] Login environment hydration failed; keeping inherited environment.\n');
  })();
}
