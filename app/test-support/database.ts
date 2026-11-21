import type { PathLike } from 'node:fs';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';

export function testDatabase(path: PathLike, options?: DatabaseSyncOptions) {
  return new DatabaseSync(path, { timeout: 5000, ...options });
}

// Same application_id as APPLICATION_ID in crates/minarbot-launcher/src/data_format.rs.
export function markMinarbotData(db: DatabaseSync) {
  db.exec('PRAGMA application_id=0x4d4e5231');
}
