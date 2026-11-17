import { rustBinary } from './rust-binary.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function launcherCommand(config: string): [string, string[]] {
  const root = fileURLToPath(new URL('../', import.meta.url));
  return process.env.BRIEFSIP_TEST_LAUNCHER === 'rust'
    ? [rustBinary('briefsip-launcher', process.env.BRIEFSIP_RUST_LAUNCHER_BINARY), ['--config', config]]
    : [process.execPath, [resolve(root, 'scripts/briefsip-launcher.mjs'), '--config', config]];
}
