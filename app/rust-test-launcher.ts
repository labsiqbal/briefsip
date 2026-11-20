import { productEnv } from '../desktop/src/rename-env.mjs';
import { rustBinary } from './rust-binary.ts';

export function launcherCommand(config: string): [string, string[]] {
  return [rustBinary('minarbot-launcher', productEnv('MINARBOT_RUST_LAUNCHER_BINARY')), ['--config', config]];
}
