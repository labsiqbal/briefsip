import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { closedObject, isUuidV4, parseJson, ProtocolError, sha256 } from '../shared/protocol.ts';

export type MailPayload = { to: string; from: string; subject: string; text: string; html?: string };
export type MailEnvelope = { v: 1; alg: 'AES-256-GCM'; keyId: string; nonce: string; ciphertext: string; tag: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new ProtocolError(400, 'invalid_mail_envelope', `${name} is invalid.`);
  const decoded = Buffer.from(value, 'base64url');
  if (b64(decoded) !== value) throw new ProtocolError(400, 'invalid_mail_envelope', `${name} is not canonical.`);
  return decoded;
};

function payload(value: unknown): MailPayload {
  const data = closedObject(value, ['to', 'from', 'subject', 'text', 'html'], 'Mail payload');
  for (const key of ['to', 'from', 'subject', 'text'] as const) if (typeof data[key] !== 'string' || !data[key] || data[key].length > (key === 'text' ? 128 * 1024 : 320) || (key === 'text' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(data[key])) throw new ProtocolError(400, 'invalid_mail_payload', 'Invalid mail payload.');
  if (data.html !== undefined && (typeof data.html !== 'string' || data.html.length > 256 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.html))) throw new ProtocolError(400, 'invalid_mail_payload', 'Invalid mail HTML.');
  return { to: data.to as string, from: data.from as string, subject: data.subject as string, text: data.text as string, ...(data.html === undefined ? {} : { html: data.html as string }) };
}

function aad(invitationId: string, revision: number, authorityGeneration: string, emailHash: string): Buffer {
  return Buffer.from(JSON.stringify(['briefsip-mail-outbox-v1', invitationId, revision, authorityGeneration, emailHash]));
}

export function encryptMail(invitationId: string, outboxRevision: number, authorityGeneration: string, emailHash: string, value: unknown, keyId: string, key: Uint8Array): { envelope: MailEnvelope; plaintext: Buffer; payloadDigest: string } {
  if (!isUuidV4(invitationId) || !Number.isSafeInteger(outboxRevision) || outboxRevision < 1 || !isUuidV4(authorityGeneration) || !/^[0-9a-f]{64}$/.test(emailHash) || !isUuidV4(keyId) || key.length !== 32) throw new ProtocolError(400, 'invalid_mail_context', 'Invalid mail context.');
  const body = Buffer.from(JSON.stringify(payload(value)), 'utf8');
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(invitationId, outboxRevision, authorityGeneration, emailHash));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const envelope = { v: 1 as const, alg: 'AES-256-GCM' as const, keyId, nonce: b64(nonce), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
  return { envelope, plaintext: body, payloadDigest: sha256(body) };
}

export function serializeMailEnvelope(envelope: MailEnvelope): Buffer { return Buffer.from(JSON.stringify(envelope), 'utf8'); }

export function decryptMail(invitationId: string, outboxRevision: number, authorityGeneration: string, emailHash: string, serialized: Uint8Array, key: Uint8Array): { payload: MailPayload; plaintext: Buffer; payloadDigest: string; keyId: string } {
  if (key.length !== 32 || serialized.length > 512 * 1024) throw new ProtocolError(503, 'mail_key_unavailable', 'Mail key is unavailable.', true);
  let parsed: unknown; try { parsed = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(serialized), 512 * 1024); } catch { throw new ProtocolError(400, 'invalid_mail_envelope', 'Invalid mail envelope.'); }
  const data = closedObject(parsed, ['v', 'alg', 'keyId', 'nonce', 'ciphertext', 'tag'], 'Mail envelope');
  if (data.v !== 1 || data.alg !== 'AES-256-GCM' || !isUuidV4(data.keyId)) throw new ProtocolError(400, 'invalid_mail_envelope', 'Invalid envelope version or algorithm.');
  const nonce = unb64(data.nonce, 'nonce'), ciphertext = unb64(data.ciphertext, 'ciphertext'), tag = unb64(data.tag, 'tag');
  if (nonce.length !== 12 || tag.length !== 16) throw new ProtocolError(400, 'invalid_mail_envelope', 'Invalid envelope size.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad(invitationId, outboxRevision, authorityGeneration, emailHash)); decipher.setAuthTag(tag);
    const body = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let value: unknown; try { value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(body), 512 * 1024); } catch { throw new ProtocolError(400, 'invalid_mail_payload', 'Invalid mail content.'); }
    return { payload: payload(value), plaintext: body, payloadDigest: sha256(body), keyId: data.keyId };
  } catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError(400, 'mail_auth_failed', 'Mail envelope failed verification.'); }
}

export function mailLookupDigest(normalizedEmail: string, lookupKey: Uint8Array): string {
  if (lookupKey.length !== 32) throw new Error('Mail lookup key must be 32 bytes');
  return createHmac('sha256', lookupKey).update(normalizedEmail, 'utf8').digest('hex');
}
