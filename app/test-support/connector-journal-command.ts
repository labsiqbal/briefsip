import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rustBinary } from '../rust-binary.ts';

export function connectorJournalCommand(platform: 'slack' | 'telegram', directory: string) {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  return (command: string, id?: string, revision?: string, action?: string, confirmation?: string) =>
    spawnSync(binary, ['--connector-journal-config'], {
      encoding: 'utf8',
      input: JSON.stringify({ platform, directory, command, id, revision: revision === undefined ? undefined : Number(revision), action, confirmation }),
    });
}

export function openConnectorJournalFixture(platform: 'slack' | 'telegram', directory: string) {
  const initialized = connectorJournalCommand(platform, directory)('status');
  assert.equal(initialized.status, 0, initialized.stderr);
  return new DatabaseSync(join(directory, platform + '.sqlite'));
}
