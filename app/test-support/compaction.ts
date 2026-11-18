import type { DatabaseSync } from 'node:sqlite';

type Snapshot = { version: string; through: number; summary: string };
export function initializeCompaction(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS queue_positions(turn TEXT PRIMARY KEY REFERENCES turns(id),position INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS compactions(scope TEXT PRIMARY KEY,version TEXT NOT NULL,through INTEGER NOT NULL,summary TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS compaction_sources(scope TEXT NOT NULL,seq INTEGER NOT NULL REFERENCES turns(seq),revision INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(scope,seq)) STRICT;
    CREATE TABLE IF NOT EXISTS compaction_attempts(turn TEXT PRIMARY KEY REFERENCES turns(id),status TEXT NOT NULL,created TEXT NOT NULL) STRICT;
    UPDATE compaction_attempts SET status='interrupted' WHERE status='pending';`);
}
export function readCompaction(db: DatabaseSync, scope: string, before = Number.MAX_SAFE_INTEGER): Snapshot | null {
  const row = db.prepare('SELECT version,through,summary FROM compactions WHERE scope=? AND through<?').get(scope, before);
  if (!row || db.prepare('SELECT 1 FROM compaction_sources s LEFT JOIN turns t ON t.seq=s.seq WHERE s.scope=? AND (t.seq IS NULL OR t.revision<>s.revision OR t.status<>s.status) LIMIT 1').get(scope)) return null;
  return row as Snapshot;
}
