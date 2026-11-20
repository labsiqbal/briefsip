import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { digestCommand } from '../shared/protocol.ts';

// Keep fixture DDL and migration checksums independent of Rust's migrations.
export function installCanonicalFixture(db: DatabaseSync, through: 1 | 2 | 3 | 4 = 4) {
  db.function('minarbot_capability_digest', { deterministic: true }, value => digestCommand(['minarbot-capabilities-v1', JSON.parse(String(value))]));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let version = 1; version <= through; version++) {
      db.exec(readFileSync(new URL(`./fixtures/canonical-v${version}.sql`, import.meta.url), 'utf8'));
    }
    db.prepare('UPDATE authority_state SET generation=? WHERE id=1').run(randomUUID());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
