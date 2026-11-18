import { rustBinary } from './rust-binary.ts';

export function launcherCommand(config: string): [string, string[]] {
  return [rustBinary('briefsip-launcher', process.env.BRIEFSIP_RUST_LAUNCHER_BINARY), ['--config', config]];
}
