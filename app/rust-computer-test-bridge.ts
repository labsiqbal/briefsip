import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { PeerTokenIssuer } from './machines.ts';

type Options = { peerTokenIssuer?: PeerTokenIssuer; machines?: { now?: () => number; healthIntervalMs?: number } };
export async function computerTestBridge(options: Options) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 65536) throw new Error('Test bridge payload exceeded.'); }
      const { operation, args } = JSON.parse(raw); let value: unknown;
      if (operation === 'clock') value = options.machines?.now?.() ?? Date.now();
      else if (operation === 'issue') value = options.peerTokenIssuer ? await options.peerTokenIssuer.createPeerToken(args) : null;
      else if (operation === 'revoke') value = options.peerTokenIssuer ? await options.peerTokenIssuer.revokePeerToken(args.id) : null;
      else if (operation === 'verify') value = options.peerTokenIssuer ? await options.peerTokenIssuer.verifyBearer(args.token) : null;
      else throw new Error('Unknown test bridge operation.');
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value: value ?? null }));
    } catch (error) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: { status: (error as {status?: number}).status ?? 503, message: error instanceof Error ? error.message : 'Test bridge failed.' } })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
