import { createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { closedObject, normalizeEmail, parseJson, ProtocolError, sha256 } from '../protocol.ts';
import { transaction } from './schema.ts';
import { singleHeader, type HostGateway } from './host-gateway.ts';
import type { HubAuthority, IdentityVerifier, VerifiedIdentity } from './project-authority.ts';

export type SessionIdentity = VerifiedIdentity & { sessionId: string; expiresAt: number };
export interface SessionVerifier extends IdentityVerifier { verify(token: string): Promise<SessionIdentity> }
const invalid = () => new ProtocolError(401, 'session_invalid', 'Session is invalid or expired.');
const forbidden = () => new ProtocolError(403, 'origin_or_csrf_denied', 'Origin or CSRF proof is not allowed.');
const opaque = () => randomBytes(32).toString('base64url');
function proof(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  return value;
}
function httpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Exact HTTPS identity origin required.');
  return value;
}

/** Clerk RS256 verification using operator-pinned public JWKS only. Never fetches keys or users. */
export function createClerkVerifier(config: { issuer: string; accountsOrigin: string; audience?: string; jwks: { keys: (JsonWebKey & { kid: string; alg?: string; use?: string })[] }; now?: () => number }): SessionVerifier {
  httpsOrigin(config.issuer); httpsOrigin(config.accountsOrigin);
  const keys = new Map(config.jwks.keys.map(jwk => {
    if (!jwk.kid || jwk.kty !== 'RSA' || jwk.d || jwk.alg && jwk.alg !== 'RS256' || jwk.use && jwk.use !== 'sig') throw new Error('Pinned RSA signing JWKS required.');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('RSA key must be at least 2048 bits.');
    return [jwk.kid, key] as const;
  }));
  if (!keys.size || keys.size !== config.jwks.keys.length) throw new Error('Unique pinned signing keys required.');
  const now = config.now ?? Date.now;
  return { async verify(token) {
    try {
      if (typeof token !== 'string' || token.length > 16384) throw invalid();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, 'base64url').toString('base64url') !== part)) throw invalid();
      const header = parseJson(Buffer.from(parts[0], 'base64url').toString('utf8'), 2048) as Record<string, unknown>;
      const claims = parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'), 12288) as Record<string, unknown>;
      if (!header || !claims || header.alg !== 'RS256' || header.crit !== undefined || header.b64 !== undefined || typeof header.kid !== 'string') throw invalid();
      const key = keys.get(header.kid);
      if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw invalid();
      if (claims.iss !== config.issuer || claims.azp !== config.accountsOrigin || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || typeof claims.sid !== 'string' || !claims.sid || claims.sid.length > 256
        || !Number.isSafeInteger(claims.exp) || Number(claims.exp) * 1000 <= now() || !Number.isSafeInteger(claims.nbf) || Number(claims.nbf) * 1000 > now()
        || !Number.isSafeInteger(claims.iat) || Number(claims.iat) * 1000 > now() || Number(claims.iat) > Number(claims.exp) || claims.sts === 'pending'
        || config.audience !== undefined && !(claims.aud === config.audience || Array.isArray(claims.aud) && claims.aud.includes(config.audience))) throw invalid();
      // Optional signed Clerk custom claims; absent evidence never becomes a verified mailbox.
      const verifiedMailboxes = claims.email_verified === true && typeof claims.email === 'string' ? [normalizeEmail(claims.email)] : [];
      return { issuer: config.issuer, subject: claims.sub, sessionId: claims.sid, expiresAt: Number(claims.exp) * 1000, verifiedMailboxes };
    } catch { throw invalid(); }
  } };
}

/** Explicit local/dev fixture tokens. No subject supplied by an HTTP client can mint an account. */
export function createStubVerifier(tokens: ReadonlyMap<string, SessionIdentity>): SessionVerifier {
  const fixtures = new Map([...tokens].map(([token, identity]) => [token, structuredClone(identity)]));
  return { async verify(token) { const value = fixtures.get(token); if (!value) throw invalid(); return structuredClone(value); } };
}

export function browserCookie(request: IncomingMessage, name: string) {
  const entries = (singleHeader(request, 'cookie') ?? '').split(';').map(entry => entry.trim()).filter(entry => entry.startsWith(`${name}=`));
  if (entries.length !== 1) throw invalid();
  return proof(entries[0].slice(name.length + 1));
}
export function cookie(name: '__Host-session' | '__Host-login', value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, seconds)}`;
}
export function requireOrigin(request: IncomingMessage, host: string) {
  if (singleHeader(request, 'origin') !== `https://${host}`) throw forbidden();
}

