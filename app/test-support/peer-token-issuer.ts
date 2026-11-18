import { randomBytes, randomUUID } from 'node:crypto';
// M1 integration seam: inject M1's issuer into startApp({ peerTokenIssuer }).
export type PeerTokenIssuer = {
  createPeerToken(input: { name: string; scopes: readonly string[] }): { id: string; token: string } | Promise<{ id: string; token: string }>;
  revokePeerToken(id: string): unknown | Promise<unknown>;
  verifyBearer(token: string): { id: string; scopes: readonly string[] } | null | Promise<{ id: string; scopes: readonly string[] } | null>;
};

export const peerUpdateTimeoutMs = 300_000;

// Test-only issuer. M1 supplies production persistence and bearer verification.
export function fakePeerTokenIssuer(): PeerTokenIssuer & { tokens: Map<string, { id: string; scopes: readonly string[] }>; issued: string[]; revoked: string[] } {
  const tokens = new Map<string, { id: string; scopes: readonly string[] }>(), issued: string[] = [], revoked: string[] = [];
  return { tokens, issued, revoked,
    createPeerToken({ scopes }) { const id = randomUUID(), token = `peer-canary-${randomBytes(32).toString('base64url')}`; tokens.set(token, { id, scopes: [...scopes] }); issued.push(token); return { id, token }; },
    revokePeerToken(id) { revoked.push(id); for (const [token, value] of tokens) if (value.id === id) tokens.delete(token); },
    verifyBearer(token) { return tokens.get(token) ?? null; },
  };
}
