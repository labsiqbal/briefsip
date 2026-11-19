import type { PathLike } from 'node:fs';
import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';

export function testDatabase(path: PathLike, options?: DatabaseSyncOptions) {
  return new DatabaseSync(path, { timeout: 5000, ...options });
}
