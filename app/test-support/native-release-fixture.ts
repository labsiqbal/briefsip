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
    binary = join(mkdtempSync(join(tmpdir(), 'briefsip-native-fixture-')), 'server');
    execFileSync('rustc', [new URL('../../crates/briefsip-launcher/tests/fixtures/contract.rs', import.meta.url).pathname, '-O', '-o', binary], { env: { ...process.env, BRIEFSIP_FIXTURE_VERSION: version, BRIEFSIP_FIXTURE_MODE: mode } });
    binaries.set(key, binary);
  }
  mkdirSync(join(directory, 'bin'), { recursive: true });
  cpSync(binary, join(directory, 'bin/briefsip-server'));
  chmodSync(join(directory, 'bin/briefsip-server'), 0o700);
}
