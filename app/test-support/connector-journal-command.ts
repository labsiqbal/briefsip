import { spawnSync } from 'node:child_process';
import { rustBinary } from '../rust-binary.ts';

export function connectorJournalCommand(platform: 'slack' | 'telegram', directory: string) {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  return (command: string, id?: string, revision?: string, action?: string, confirmation?: string) =>
    spawnSync(binary, ['--connector-journal-config'], {
      encoding: 'utf8',
      input: JSON.stringify({ platform, directory, command, id, revision: revision === undefined ? undefined : Number(revision), action, confirmation }),
    });
}
