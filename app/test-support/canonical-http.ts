import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './database.ts';
import { ProtocolError } from '../shared/protocol.ts';
import { startCanonicalApp } from '../test-bridge.ts';
import { installFrozenNodeSchema } from './canonical-schema.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwtKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const issuer = 'https://fixture.clerk.accounts.dev';

export function canonicalHttp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const database = join(dir, 'canonical.sqlite');
  const db = testDatabase(database);
  installFrozenNodeSchema(db);
  const addAccount = (subject: string, accountId = randomUUID()) => {
    db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(accountId, issuer, subject, Date.now());
    return { accountId, issuer, subject };
  };
  const owner = addAccount('user_owner');
  const auth = { jwtKey, issuer, origin: 'http://127.0.0.1', development: true, secretKey: 'sk_test_fixture', publishableKey: 'pk_test_' + Buffer.from('fixture.clerk.accounts.dev$').toString('base64') };
  let app: Awaited<ReturnType<typeof startCanonicalApp>> | undefined;
  let now = Date.now();
  const start = async (options: Partial<Parameters<typeof startCanonicalApp>[0]> = {}) => {
    await app?.close();
    now = options.fixedClock ?? Date.now();
    app = await startCanonicalApp({ database, auth: { ...auth }, syncKey: () => Buffer.alloc(32, 7), ...options });
  };
  const send = async (path: string, method = 'GET', body?: Record<string, unknown>, actor = owner) => {
    assert(app, 'Start the canonical fixture before sending a request');
    const seconds = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: issuer, sub: actor.subject, sid: `sess_${actor.subject}`, azp: app.origin, nbf: seconds - 1, exp: seconds + 600 })).toString('base64url');
    const input = `${header}.${claims}`;
    const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
    const response = await fetch(app.origin + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Origin: app.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': String(body?.requestId ?? randomUUID()) },
    });
    return { status: response.status, body: await response.json() };
  };
  const request = async (...args: Parameters<typeof send>) => {
    const { status, body } = await send(...args);
    if (status >= 400) throw new ProtocolError(status, body.error.code, body.error.message);
    assert.equal(body.ok, true);
    return { ...body, status };
  };
  const stop = async () => { await app?.close(); app = undefined; };
  const close = async () => { try { await stop(); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); } };
  return { dir, db, database, addAccount, owner, auth, start, send, request, stop, close };
}
