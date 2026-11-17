import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AgentDesktopManager } from './agent-desktop.ts';
import type { PeerTokenIssuer } from './machines.ts';

type Options = { desktop?: ConstructorParameters<typeof AgentDesktopManager>[0]; peerTokenIssuer?: PeerTokenIssuer; machines?: { now?: () => number; healthIntervalMs?: number } };
export async function computerTestBridge(options: Options) {
  const token = randomBytes(32).toString('hex');
  const desktops = new Map<string, { child: import('node:child_process').ChildProcess; exited: boolean; env: NodeJS.ProcessEnv; profile: string }>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 65536) throw new Error('Test bridge payload exceeded.'); }
      const { operation, args } = JSON.parse(raw); let value: unknown;
      if (operation === 'clock') value = options.machines?.now?.() ?? Date.now();
      else if (operation === 'issue') value = options.peerTokenIssuer ? await options.peerTokenIssuer.createPeerToken(args) : null;
      else if (operation === 'revoke') value = options.peerTokenIssuer ? await options.peerTokenIssuer.revokePeerToken(args.id) : null;
      else if (operation === 'verify') value = options.peerTokenIssuer ? await options.peerTokenIssuer.verifyBearer(args.token) : null;
      else if (operation.startsWith('desktop-') && options.desktop?.runtime) {
        const runtime = options.desktop.runtime;
        if (operation === 'desktop-launch') {
          const launched = runtime.launch(args.env, args.profile, args.proxy), entry = { child: launched.child, exited: false, env: args.env, profile: args.profile };
          desktops.set(args.id, entry); launched.child.once('exit', () => { entry.exited = true; });
          await launched.ready; value = null;
        } else {
          const desktop = desktops.get(args.id); if (!desktop) throw new Error('Desktop fixture missing.');
          if (operation === 'desktop-status') value = desktop.exited;
          else if (operation === 'desktop-stop') {
            if (!desktop.exited) await new Promise<void>(resolve => { desktop.child.once('exit', () => resolve()); desktop.child.stdin?.end(); });
            desktops.delete(args.id); value = null;
          } else if (operation === 'desktop-input') value = (await runtime.run(args.args, desktop.env, desktop.profile)).toString('base64');
          else if (operation === 'desktop-capture') value = (await runtime.capture(desktop.env, desktop.profile)).toString('base64');
          else throw new Error('Unknown desktop fixture operation.');
        }
      }
      else throw new Error('Unknown test bridge operation.');
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value: value ?? null }));
    } catch (error) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: { status: (error as {status?: number}).status ?? 503, message: error instanceof Error ? error.message : 'Test bridge failed.' } })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => { for (const entry of desktops.values()) if (!entry.exited) entry.child.stdin?.end(); desktops.clear(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
