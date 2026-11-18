import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export function initializeVisibility(db: DatabaseSync) {
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/turns/agent-visibility.sql', import.meta.url), 'utf8'));
}
export function agentHidden(db: DatabaseSync, agent: string): boolean {
  return db.prepare('SELECT hidden FROM agent_visibility WHERE agent=?').get(agent)?.hidden === 1;
}
