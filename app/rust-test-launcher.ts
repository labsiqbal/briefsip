import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function launcherCommand(config: string): [string, string[]] {
  const root = fileURLToPath(new URL('../', import.meta.url));
  return process.env.BRIEFSIP_TEST_LAUNCHER === 'rust'
    ? [process.env.BRIEFSIP_RUST_LAUNCHER_BINARY ?? resolve(root, 'target/debug/briefsip-launcher'), ['--config', config]]
    : [process.execPath, [resolve(root, 'scripts/briefsip-launcher.mjs'), '--config', config]];
}
