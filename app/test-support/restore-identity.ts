import { generateKeyPairSync, sign } from 'node:crypto';
import type { HumanActor } from './auth.ts';

export function restoreIdentity(owner: HumanActor, origin: string) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return (actor: HumanActor = owner) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: actor.issuer, sub: actor.subject, sid: actor.sessionId, azp: origin, exp: now + 300, nbf: now - 1 })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url');
    return {
      env: { BRIEFSIP_ORIGIN: origin, CLERK_ISSUER: owner.issuer, CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_PUBLISHABLE_KEY: 'pk_test_fixture', CLERK_JWT_KEY: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), CLERK_AUDIENCE: '' },
      input: JSON.stringify({ token: `${header}.${claims}.${signature}` }),
    };
  };
}
