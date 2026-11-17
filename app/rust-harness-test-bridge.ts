import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as sessions from './t3/mcp-session-registry.ts';
import type { createMcpServer } from './mcp-server.ts';
import type { AgentSessionIssuer } from './harness.ts';
import { extractPdf, PdfError } from './pdf-text.ts';
type HarnessOptions = { issuer?: AgentSessionIssuer };

export async function pdfTestBridge() {
  const token = randomBytes(32).toString('hex'), active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    const controller = new AbortController(); active.add(controller);
    response.once('close', () => controller.abort());
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new PdfError(413, 'PDF input exceeds limit.'); chunks.push(chunk); }
      const text = await extractPdf(Buffer.concat(chunks), controller.signal);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text }));
    } catch (error) {
      response.writeHead(error instanceof PdfError ? error.status : 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof PdfError ? error.message : 'PDF fixture failed.' }));
    } finally { active.delete(controller); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('PDF test bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => {
    for (const controller of active) controller.abort();
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

export function rustMcpFacade(database: string): ReturnType<typeof createMcpServer> {
  const invoke = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(database); db.exec('PRAGMA busy_timeout=5000');
    try { return fn(db); } finally { db.close(); }
  };
  return {
    mintAgentSession: input => invoke(db => sessions.mintAgentSession(db, input)),
    revokeAgentSession: id => invoke(db => sessions.revokeAgentSession(db, id)),
    verifyBearer: value => invoke(db => sessions.verifyBearer(db, value)),
    createPeerToken: input => invoke(db => sessions.createPeerToken(db, input)),
    listPeerTokens: () => invoke(db => sessions.listPeerTokens(db)),
    revokePeerToken: (id, input) => invoke(db => sessions.revokePeerToken(db, id, input)),
    revokeEndedSessions: () => invoke(db => sessions.revokeEndedSessions(db)),
    registerTool: () => { throw new Error('not ported: runtime MCP tool registration through test facade'); },
    toolNames: () => { throw new Error('not ported: runtime MCP declarations through test facade'); },
    handle: async () => { throw new Error('not ported: in-process MCP HTTP dispatch through test facade'); },
    close: () => {},
  };
}
