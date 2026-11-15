import { createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { digest, base64url, canonicalJson, closedObject, existingRevision, id, parseJson, ProtocolError, publicKey, sha256 } from '../protocol.ts';
import type { HubAuthority, NodePrincipal } from './project-authority.ts';
import type { HubRouting, RoutingFrame } from './routing.ts';
import { transaction } from './schema.ts';
export const NODE_FRAME_LIMIT = 65536;
export function signedNodeMessage(body: unknown, key: KeyObject, direction: 'hub' | 'node') {
    const keyId = sha256(createPublicKey(key).export({ type: 'spki', format: 'der' }));
    return { v: 1, keyId, body, signature: sign(null, Buffer.from(`briefsip.${direction}.v1\n${canonicalJson(body)}`), key).toString('base64url') };
}
export function verifiedNodeMessage(value: unknown, key: string, direction: 'hub' | 'node'): Record<string, unknown> {
    const envelope = closedObject(value, ['v', 'keyId', 'body', 'signature']), parsed = publicKey(key, 'ed25519');
    if (envelope.v !== 1 || envelope.keyId !== sha256(parsed.key.export({ type: 'spki', format: 'der' })) || !verify(null, Buffer.from(`briefsip.${direction}.v1\n${canonicalJson(envelope.body)}`), parsed.key, base64url(envelope.signature, 64)))
        throw new ProtocolError(401, 'invalid_signature', 'Invalid node link proof.');
    if (!envelope.body || typeof envelope.body !== 'object' || Array.isArray(envelope.body))
        throw new ProtocolError(400, 'invalid_frame', 'Invalid node link body.');
    return envelope.body as Record<string, unknown>;
}
type Enrollment = {
    nodeId: string;
    installationId: string;
    installationPublicKey: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
    label: string;
    nonce: string;
    capabilities: string[];
};
export type NodeLinkDeps = {
    authority: HubAuthority;
    routing: HubRouting;
    origin: string;
    signingKey: KeyObject;
    development?: boolean;
    now?: () => number;
};
const deny = () => new ProtocolError(403, 'node_link_denied', 'Node link is unavailable.');
/** Mount once on the dedicated hub server; never the member's local listener. */
export function attachNodeLink(hub: { mountNodeUpgrade(handler: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void): () => void }, deps: NodeLinkDeps) {
    const { authority: a, routing: r } = deps, db = a.db, now = deps.now ?? Date.now, origin = new URL(deps.origin);
    if (origin.origin !== deps.origin || origin.username || origin.password || origin.protocol !== 'https:' && !(deps.development && origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)))
        throw new Error('Hub node origin must be HTTPS.');
    if (deps.signingKey.asymmetricKeyType !== 'ed25519')
        throw new Error('Hub signer must be Ed25519.');
    db.exec(`CREATE TABLE IF NOT EXISTS node_link_codes (digest TEXT PRIMARY KEY,human_digest TEXT UNIQUE NOT NULL,candidate TEXT NOT NULL,account_id TEXT,expires_at INTEGER NOT NULL,next_poll INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS node_link_sessions (digest TEXT PRIMARY KEY,node_id TEXT NOT NULL,account_id TEXT NOT NULL,node_generation INTEGER NOT NULL,authority_generation TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS node_link_replays (digest TEXT PRIMARY KEY,expires_at INTEGER NOT NULL) STRICT;`);
    const sockets = new Map<string, {
        ws: WebSocket;
        principal: NodePrincipal;
        expiresAt: number;
        seen: number;
        reconciled: boolean;
        grants: string;
        delivered: Map<string, number>;
    }>();
    const buckets = new Map<string, {
        start: number;
        count: number;
        expiresAt:number;
    }>();
    const wss = new WebSocketServer({ noServer: true, maxPayload: NODE_FRAME_LIMIT, perMessageDeflate: false });
    let closed = false;
    const signed = (body: unknown) => signedNodeMessage(body, deps.signingKey, 'hub');
    function limit(bucket: string, capacity: number, window = 60000) {
        for (const [key, v] of buckets)
            if (v.expiresAt <= now())
                buckets.delete(key);
        const v = buckets.get(bucket) ?? { start: now(), count: 0,expiresAt:now()+window };
        if (buckets.size >= 8192 && !buckets.has(bucket) || ++v.count > capacity)
            throw new ProtocolError(429, 'rate_limited', 'Node link limit reached.', true);
        buckets.set(bucket, v);
    }
    function exactRequest(req: IncomingMessage) {
        if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length !== 1 || req.headers.host !== origin.host || req.headers.forwarded || req.headers['x-forwarded-host'] || req.headers.origin || req.headers.cookie || req.url?.includes('?'))
            throw deny();
    }
    function fresh(body: Record<string, unknown>, scope: string) {
        const nonce = base64url(body.nonce, 32).toString('base64url');
        if (!Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || Number(body.issuedAt) > now() + 5000 || Number(body.issuedAt) < now() - 60000 || Number(body.expiresAt) <= now() || Number(body.expiresAt) > Number(body.issuedAt) + 60000)
            throw deny();
        db.prepare('DELETE FROM node_link_replays WHERE expires_at<?').run(now());
        const digest = sha256(`${scope}:${nonce}`);
        if (db.prepare('SELECT 1 FROM node_link_replays WHERE digest=?').get(digest))
            throw deny();
        db.prepare('INSERT INTO node_link_replays VALUES(?,?)').run(digest, body.expiresAt as number);
    }
    function session(nodeId: string, accountId: string, generation: number) {
        const token = randomBytes(32).toString('base64url'), expiresAt = now() + 900000;
        db.prepare('DELETE FROM node_link_sessions WHERE node_id=? OR expires_at<=?').run(nodeId, now());
        db.prepare('INSERT INTO node_link_sessions VALUES(?,?,?,?,?,?)').run(sha256(token), nodeId, accountId, generation, a.generation(), expiresAt);
        return { token, expiresAt, nodeId, accountId, nodeGeneration: generation, authorityGeneration: a.generation() };
    }
    function candidate(value: unknown): Enrollment {
        const c = closedObject(value, ['nodeId', 'installationId', 'installationPublicKey', 'signingPublicKey', 'encryptionPublicKey', 'label', 'nonce', 'capabilities']);
        if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 120 || /[\u0000-\u001f]/.test(c.label) || !Array.isArray(c.capabilities) || c.capabilities.length > 16 || c.capabilities.some(v => typeof v !== 'string' || !/^[a-z-]{1,40}$/.test(v)))
            throw deny();
        const installationPublicKey = publicKey(c.installationPublicKey, 'ed25519').encoded, signingPublicKey = publicKey(c.signingPublicKey, 'ed25519').encoded;
        if (installationPublicKey === signingPublicKey)
            throw deny();
        return { nodeId: id(c.nodeId), installationId: id(c.installationId), installationPublicKey, signingPublicKey, encryptionPublicKey: publicKey(c.encryptionPublicKey, 'x25519').encoded, label: c.label, nonce: base64url(c.nonce, 32).toString('base64url'), capabilities: [...new Set(c.capabilities as string[])].sort() };
    }
    function start(value: unknown, source: string) {
        limit(`enroll:${source}`, 10);
        limit('enroll:global', 400);
        const d = closedObject(value, ['candidate', 'installationProof', 'nodeProof']), c = candidate(d.candidate);
        const proof = verifiedNodeMessage(d.nodeProof, c.signingPublicKey, 'node'), install = verifiedNodeMessage(d.installationProof, c.installationPublicKey, 'node');
        if (canonicalJson(proof) !== canonicalJson(install) || canonicalJson(proof) !== canonicalJson({ kind: 'enrollment.start', candidate: c, origin: deps.origin }))
            throw deny();
        db.prepare('DELETE FROM node_link_codes WHERE expires_at<=?').run(now());
        if (Number(db.prepare('SELECT count(*) AS n FROM node_link_codes').get()!.n) >= 4096 || Number(db.prepare("SELECT count(*) AS n FROM node_link_codes WHERE json_extract(candidate,'$.signingPublicKey')=?").get(c.signingPublicKey)!.n) >= 4)
            throw deny();
        const deviceCode = randomBytes(32).toString('base64url'), humanCode = randomBytes(6).toString('hex').toUpperCase(), expiresAt = now() + 300000;
        db.prepare('INSERT INTO node_link_codes VALUES(?,?,?,NULL,?,?,0)').run(sha256(deviceCode), sha256(humanCode), canonicalJson(c), expiresAt, now());
        return { kind: 'enrollment.started', deviceCode, humanCode, expiresAt, intervalMs: 5000, verificationUri: `${deps.origin}/nodes/link`, candidateDigest: sha256(canonicalJson(c)), authorityGeneration: a.generation() };
    }
    function inspectEnrollment(accountId: string, humanCode: string) {
        a.account(accountId);
        limit(`claim:${accountId}`, 10);
        if (!/^[A-F0-9]{12}$/.test(humanCode))
            throw deny();
        const row = db.prepare('SELECT * FROM node_link_codes WHERE human_digest=? AND expires_at>? AND consumed=0').get(sha256(humanCode), now());
        if (!row || row.account_id && row.account_id !== accountId)
            throw deny();
        const c = JSON.parse(String(row.candidate)) as Enrollment;
        return { nodeId: c.nodeId, installationId: c.installationId, label: c.label, capabilities: c.capabilities, fingerprint: sha256(c.signingPublicKey), accountId, expiresAt: Number(row.expires_at) };
    }
    function approveEnrollment(accountId: string, humanCode: string) {
        inspectEnrollment(accountId, humanCode);
        db.prepare('UPDATE node_link_codes SET account_id=? WHERE human_digest=? AND consumed=0').run(accountId, sha256(humanCode));
        return { approved: true };
    }
    function poll(value: unknown) {
        const d = closedObject(value, ['deviceCode', 'proof']), code = base64url(d.deviceCode, 32).toString('base64url');
        const row = db.prepare('SELECT * FROM node_link_codes WHERE digest=? AND expires_at>? AND consumed=0').get(sha256(code), now());
        if (!row)
            throw deny();
        const c = JSON.parse(String(row.candidate)) as Enrollment, p = verifiedNodeMessage(d.proof, c.signingPublicKey, 'node');
        closedObject(p, ['kind', 'deviceCodeDigest', 'candidateDigest', 'origin', 'nonce', 'issuedAt', 'expiresAt']);
        if (p.kind !== 'enrollment.poll' || p.deviceCodeDigest !== sha256(code) || p.candidateDigest !== sha256(canonicalJson(c)) || p.origin !== deps.origin)
            throw deny();
        fresh(p, c.nodeId);
        if (Number(row.next_poll) > now())
            throw new ProtocolError(429, 'slow_down', 'Wait before polling again.', true);
        db.prepare('UPDATE node_link_codes SET next_poll=? WHERE digest=?').run(now() + 5000, sha256(code));
        if (!row.account_id)
            return { kind: 'enrollment.pending' };
        const accountId = String(row.account_id);
        return transaction(db, () => {
            a.registerNode(accountId, { id: c.nodeId, installationId: c.installationId, signingPublicKey: c.signingPublicKey, encryptionPublicKey: c.encryptionPublicKey, capabilities: c.capabilities });
            db.prepare('UPDATE node_link_codes SET consumed=1 WHERE digest=?').run(sha256(code));
            return { kind: 'enrollment.complete', ...session(c.nodeId, accountId, 1) };
        });
    }
    function renew(value: unknown) {
        const d = closedObject(value, ['nodeId', 'proof']), n = a.one("SELECT * FROM nodes WHERE id=? AND status!='revoked'", id(d.nodeId));
        if (!n)
            throw deny();
        a.account(String(n.owner_account_id));
        const p = verifiedNodeMessage(d.proof, String(n.signing_public_key), 'node');
        closedObject(p, ['kind', 'nodeId', 'nodeGeneration', 'authorityGeneration', 'origin', 'nonce', 'issuedAt', 'expiresAt']);
        if (p.kind !== 'session.renew' || p.nodeId !== n.id || p.nodeGeneration !== n.generation || p.authorityGeneration !== a.generation() || p.origin !== deps.origin)
            throw deny();
        fresh(p, String(n.id));
        return { kind: 'session.renewed', ...session(String(n.id), String(n.owner_account_id), Number(n.generation)) };
    }
    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (!['/api/nodes/enrollment/start', '/api/nodes/enrollment/poll', '/api/nodes/session'].includes(req.url ?? ''))
            return false;
        try {
            exactRequest(req);
            if (req.method !== 'POST')
                throw deny();
            limit(`http:${req.socket.remoteAddress}`, 60);
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > NODE_FRAME_LIMIT)
                    throw new ProtocolError(413, 'payload_too_large', 'Node frame exceeds limit.');
                chunks.push(Buffer.from(chunk));
            }
            const value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), NODE_FRAME_LIMIT);
            const body = req.url!.endsWith('/start') ? start(value, req.socket.remoteAddress ?? 'unknown') : req.url!.endsWith('/poll') ? poll(value) : renew(value);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(canonicalJson(signed(body)));
        }
        catch (error) {
            const e = error instanceof ProtocolError ? error : deny();
            res.writeHead(e.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(canonicalJson(signed({ kind: 'error', code: e.code })));
        }
        return true;
    }
    function send(ws: WebSocket, body: unknown) {
        const data = canonicalJson(signed(body));
        if (Buffer.byteLength(data) > NODE_FRAME_LIMIT || ws.bufferedAmount > 1048576) {
            ws.close(4429, 'Backlog limit');
            return;
        }
        if (ws.readyState === WebSocket.OPEN)
            ws.send(data);
    }
    function ownerContext(principal: NodePrincipal, projectId: unknown) {
        const project = id(projectId), host = a.one('SELECT host FROM host_bindings WHERE project_id=? AND active=1', project);
        if (!host)
            throw deny();
        return a.resolveProject(String(host.host), principal.accountId, project);
    }
    function pump(link: ReturnType<typeof sockets.get>) {
        if (!link)
            return;
        a.node(link.principal);
        if (now() >= link.expiresAt || now() - link.seen >= 45000)
            throw new ProtocolError(401, 'node_expired', 'Node session expired.');
        if (!link.reconciled)
            return;
        const available = r.pending(link.principal).filter(f => {
            if (f.kind === 'grant.revoked') {
                const current = a.one('SELECT state,revision FROM participations WHERE project_id=? AND id=?', f.projectId, f.participationId);
                if (current?.state === 'active' && Number(current.revision) >= f.revision) {
                    r.acknowledge(link.principal, f.eventId, sha256(canonicalJson(f)));
                    return false;
                }
            }
            return true;
        });
        const controlsPending = available.some(f => f.kind === 'grant.revoked' || f.kind === 'turn.cancel');
        const pending = available.filter(f => {
            if (controlsPending && f.kind !== 'grant.revoked' && f.kind !== 'turn.cancel') return false;
            const previous = link.delivered.get(f.eventId);
            if (previous !== undefined && previous + 1000 > now())
                return false;
            link.delivered.set(f.eventId, now());
            return true;
        });
        for (const key of link.delivered.keys())
            if (link.delivered.get(key)! + 60000 < now())
                link.delivered.delete(key);
        for (const f of pending.filter(f => f.kind === 'grant.revoked' || f.kind === 'turn.cancel'))
            send(link.ws, f);
        if (controlsPending) return;
        const grants = r.grants(link.principal), encoded = canonicalJson(grants);
        if (encoded !== link.grants) {
            link.grants = encoded;
            send(link.ws, { kind: 'grants', grants, principal: link.principal, authorityGeneration: a.generation() });
        }
        for (const f of pending.filter(f => f.kind !== 'grant.revoked' && f.kind !== 'turn.cancel'))
            send(link.ws, f);
    }
    function fail(ws: WebSocket, error: unknown) { const e = error instanceof ProtocolError ? error : deny(); ws.close(e.status === 429 ? 4429 : e.status === 409 ? 4409 : e.status === 401 ? 4401 : 4403, e.code); }
    function upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
        if (req.url !== '/node')
            return;
        try {
            exactRequest(req);
            limit(`upgrade:${req.socket.remoteAddress}`, 10);
            if (wss.clients.size >= 1024)
                throw new ProtocolError(429, 'rate_limited', 'Node links full.');
            const token = /^Device ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1], row = token ? db.prepare('SELECT * FROM node_link_sessions WHERE digest=? AND expires_at>?').get(sha256(token), now()) : undefined;
            if (!row)
                throw deny();
            const n = a.one("SELECT * FROM nodes WHERE id=? AND status!='revoked'", String(row.node_id));
            if (!n || n.generation !== row.node_generation || row.authority_generation !== a.generation())
                throw deny();
            const raw = req.headers['x-briefsip-proof'];
            if (typeof raw !== 'string' || raw.length > 8192)
                throw deny();
            const p = verifiedNodeMessage(parseJson(raw, 8192), String(n.signing_public_key), 'node');
            closedObject(p, ['kind', 'nodeId', 'nodeGeneration', 'authorityGeneration', 'nonce', 'issuedAt', 'expiresAt', 'sessionDigest', 'method', 'path', 'origin']);
            if (p.kind !== 'connection.proof' || p.nodeId !== n.id || p.nodeGeneration !== n.generation || p.authorityGeneration !== a.generation() || p.sessionDigest !== sha256(token!) || p.method !== 'GET' || p.path !== '/node' || p.origin !== deps.origin)
                throw deny();
            fresh(p, String(n.id));
            const principal = a.connectNode(String(row.account_id), String(n.id), Number(n.generation));
            sockets.get(principal.nodeId)?.ws.close(4409, 'Connection replaced');
            wss.handleUpgrade(req, socket, head, ws => {
                const link = { ws, principal, expiresAt: Number(row.expires_at), seen: now(), reconciled: false, grants: '', delivered: new Map<string, number>() };
                sockets.set(principal.nodeId, link);
                send(ws, { kind: 'connection.ready', principal, authorityGeneration: a.generation(), expiresAt: link.expiresAt });
                const requests = new Map<string, string>();
                ws.on('message', (data, binary) => {
                    let authorizedRequest: string | undefined;
                    try {
                        if (binary)
                            throw deny();
                        limit(`frame:${principal.nodeId}`, 1200);
                        a.node(principal);
                        if (now() >= link.expiresAt)
                            throw deny();
                        link.seen = now();
                        const b = verifiedNodeMessage(parseJson(data.toString(), NODE_FRAME_LIMIT), String(n.signing_public_key), 'node');
                        const requestId = id(b.requestId), kind = b.kind;
                        if (canonicalJson(b.principal) !== canonicalJson(principal))
                            throw deny();
                        authorizedRequest=requestId;
                        const requestDigest = sha256(canonicalJson(b)), prior = requests.get(requestId);
                        if (prior && prior !== requestDigest) throw deny();
                        if (requests.size >= 4096)
                            throw new ProtocolError(429, 'rate_limited', 'Connection request budget reached.');
                        let result: unknown = {};
                        if (kind === 'connection.reconcile') {
                            closedObject(b, ['kind', 'requestId', 'principal', 'receipts', 'withdrawals', 'complete']);
                            if (!Array.isArray(b.withdrawals) || b.withdrawals.length > 100 || typeof b.complete !== 'boolean') throw deny();
                            for (const value of b.withdrawals as unknown[]) { const w = closedObject(value, ['projectId', 'participationId', 'revision']); a.withdrawNode(principal, id(w.projectId), id(w.participationId), existingRevision(w.revision)); }
                            if (!Array.isArray(b.receipts) || b.receipts.length > 100)
                                throw deny();
                            const outcomes = b.receipts.map(value => { const receipt = closedObject(value, ['projectId', 'turnId', 'sequence', 'digest']); const turn = a.one('SELECT state,result_sequence,request_json FROM turns WHERE project_id=? AND id=? AND node_id=?', id(receipt.projectId), id(receipt.turnId), principal.nodeId); digest(receipt.digest); if (!Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) < 0 || turn && receipt.digest !== sha256(String(turn.request_json)))
                                throw deny(); return { projectId: receipt.projectId, turnId: receipt.turnId, state: turn?.state ?? 'unknown', sequence: turn?.result_sequence ?? 0 }; });
                            link.reconciled = b.complete;
                            result = { outcomes };
                        }
                        else {
                            if (!link.reconciled)
                                throw deny();
                            if (kind === 'heartbeat') {
                                closedObject(b, ['kind', 'requestId', 'principal']);
                                result = { expiresAt: link.expiresAt };
                            }
                            else if (kind === 'delivery.ack') {
                                closedObject(b, ['kind', 'requestId', 'principal', 'eventId', 'frameDigest']);
                                r.acknowledge(principal, id(b.eventId), String(b.frameDigest));
                            }
                            else if (kind === 'turn.result') {
                                closedObject(b, ['kind', 'requestId', 'principal', 'frame']);
                                const frame = b.frame as RoutingFrame;
                                if (frame?.kind === 'turn.admitted' && !a.one('SELECT 1 FROM node_results WHERE project_id=? AND turn_id=? AND sequence=1', id(frame.projectId), id(frame.turnId))) {
                                    const active = Number(a.one("SELECT count(*) AS n FROM turns WHERE state='admitted'")!.n), owned = Number(a.one("SELECT count(*) AS n FROM turns WHERE state='admitted' AND payer_account_id=?", principal.accountId)!.n);
                                    if (active >= 16 || owned >= 4)
                                        throw new ProtocolError(429, 'rate_limited', 'Turn admission limit reached.', true);
                                }
                                if (frame?.kind === 'turn.partial')
                                    limit(`partials:${principal.nodeId}:${frame.turnId}`, 10, 1000);
                                result = r.accept(principal, b.frame);
                            }
                            else if (kind === 'action.lease.request') {
                                closedObject(b, ['kind', 'requestId', 'principal', 'value']);
                                result = r.lease(principal, b.value as Parameters<HubRouting['lease']>[1]);
                            }
                            else if (kind === 'participation.consent') {
                                closedObject(b, ['kind', 'requestId', 'principal', 'projectId', 'participationId', 'revision', 'policyDigest']);
                                a.consent(ownerContext(principal, b.projectId), id(b.participationId), existingRevision(b.revision), String(b.policyDigest), 'owner', principal);
                                result = { grants: r.grants(principal).filter(g => g.projectId === b.projectId && g.participationId === b.participationId) };
                            }
                            else if (kind === 'participation.withdraw') {
                                closedObject(b, ['kind', 'requestId', 'principal', 'projectId', 'participationId', 'revision']);
                                a.withdrawNode(principal, id(b.projectId), id(b.participationId), existingRevision(b.revision));
                            }
                            else if (kind === 'node.revoke') {
                                closedObject(b, ['kind', 'requestId', 'principal']);
                                a.revokeNode(principal.accountId, principal.nodeId);
                            }
                            else
                                throw deny();
                        }
                        requests.set(requestId, requestDigest);
                        send(ws, { kind: 'response', requestId, result, principal });
                        pump(link);
                    }
                    catch (error) {
                        if(authorizedRequest&&error instanceof ProtocolError&&['authority_denied','resource_not_found','stale_revision','node_offline'].includes(error.code)){send(ws,{kind:'response',requestId:authorizedRequest,error:{status:error.status,code:error.code},principal});return;}
                        fail(ws, error);
                    }
                });
                ws.on('error', () => ws.terminate());
                ws.on('close', () => {
                    if (sockets.get(principal.nodeId) === link) {
                        sockets.delete(principal.nodeId);
                        try {
                            a.disconnectNode(principal);
                        }
                        catch { /* Already fenced. */ }
                    }
                });
            });
        }
        catch (error) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }
    }
    const unmount = hub.mountNodeUpgrade(upgrade);
    const timer = setInterval(() => {
        for (const link of sockets.values())
            try {
                pump(link);
            }
            catch (error) {
                fail(link.ws, error);
            }
    }, 250);
    timer.unref();
    return { handleHttp, inspectEnrollment, approveEnrollment, flush: () => {
            for (const link of sockets.values())
                try {
                    pump(link);
                }
                catch (error) {
                    fail(link.ws, error);
                }
        }, close: async () => {
            if (closed)
                return;
            closed = true;
            clearInterval(timer);
            unmount();
            for (const link of sockets.values())
                link.ws.terminate();
            await new Promise<void>(resolve => wss.close(() => resolve()));
        } };
}
