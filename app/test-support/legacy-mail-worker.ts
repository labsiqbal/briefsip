import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { closedObject, parseJson, ProtocolError } from '../shared/protocol.ts';
import { transaction } from './legacy-schema.ts';
import { decryptMail } from './mail-fixture.ts';

type SyncWriter = { appendRecord(project: string, kind: string, id: string): void };

export function createMailWorker(db: DatabaseSync, options: { apiKey: string; key: (keyId: string) => Uint8Array; endpoint?: string; development?: boolean; now?: () => number; sync?: SyncWriter }) {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails'; const url = new URL(endpoint);
  if (endpoint !== 'https://api.resend.com/emails' && !(options.development && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Mail endpoint must be Resend or a development loopback fixture');
  const now = options.now ?? Date.now;
  const retryDelays = [1000, 5000, 30000, 120000, 600000];
  async function deliver(invitationId: string) {
    const job = transaction(db, () => {
      const at = now();
      const row = db.prepare('SELECT o.*,i.project,i.authority_generation,i.email_hash,i.expires_at,i.state AS invitation_state FROM mail_outbox o JOIN invitations i ON i.id=o.id WHERE o.id=?').get(invitationId);
      if (!row || !['queued', 'sending', 'unknown'].includes(String(row.state)) || Number(row.next_attempt ?? 0) > at) return;
      const active = db.prepare("SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'").get();
      const owner = db.prepare("SELECT 1 FROM projects p JOIN accounts a ON a.id=p.account JOIN project_members m ON m.project=p.id AND m.account=a.id WHERE p.id=? AND p.deleted=0 AND a.blocked=0 AND m.deleted=0 AND m.role='owner'").get(row.project);
      if (!active || active.generation !== row.authority_generation || !owner || !['pending_delivery', 'sent'].includes(String(row.invitation_state))) {
        db.prepare("UPDATE invitations SET state=CASE WHEN state='accepted' THEN state ELSE 'revoked' END,revision=revision+1 WHERE id=?").run(invitationId);
        db.prepare("UPDATE mail_outbox SET state='revoked',ciphertext=X'' WHERE id=?").run(invitationId);
        options.sync?.appendRecord(String(row.project), 'invitation', invitationId); return;
      }
      if (Number(row.expires_at) <= at) {
        db.prepare("UPDATE invitations SET state='expired',revision=revision+1 WHERE id=?").run(invitationId);
        db.prepare("UPDATE mail_outbox SET state='revoked',ciphertext=X'' WHERE id=?").run(invitationId);
        options.sync?.appendRecord(String(row.project), 'invitation', invitationId); return;
      }
      if (row.first_attempt !== null && at - Number(row.first_attempt) >= 23 * 3600000 || Number(row.attempts) >= 8) {
        db.prepare("UPDATE invitations SET state='delivery_unknown',revision=revision+1 WHERE id=?").run(invitationId);
        db.prepare("UPDATE mail_outbox SET state='unknown',ciphertext=X'',next_attempt=NULL WHERE id=?").run(invitationId);
        options.sync?.appendRecord(String(row.project), 'invitation', invitationId); return;
      }
      if (!options.apiKey) throw new ProtocolError(503, 'mail_unavailable', 'Mail delivery is not configured yet.', true);
      const envelope = closedObject(parseJson(new TextDecoder('utf-8', { fatal: true }).decode(row.ciphertext as Uint8Array), 512 * 1024), ['v', 'alg', 'keyId', 'nonce', 'ciphertext', 'tag']);
      if (typeof envelope.keyId !== 'string') throw new ProtocolError(400, 'invalid_mail_envelope', 'Invalid keyId.');
      const opened = decryptMail(invitationId, Number(row.revision), String(row.authority_generation), String(row.email_hash), row.ciphertext as Uint8Array, options.key(envelope.keyId));
      if (opened.payloadDigest !== row.payload_digest) throw new ProtocolError(409, 'mail_payload_conflict', 'Mail digest does not match.');
      db.prepare("UPDATE mail_outbox SET state='sending',first_attempt=coalesce(first_attempt,?),next_attempt=?,attempts=attempts+1 WHERE id=?").run(at, at + 15000, invitationId);
      return { row, plaintext: opened.plaintext };
    });
    if (!job) return { state: 'deferred' as const };
    let state: 'sent' | 'unknown' | 'failed' = 'unknown', remoteId: string | null = null;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `minarbot-invite/${invitationId}/${job.row.revision}` }, body: new Uint8Array(job.plaintext), signal: AbortSignal.timeout(15000), redirect: 'error' });
      let result = ''; if (response.body) { for await (const chunk of response.body) { if (Buffer.byteLength(result) + chunk.length > 65536) throw new Error('Mail response exceeds limit'); result += Buffer.from(chunk).toString('utf8'); } }
      if (response.ok) { const parsed = closedObject(parseJson(result), ['id']); if (typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200) throw new Error('Missing mail delivery ID'); remoteId = parsed.id; state = 'sent'; }
      else if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        let code = ''; try { code = String((JSON.parse(result) as { name?: string }).name ?? ''); } catch { /* malformed error remains a terminal client error */ }
        state = response.status === 409 && code === 'concurrent_idempotent_requests' ? 'unknown' : 'failed';
      }
    } catch { state = 'unknown'; }
    return transaction(db, () => {
      const current = db.prepare('SELECT o.state,i.state AS invitation_state,i.authority_generation,i.project FROM mail_outbox o JOIN invitations i ON i.id=o.id WHERE o.id=?').get(invitationId)!;
      const generation = db.prepare("SELECT generation FROM authority_state WHERE id=1 AND serving_state='active'").get()?.generation;
      if (current.state !== 'sending' || current.authority_generation !== generation || ['accepted', 'revoked', 'expired'].includes(String(current.invitation_state))) return { state: 'deferred' as const };
      if (state === 'sent' || state === 'failed') {
        db.prepare('UPDATE invitations SET state=?,revision=revision+1 WHERE id=?').run(state, invitationId);
        db.prepare("UPDATE mail_outbox SET state=?,remote_id=?,ciphertext=X'',next_attempt=NULL WHERE id=?").run(state, remoteId, invitationId);
        options.sync?.appendRecord(String(current.project), 'invitation', invitationId);
      } else {
        const delay = retryDelays[Math.min(Number(job.row.attempts), retryDelays.length - 1)];
        db.prepare("UPDATE mail_outbox SET state='unknown',next_attempt=? WHERE id=?").run(now() + delay + randomBytes(1)[0], invitationId);
      }
      return { state };
    });
  }
  return { deliver };
}
