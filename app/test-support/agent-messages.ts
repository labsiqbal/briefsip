import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { initializeVisibility } from './agent-visibility.ts';
import { initializeDelegation } from './agent-delegation.ts';

export class AgentMessageError extends Error { status = 409; }
export function initializeAgentMessages(db: DatabaseSync) {
  initializeVisibility(db);
  if (!db.prepare('PRAGMA table_info(turns)').all().some(row => row.name === 'origin')) db.exec('ALTER TABLE turns ADD COLUMN origin TEXT');
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/turns/agent-messages.sql', import.meta.url), 'utf8'));
  initializeDelegation(db);
  db.exec(readFileSync(new URL('../../crates/briefsip-server/src/turns/rooms.sql', import.meta.url), 'utf8'));
  if (!db.prepare('PRAGMA table_info(room_discussions)').all().some(row => row.name === 'stopped')) db.exec('ALTER TABLE room_discussions ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0');
}
export function canMessage(db: DatabaseSync, turn: string) {
  return !db.prepare('SELECT 1 FROM agent_deliveries d JOIN agent_requests r ON r.id=d.request WHERE d.turn=? AND r.expects_reply=0').get(turn);
}
export function agentMessageInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMessageError('Invalid recipient, text, or reply request.');
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !['recipients', 'text', 'expects_reply'].includes(key)) || !Array.isArray(args.recipients) || !args.recipients.length || args.recipients.length > 8 || args.recipients.some((id: unknown) => typeof id !== 'string') || new Set(args.recipients).size !== args.recipients.length || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000 || typeof args.expects_reply !== 'boolean') throw new AgentMessageError('Invalid recipient, text, or reply request.');
  return { recipients: args.recipients as string[], text: args.text.trim(), expects_reply: args.expects_reply };
}
