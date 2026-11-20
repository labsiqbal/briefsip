import { rustBinary } from './rust-binary.ts';

export function launcherCommand(config: string): [string, string[]] {
  return [rustBinary('minarbot-launcher', process.env.MINARBOT_RUST_LAUNCHER_BINARY), ['--config', config]];
}
