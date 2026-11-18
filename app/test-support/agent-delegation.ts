// Adapted MIT sources: T3 and Hermes. See ../agent-delegation.provenance.json.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Adapted from Hermes BotLoopGuard/delegation limits and T3 completion delivery. See provenance manifests. */
export const DELEGATION_LIMITS = Object.freeze({ rate: 20, rateWindowMs: 5 * 60_000, cooldownMs: 10 * 60_000, depth: 3, concurrentChildren: 8 });
export type AgentLimits = { rate: number; rateWindowMs: number; cooldownMs: number; depth: number; concurrentChildren: number };
export const agentLimits = (_db: DatabaseSync): AgentLimits => DELEGATION_LIMITS;
export function peerOriginated(db: DatabaseSync, turn: string) {
  return !!db.prepare(`WITH RECURSIVE tree(id,parent,origin) AS (SELECT id,parent,origin FROM turns WHERE id=? UNION ALL SELECT t.id,t.parent,t.origin FROM turns t JOIN tree ON t.id=tree.parent) SELECT 1 FROM tree WHERE origin LIKE 'peer:%' LIMIT 1`).get(turn);
}
export class DelegationError extends Error { status = 409; constructor(message: string, status = 409) { super(message); this.status = status; } }
export function initializeDelegation(db: DatabaseSync) {
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/computer/remote-agents.sql', import.meta.url), 'utf8'));
  if (!db.prepare('PRAGMA table_info(turns)').all().some(row => row.name === 'message_depth')) db.exec('ALTER TABLE turns ADD COLUMN message_depth INTEGER NOT NULL DEFAULT 0');
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/turns/agent-delegation.sql', import.meta.url), 'utf8'));
}
