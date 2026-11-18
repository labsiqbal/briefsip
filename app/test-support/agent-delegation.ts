// Adapted MIT sources: T3 and Hermes. See ../agent-delegation.provenance.json.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { initializeRemoteAgents, resolveRemoteAgent } from '../remote-agents.ts';

/** Adapted from Hermes BotLoopGuard/delegation limits and T3 completion delivery. See provenance manifests. */
export const DELEGATION_LIMITS = Object.freeze({ rate: 20, rateWindowMs: 5 * 60_000, cooldownMs: 10 * 60_000, depth: 3, concurrentChildren: 8 });
export type AgentLimits = { rate: number; rateWindowMs: number; cooldownMs: number; depth: number; concurrentChildren: number };
export const agentLimits = (_db: DatabaseSync): AgentLimits => DELEGATION_LIMITS;
export function peerOriginated(db: DatabaseSync, turn: string) {
  return !!db.prepare(`WITH RECURSIVE tree(id,parent,origin) AS (SELECT id,parent,origin FROM turns WHERE id=? UNION ALL SELECT t.id,t.parent,t.origin FROM turns t JOIN tree ON t.id=tree.parent) SELECT 1 FROM tree WHERE origin LIKE 'peer:%' LIMIT 1`).get(turn);
}
export type AgentTarget = { kind: 'local'; agent: string } | { kind: 'remote'; machine: string; agent: string };
export function resolveAgentTarget(nameOrId: string, db: DatabaseSync): AgentTarget | null {
  if (nameOrId.includes('@')) return resolveRemoteAgent(db,nameOrId);
  const exact = db.prepare('SELECT id FROM agents WHERE id=?').get(nameOrId);
  const matches = exact ? [exact] : db.prepare('SELECT id FROM agents WHERE lower(name)=lower(?) LIMIT 2').all(nameOrId);
  const row = matches.length === 1 ? matches[0] : undefined;
  return row ? { kind: 'local', agent: String(row.id) } : null;
}
export class DelegationError extends Error { status = 409; constructor(message: string, status = 409) { super(message); this.status = status; } }
export function initializeDelegation(db: DatabaseSync) {
  initializeRemoteAgents(db);
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/turns/agent-delegation.sql', import.meta.url), 'utf8'));
}
