import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as sessions from './t3/mcp-session-registry.ts';
import type { AgentSessionIssuer } from './test-support/harness-types.ts';
type HarnessOptions = { issuer?: AgentSessionIssuer };

export type PdfFault = (signal: AbortSignal) => Promise<{ status: number; error: string } | undefined>;

export async function pdfTestBridge(fault?: PdfFault) {
  if (!fault) return { config: undefined, close: async () => {} };
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
          response.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PDF input exceeds limit.' }));
          return;
        }
      }
      const failure = await fault(controller.signal);
      if (failure) {
        response.writeHead(failure.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: failure.error }));
        return;
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'PDF fixture failed.' }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('PDF test bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

export async function harnessTestBridge(harness?: HarnessOptions) {
  if (!harness?.issuer) return { config: undefined, close: async () => {} };
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 65536) throw new Error('Test bridge payload exceeded.'); }
      const { operation, args } = JSON.parse(raw);
      const value = operation === 'mint' ? await harness.issuer!.mintAgentSession(args) : operation === 'revoke' ? await harness.issuer!.revokeAgentSession(args.id) : undefined;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value: value ?? null }));
    } catch { response.end(JSON.stringify({ error: 'Harness fixture bridge failed.' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export function rustMcpFacade(database: string) {
  const invoke = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(database); db.exec('PRAGMA busy_timeout=5000');
    try { return fn(db); } finally { db.close(); }
  };
  return {
    mintAgentSession: (input: sessions.AgentSessionInput) => invoke(db => sessions.mintAgentSession(db, input)),
    revokeAgentSession: (id: string) => invoke(db => sessions.revokeAgentSession(db, id)),
    verifyBearer: (value: string) => invoke(db => sessions.verifyBearer(db, value)),
    createPeerToken: (input: Parameters<typeof sessions.createPeerToken>[1]) => invoke(db => sessions.createPeerToken(db, input)),
  };
}
