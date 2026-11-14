// Adapted from T3 McpSessionRegistry.ts (MIT). See provenance.json and NOTICE.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const mcpScopes = ['agents:read', 'agents:message', 'history:read', 'machine:update'] as const;
export type McpScope = typeof mcpScopes[number];
export type McpCaller = { id: string; kind: 'session' | 'peer'; agent?: string; turn?: string; peer?: string; scopes: McpScope[] };
export type AgentSessionInput = { agent: string; turn?: string; scopes: McpScope[]; ttlMs: number };
export class McpServerError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export function parseScopes(value: unknown): McpScope[] {
  if (!Array.isArray(value) || !value.length || value.length > mcpScopes.length || new Set(value).size !== value.length || value.some(scope => !mcpScopes.includes(scope))) throw new McpServerError(400, 'Choose at least one valid scope.');
  return [...value].sort();
}
type TokenRow = { id: string; kind: 'session' | 'peer'; name: string; agent: string | null; turn: string | null; scopes: string; created: number; last_used: number | null; revoked: number | null; expires: number | null };
const metadata = (row: TokenRow) => ({ id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as McpScope[], created: row.created, lastUsed: row.last_used, revoked: row.revoked });

export function initializeMcpSessions(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_server_tokens (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('session','peer')),
    name TEXT NOT NULL, agent TEXT REFERENCES agents(id), turn TEXT REFERENCES turns(id), scopes TEXT NOT NULL,
    created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER, expires INTEGER, request_digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mcp_server_commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL) STRICT;`);
  // Process-bound credentials never survive restart, including tokens without a turn binding.
  db.prepare("UPDATE mcp_server_tokens SET revoked=? WHERE kind='session' AND revoked IS NULL").run(Date.now());
}

export function createPeerToken(db: DatabaseSync, input: { id: string; name: string; scopes: McpScope[] }, now = Date.now()) {
  if (!input || Object.keys(input).some(key => !['id', 'name', 'scopes'].includes(key)) || typeof input.id !== 'string' || !uuid.test(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw new McpServerError(400, 'Invalid peer token request.');
  const scopes = parseScopes(input.scopes), name = input.name.trim();
  const digest = hashToken(JSON.stringify({ name, scopes }));
  const prior = db.prepare('SELECT * FROM mcp_server_tokens WHERE id=?').get(input.id) as TokenRow & { request_digest: string } | undefined;
  if (prior) {
    if (prior.kind !== 'peer' || prior.request_digest !== digest) throw new McpServerError(409, 'ID was already used for a different change.');
    return { ...metadata(prior), token: undefined, alreadyCreated: true };
  }
  const token = randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO mcp_server_tokens(id,token_hash,kind,name,scopes,created,request_digest) VALUES (?,?,'peer',?,?,?,?)").run(input.id, hashToken(token), name, JSON.stringify(scopes), now, digest);
  return { ...metadata(db.prepare('SELECT * FROM mcp_server_tokens WHERE id=?').get(input.id) as TokenRow), token, alreadyCreated: false };
}
export function listPeerTokens(db: DatabaseSync) {
  return { items: (db.prepare("SELECT * FROM mcp_server_tokens WHERE kind='peer' ORDER BY created DESC,id").all() as TokenRow[]).map(metadata) };
}
export function revokePeerToken(db: DatabaseSync, peerId: string, request: { id: string }, now = Date.now()) {
  if (!uuid.test(peerId) || !request || Object.keys(request).some(key => key !== 'id') || typeof request.id !== 'string' || !uuid.test(request.id)) throw new McpServerError(400, 'Invalid revocation request.');
  const digest = hashToken(JSON.stringify({ revoke: peerId }));
  const prior = db.prepare('SELECT * FROM mcp_server_commands WHERE id=?').get(request.id);
  if (prior) { if (prior.digest !== digest) throw new McpServerError(409, 'ID was already used for a different change.'); return JSON.parse(String(prior.result)) as { id: string; revoked: number }; }
  const row = db.prepare("SELECT * FROM mcp_server_tokens WHERE id=? AND kind='peer'").get(peerId) as TokenRow | undefined;
  if (!row) throw new McpServerError(404, 'Peer token not found.');
  const result = { id: peerId, revoked: row.revoked ?? now };
  db.prepare('UPDATE mcp_server_tokens SET revoked=? WHERE id=?').run(result.revoked, peerId);
  db.prepare('INSERT INTO mcp_server_commands VALUES (?,?,?)').run(request.id, digest, JSON.stringify(result));
  return result;
}
export function mintAgentSession(db: DatabaseSync, input: AgentSessionInput, now = Date.now()) {
  if (!input || Object.keys(input).some(key => !['agent','turn','scopes','ttlMs'].includes(key)) || typeof input.agent !== 'string' || !uuid.test(input.agent) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 86_400_000 || !db.prepare('SELECT 1 FROM agents WHERE id=?').get(input.agent)) throw new McpServerError(400, 'Invalid agent session.');
  const scopes = parseScopes(input.scopes);
  if (scopes.includes('machine:update')) throw new McpServerError(403, 'Machine updates require an owner-authorized paired peer.');
  if (input.turn !== undefined && (typeof input.turn !== 'string' || !uuid.test(input.turn) || !db.prepare("SELECT 1 FROM turns WHERE id=? AND agent=? AND status='running'").get(input.turn, input.agent))) throw new McpServerError(400, 'Agent session requires its running turn.');
  const id = randomUUID(), token = randomBytes(32).toString('base64url'), expires = now + input.ttlMs;
  db.prepare("INSERT INTO mcp_server_tokens(id,token_hash,kind,name,agent,turn,scopes,created,expires,request_digest) VALUES (?,?,'session','',?,?,?,?,?,'')").run(id, hashToken(token), input.agent, input.turn ?? null, JSON.stringify(scopes), now, expires);
  return { id, token, expires };
}
export function revokeAgentSession(db: DatabaseSync, id: string, now = Date.now()) {
  db.prepare("UPDATE mcp_server_tokens SET revoked=coalesce(revoked,?) WHERE id=? AND kind='session'").run(now, id);
}
export function revokeEndedSessions(db: DatabaseSync, now = Date.now()) {
  db.prepare(`UPDATE mcp_server_tokens SET revoked=? WHERE kind='session' AND revoked IS NULL AND
    (expires<=? OR (turn IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.id=mcp_server_tokens.turn AND status='running')))` ).run(now, now);
}
export function verifyBearer(db: DatabaseSync, authorization: string | undefined, now = Date.now()): McpCaller | undefined {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) return;
  const row = db.prepare('SELECT * FROM mcp_server_tokens WHERE token_hash=?').get(hashToken(authorization.slice(7))) as TokenRow | undefined;
  if (!row || row.revoked !== null || row.expires !== null && row.expires <= now) return;
  if (row.kind === 'session' && row.turn && !db.prepare("SELECT 1 FROM turns WHERE id=? AND agent=? AND status='running'").get(row.turn, row.agent!)) { revokeAgentSession(db, row.id, now); return; }
  db.prepare('UPDATE mcp_server_tokens SET last_used=? WHERE id=?').run(now, row.id);
  return { id: row.id, kind: row.kind, scopes: JSON.parse(row.scopes), ...(row.kind === 'peer' ? { peer: row.name } : { agent: row.agent!, ...(row.turn ? { turn: row.turn } : {}) }) };
}
