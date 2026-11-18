import { randomBytes, randomUUID } from 'node:crypto';
import type { PeerTokenIssuer } from '../machines.ts';

// Test-only issuer. M1 supplies production persistence and bearer verification.
export function fakePeerTokenIssuer(): PeerTokenIssuer & { tokens: Map<string, { id: string; scopes: readonly string[] }>; issued: string[]; revoked: string[] } {
  const tokens = new Map<string, { id: string; scopes: readonly string[] }>(), issued: string[] = [], revoked: string[] = [];
  return { tokens, issued, revoked,
    createPeerToken({ scopes }) { const id = randomUUID(), token = `peer-canary-${randomBytes(32).toString('base64url')}`; tokens.set(token, { id, scopes: [...scopes] }); issued.push(token); return { id, token }; },
    revokePeerToken(id) { revoked.push(id); for (const [token, value] of tokens) if (value.id === id) tokens.delete(token); },
    verifyBearer(token) { return tokens.get(token) ?? null; },
  };
}
