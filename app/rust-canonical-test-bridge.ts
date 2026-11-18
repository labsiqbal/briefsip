import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ClerkClient } from '@clerk/backend';
import type { RoutineWebhookKeyring } from './test-support/routine-webhook-keyring.ts';

type Mail = { from: string; origin: string; keyId: string; key: Uint8Array; lookupKey: Uint8Array; keyFor?: (id: string) => Uint8Array };
export type CanonicalFixtures = { clerk?: ClerkClient; routineWebhookKeys?: RoutineWebhookKeyring; mail?: () => Mail };

export async function canonicalTestBridge(options: CanonicalFixtures) {
  if (!options.clerk && !options.routineWebhookKeys && !options.mail) return { config: undefined, close: async () => {} };
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new Error('Fixture input exceeds limit.'); }
      const args = JSON.parse(raw); let value: unknown;
      if (request.url === '/webhook-read') value = options.routineWebhookKeys!.read(args.name ?? undefined) ?? null;
      else if (request.url === '/webhook-create') value = options.routineWebhookKeys!.create(args.routine, args.generation);
      else if (request.url === '/mail-key') {
        const mail = options.mail!();
        value = args.name === 'mail-aead/active' ? mail.keyId : args.name === 'mail-lookup/v1' ? Buffer.from(mail.lookupKey).toString('base64url')
          : args.name.startsWith('mail-aead/') ? Buffer.from(args.name.slice(10) === mail.keyId ? mail.key : mail.keyFor!(args.name.slice(10))).toString('base64url') : null;
      } else if (request.url === '/clerk-user') {
        const user = await options.clerk!.users.getUser(args.subject);
        value = { id: user.id, banned: user.banned, locked: user.locked, email_addresses: user.emailAddresses.map(row => ({ email_address: row.emailAddress, verification: row.verification })) };
      } else if (request.url === '/clerk-revoke') { await options.clerk!.sessions.revokeSession(args.session); value = true; }
      else throw new Error('Unknown canonical fixture operation.');
      const body = JSON.stringify({ value }); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    } catch { response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"Canonical fixture unavailable."}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Canonical fixture did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token, clerk: !!options.clerk, mail: !!options.mail, webhook: !!options.routineWebhookKeys },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