export function createHubSessions(authority: HubAuthority, gateway: HostGateway, verifier: SessionVerifier) {
  const { db, now } = authority;
  // Dedicated extension tables; P1-A's checksummed authority migration remains immutable.
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS hub_browser_sessions (
      digest TEXT PRIMARY KEY, host TEXT NOT NULL, project_id TEXT, account_id TEXT NOT NULL REFERENCES accounts(id),
      identity_json TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL,
      parent_digest TEXT, generation TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS hub_browser_starts (
      state_digest TEXT PRIMARY KEY, browser_digest TEXT NOT NULL, host TEXT NOT NULL, project_id TEXT NOT NULL,
      generation TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS hub_browser_codes (
      digest TEXT PRIMARY KEY, state_digest TEXT NOT NULL UNIQUE REFERENCES hub_browser_starts(state_digest) ON DELETE CASCADE,
      parent_digest TEXT NOT NULL REFERENCES hub_browser_sessions(digest) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS hub_browser_denials (issuer TEXT NOT NULL, sid TEXT NOT NULL, PRIMARY KEY(issuer,sid)) STRICT;
  `));
  type Session = { digest: string; host: string; projectId?: string; accountId: string; identity: SessionIdentity; csrf: string; expiresAt: number; parent?: string; generation: string };
  function current(session: Session): Session {
    const identity = session.identity;
    if (session.expiresAt <= now() || identity.expiresAt <= now() || session.generation !== authority.generation() || db.prepare('SELECT 1 FROM hub_browser_denials WHERE issuer=? AND sid=?').get(identity.issuer, identity.sessionId)) throw invalid();
    const account = authority.account(session.accountId);
    if (account.issuer !== identity.issuer || account.subject !== identity.subject) throw invalid();
    if (session.parent) read(session.parent, gateway.accountsHost);
    if (session.projectId) gateway.project(session.host, session.accountId, session.projectId);
    return session;
  }
  function read(digest: string, host: string): Session {
    const row = db.prepare('SELECT * FROM hub_browser_sessions WHERE digest=? AND host=?').get(digest, host);
    if (!row) throw invalid();
    return current({ digest, host, projectId: row.project_id === null ? undefined : String(row.project_id), accountId: String(row.account_id), identity: JSON.parse(String(row.identity_json)), csrf: String(row.csrf), expiresAt: Number(row.expires_at), parent: row.parent_digest === null ? undefined : String(row.parent_digest), generation: String(row.generation) });
  }
  function get(request: IncomingMessage, host: string, mutation = false) {
    const session = read(sha256(browserCookie(request, '__Host-session')), host);
    if (mutation) {
      requireOrigin(request, host);
      if (singleHeader(request, 'x-csrf-token') !== session.csrf) throw forbidden();
    }
    return session;
  }
  function mint(host: string, accountId: string, identity: SessionIdentity, projectId?: string, parent?: Session) {
    const value = opaque(), csrf = opaque(), expiresAt = Math.min(identity.expiresAt, now() + 900000, parent?.expiresAt ?? Infinity);
    if (expiresAt <= now()) throw invalid();
    db.prepare('INSERT INTO hub_browser_sessions VALUES(?,?,?,?,?,?,?,?,?)').run(sha256(value), host, projectId ?? null, accountId, JSON.stringify(identity), csrf, expiresAt, parent?.digest ?? null, authority.generation());
    return { csrf, expiresAt, cookie: cookie('__Host-session', value, Math.floor((expiresAt - now()) / 1000)) };
  }
  function remove(digest: string) {
    db.prepare('DELETE FROM hub_browser_sessions WHERE parent_digest=? OR digest=?').run(digest, digest);
  }
  function rotate(request: IncomingMessage, host: string) {
    try { const old = read(sha256(browserCookie(request, '__Host-session')), host); remove(old.digest); }
    catch (error) { if (!(error instanceof ProtocolError)) throw error; }
  }
  return {
    get,
    prune() {
      db.prepare('DELETE FROM hub_browser_codes WHERE expires_at<=?').run(now());
      db.prepare('DELETE FROM hub_browser_starts WHERE expires_at<=? OR generation!=?').run(now(), authority.generation());
      db.prepare('DELETE FROM hub_browser_sessions WHERE expires_at<=? OR generation!=?').run(now(), authority.generation());
    },
    start(host: string) {
      const project = authority.one("SELECT p.id FROM host_bindings h JOIN projects p ON p.id=h.project_id WHERE h.host=? AND h.active=1 AND p.status='active'", gateway.registered(host));
      if (!project || host === gateway.accountsHost) throw invalid();
      const state = opaque(), browser = opaque();
      db.prepare('INSERT INTO hub_browser_starts VALUES(?,?,?,?,?,?)').run(sha256(state), sha256(browser), host, project.id, authority.generation(), now() + 300000);
      return { state, login: `https://${gateway.accountsHost}/login?state=${state}`, cookie: cookie('__Host-login', browser, 300) };
    },
    async login(request: IncomingMessage, host: string) {
      if (host !== gateway.accountsHost) throw invalid();
      requireOrigin(request, host);
      // Bootstrap CSRF is the central browser-bound nonce, not an ambient Clerk cookie.
      if (singleHeader(request, 'x-csrf-token') !== browserCookie(request, '__Host-login')) throw forbidden();
      const authorization = singleHeader(request, 'authorization') ?? '';
      if (!/^Bearer [^\s,]+$/.test(authorization)) throw invalid();
      const identity = await verifier.verify(authorization.slice(7));
      const { accountId } = await authority.authenticate({ verify: async () => identity }, authorization.slice(7));
      if (!identity.sessionId || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now()) throw invalid();
      return transaction(db, () => {
        if (db.prepare('SELECT 1 FROM hub_browser_denials WHERE issuer=? AND sid=?').get(identity.issuer, identity.sessionId)) throw invalid();
        authority.account(accountId); rotate(request, host);
        return mint(host, accountId, identity);
      });
    },
    bootstrap() {
      const nonce = opaque();
      return { csrf: nonce, cookie: cookie('__Host-login', nonce, 300) };
    },
    handoff(request: IncomingMessage, host: string, state: unknown) {
      const parent = get(request, host, true);
      if (host !== gateway.accountsHost) throw invalid();
      return transaction(db, () => {
        const start = db.prepare('SELECT * FROM hub_browser_starts WHERE state_digest=?').get(sha256(proof(state)));
        if (!start || Number(start.expires_at) <= now() || start.generation !== authority.generation()) throw invalid();
        gateway.project(String(start.host), parent.accountId, String(start.project_id));
        const value = opaque();
        db.prepare('INSERT INTO hub_browser_codes VALUES(?,?,?,?) ON CONFLICT(state_digest) DO UPDATE SET digest=excluded.digest,parent_digest=excluded.parent_digest,expires_at=excluded.expires_at').run(sha256(value), start.state_digest, parent.digest, Math.min(now() + 60000, parent.expiresAt));
        return { callback: `https://${start.host}/auth/callback#code=${value}&state=${state}`, expiresAt: Math.min(now() + 60000, parent.expiresAt) };
      });
    },
    redeem(request: IncomingMessage, host: string, input: unknown) {
      requireOrigin(request, host);
      const data = closedObject(input, ['state', 'code']), state = proof(data.state);
      if (singleHeader(request, 'x-csrf-token') !== state) throw forbidden();
      return transaction(db, () => {
        const row = db.prepare('SELECT s.*,c.digest,c.parent_digest,c.expires_at AS code_expires_at FROM hub_browser_starts s JOIN hub_browser_codes c ON c.state_digest=s.state_digest WHERE c.digest=? AND s.state_digest=?').get(sha256(proof(data.code)), sha256(state));
        if (!row || row.host !== host || Number(row.expires_at) <= now() || Number(row.code_expires_at) <= now() || row.generation !== authority.generation() || row.browser_digest !== sha256(browserCookie(request, '__Host-login'))) throw invalid();
        const parent = read(String(row.parent_digest), gateway.accountsHost);
        gateway.project(host, parent.accountId, String(row.project_id));
        rotate(request, host);
        const result = mint(host, parent.accountId, parent.identity, String(row.project_id), parent);
        db.prepare('DELETE FROM hub_browser_starts WHERE state_digest=?').run(row.state_digest);
        return result;
      });
    },
    logout(request: IncomingMessage, host: string, global: boolean) {
      const actor = get(request, host, true);
      transaction(db, () => {
        if (global) {
          db.prepare('INSERT OR IGNORE INTO hub_browser_denials VALUES(?,?)').run(actor.identity.issuer, actor.identity.sessionId);
          const rows = db.prepare('SELECT digest,identity_json FROM hub_browser_sessions').all();
          for (const row of rows) { const identity = JSON.parse(String(row.identity_json)); if (identity.issuer === actor.identity.issuer && identity.sessionId === actor.identity.sessionId) remove(String(row.digest)); }
        } else remove(actor.digest);
      });
      return { state: global ? 'upstream_pending' : 'host_revoked' };
    },
  };
}
export type HubSessions = ReturnType<typeof createHubSessions>;
