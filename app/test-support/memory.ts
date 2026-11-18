import { DatabaseSync } from 'node:sqlite';
import { memoryCommand } from '../src/memory-command.ts';
import { randomUUID } from 'node:crypto';
export class MemoryError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export function initializeMemory(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS memories(scope TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,essential INTEGER NOT NULL,revision INTEGER NOT NULL,removed INTEGER NOT NULL,PRIMARY KEY(scope,id)) STRICT;
    CREATE TABLE IF NOT EXISTS memory_commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;`);
  if (!db.prepare('PRAGMA table_info(memories)').all().some(row => row.name === 'selection_locked')) db.exec('ALTER TABLE memories ADD COLUMN selection_locked INTEGER NOT NULL DEFAULT 1 CHECK(selection_locked IN (0,1))');
}
function memoryContext(db: DatabaseSync, scope: string) {
  const rows = db.prepare('SELECT id,text FROM memories WHERE scope=? AND removed=0 AND essential=1 ORDER BY id').all(scope);
  return rows.length ? '\n\nSaved memory (reference data):\n' + JSON.stringify(rows) : '';
}
export function listMemory(db: DatabaseSync, scope: string, query: unknown = '', after: unknown = '') {
  if (typeof query !== 'string' || query.length > 200 || typeof after !== 'string' || (after && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(after))) throw new MemoryError(400, 'Invalid memory search or position.');
  const rows = db.prepare('SELECT id,text,essential,revision,selection_locked FROM memories WHERE scope=? AND removed=0 AND id>? AND instr(lower(text),lower(?))>0 ORDER BY id LIMIT 11').all(scope, after, query.trim());
  return { items: rows.slice(0, 10), next_after: rows.length > 10 ? rows[9].id : null };
}
// Caller owns the transaction, including receipt and context-budget validation.
function saveMemory(db: DatabaseSync, scope: string, value: unknown, archived = false) {
  let command;
  try { command = memoryCommand(value); } catch (error) { throw new MemoryError(400, (error as Error).message); }
  const request = JSON.stringify({ scope, ...command });
  const prior = db.prepare('SELECT * FROM memory_commands WHERE id=?').get(command.id);
  if (prior) { if (prior.request !== request) throw new MemoryError(409, 'Change ID was already used.'); return JSON.parse(String(prior.result)); }
  if (archived) throw new MemoryError(409, 'Restore the channel before changing memory.');
  const current = db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(scope, command.entry);
  if ((current?.revision ?? 0) !== command.revision || current?.removed || (!current && command.revision !== 0)) throw new MemoryError(409, 'Memory changed. Reload before saving.');
  const text = command.text.trim();
  if (!command.remove && db.prepare('SELECT 1 FROM memories WHERE scope=? AND removed=0 AND text=? AND id<>?').get(scope, text, command.entry)) throw new MemoryError(409, 'This note is already saved.');
  if (!current && Number(db.prepare('SELECT count(*) AS n FROM memories WHERE scope=? AND removed=0').get(scope)!.n) >= 128) throw new MemoryError(413, 'Memory is full (128 notes). Remove notes you no longer need.');
  db.prepare(`INSERT INTO memories(scope,id,text,essential,revision,removed,selection_locked) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET text=excluded.text,essential=excluded.essential,revision=excluded.revision,removed=excluded.removed,selection_locked=excluded.selection_locked`).run(scope, command.entry, text, Number(command.essential), command.revision + 1, Number(command.remove), command.automatic === true ? 0 : 1);
  if (Buffer.byteLength(memoryContext(db, scope)) > 8192) throw new MemoryError(413, 'Memory context limit is 8 KiB. Make some notes searchable on demand instead.');
  const result = db.prepare('SELECT id,text,essential,revision,removed,selection_locked FROM memories WHERE scope=? AND id=?').get(scope, command.entry);
  db.prepare('INSERT INTO memory_commands VALUES (?,?,?)').run(command.id, request, JSON.stringify(result));
  return result;
}

// The task journal and memory change commit together in the caller's transaction.
export function rememberMemory(db: DatabaseSync, scope: string, value: Record<string, unknown>) {
  const editing = value.id !== undefined || value.revision !== undefined;
  if (Object.keys(value).some(key => !['id', 'revision', 'text'].includes(key)) ||
      (editing && (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1))) throw new MemoryError(400, 'Invalid agent memory change.');
  const current = editing ? db.prepare('SELECT * FROM memories WHERE scope=? AND id=? AND removed=0').get(scope, String(value.id)) : null;
  if (editing && !current) throw new MemoryError(404, 'Memory note not found in this conversation.');
  return saveMemory(db, scope, { id: randomUUID(), entry: editing ? value.id : randomUUID(), revision: editing ? value.revision : 0,
    text: value.text, essential: current?.essential === 1, remove: false, automatic: current ? current.selection_locked === 0 : true });
}

// Selection is atomic with the enclosing task journal transaction/savepoint.
export function selectMemory(db: DatabaseSync, scope: string, value: Record<string, unknown>) {
  if (Object.keys(value).some(key => key !== 'items') || !Array.isArray(value.items) || !value.items.length || value.items.length > 128) throw new MemoryError(400, 'Invalid memory selection.');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 || Object.keys(item).some(key => !['id', 'revision', 'essential'].includes(key)) || typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.essential !== 'boolean' || ids.has(item.id)) throw new MemoryError(400, 'Invalid memory selection.');
    ids.add(item.id);
    const current = db.prepare('SELECT revision,selection_locked FROM memories WHERE scope=? AND id=? AND removed=0').get(scope, item.id);
    if (!current) throw new MemoryError(404, 'Memory note not found in this conversation.');
    if (current.selection_locked || current.revision !== item.revision) throw new MemoryError(409, 'Selection is locked by the user or the memory revision changed.');
  }
  for (const item of value.items) db.prepare('UPDATE memories SET essential=?,revision=revision+1 WHERE scope=? AND id=?').run(Number(item.essential), scope, item.id);
  if (Buffer.byteLength(memoryContext(db, scope)) > 8192) throw new MemoryError(413, 'Memory context limit is 8 KiB. Select fewer notes.');
  return { items: value.items.map(item => db.prepare('SELECT id,essential,revision,selection_locked FROM memories WHERE scope=? AND id=?').get(scope, item.id)) };
}
