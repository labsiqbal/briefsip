import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binaries = new Map<string, string>();
process.once('exit', () => { for (const binary of binaries.values()) rmSync(join(binary, '..'), { recursive: true, force: true }); });
export function nativeReleaseFixture(directory: string, version: string, mode = 'healthy') {
  const key = JSON.stringify([version, mode]);
  let binary = binaries.get(key);
  if (!binary) {
    binary = join(mkdtempSync(join(tmpdir(), 'minarbot-native-fixture-')), 'server');
    execFileSync('rustc', [new URL('../../crates/minarbot-launcher/tests/fixtures/contract.rs', import.meta.url).pathname, '-O', '-o', binary], { env: { ...process.env, MINARBOT_FIXTURE_VERSION: version, MINARBOT_FIXTURE_MODE: mode } });
    binaries.set(key, binary);
  }
  mkdirSync(join(directory, 'bin'), { recursive: true });
  cpSync(binary, join(directory, 'bin/minarbot-server'));
  chmodSync(join(directory, 'bin/minarbot-server'), 0o700);
}
