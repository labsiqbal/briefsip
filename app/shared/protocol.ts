import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';

export const PROTOCOL_VERSION = 1 as const;
export const REQUEST_LIMIT = 64 * 1024;
export const RESULT_LIMIT = 8 * 1024 * 1024;

export type Revision = number;
export type Id = string;
export type Digest = string;
export type Receipt = {
  requestId: Id;
  actorId: Id;
  projectId?: Id;
  payloadDigest: Digest;
  status: number;
  recordId: Id;
  recordRevision: Revision;
  committedAt: number;
};

export class ProtocolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.status = status; this.code = code; this.retryable = retryable; this.details = details;
    this.name = 'ProtocolError';
  }
}

export function errorEnvelope(error: ProtocolError, requestId: string) {
  return { ok: false as const, error: { code: error.code, message: error.message, retryable: error.retryable, requestId, ...(error.details ? { details: error.details } : {}) } };
}

export function successEnvelope<T>(data: T, revision?: Revision, receipt?: Receipt) {
  return { ok: true as const, data, ...(revision === undefined ? {} : { revision }), ...(receipt === undefined ? {} : { receipt }) };
}

export function base64url(value: unknown, size: number): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(size / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ProtocolError(400, 'invalid_encoding', 'Invalid base64url encoding.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw new ProtocolError(400, 'invalid_encoding', 'Invalid base64url size or encoding.');
  return bytes;
}
export function publicKey(value: unknown, kind: 'ed25519' | 'x25519') {
  // Ed25519 and X25519 SPKI both contain 44 bytes. Re-export prevents noncanonical DER.
  const bytes = base64url(value, 44);
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== kind || !key.export({ format: 'der', type: 'spki' }).equals(bytes)) throw new Error();
    return { encoded: String(value), key, thumbprint: sha256(bytes) };
  } catch { throw new ProtocolError(400, 'invalid_key', `Public key ${kind} is invalid.`); }
}
export function isUuidV4(value: unknown): value is Id {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function id(value: unknown, name = 'ID'): Id {
  if (!isUuidV4(value)) throw new ProtocolError(400, 'invalid_id', `${name} must be a UUID v4.`);
  return value.toLowerCase();
}

export function routeId(value: string): Id {
  try { return id(decodeURIComponent(value)); }
  catch { throw new ProtocolError(400, 'invalid_id', 'Route ID must be a UUID v4.'); }
}

export function revision(value: unknown, name = 'Revision'): Revision {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ProtocolError(400, 'invalid_revision', `${name} must be a nonnegative safe integer.`);
  return Number(value);
}

export function existingRevision(value: unknown, name = 'Revision'): Revision {
  const parsed = revision(value, name);
  if (parsed < 1) throw new ProtocolError(400, 'invalid_revision', `${name} must be greater than zero.`);
  return parsed;
}

export function time(value: unknown, name = 'Time'): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ProtocolError(400, 'invalid_time', `${name} must be a nonnegative epoch timestamp in milliseconds.`);
  return Number(value);
}

export function digest(value: unknown, name = 'Digest'): Digest {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new ProtocolError(400, 'invalid_digest', `${name} must be a lowercase SHA-256 hex string.`);
  return value;
}

export function label(value: unknown, name = 'Label', max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ProtocolError(400, 'invalid_label', `${name} is invalid.`);
  return value.trim();
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 254 || /[\u0000-\u001f\u007f]/.test(value)) throw new ProtocolError(400, 'invalid_email', 'Invalid email address.');
  const [local, domain, ...extra] = value.normalize('NFC').trim().split('@');
  if (!local || !domain || extra.length || Buffer.byteLength(local) > 64 || /[\s<>(),;:"\\]/u.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) throw new ProtocolError(400, 'invalid_email', 'Invalid email address.');
  const asciiDomain = domainToASCII(domain).toLowerCase();
  const normalized = `${local.toLowerCase()}@${asciiDomain}`;
  if (!asciiDomain || asciiDomain.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) || Buffer.byteLength(normalized) > 254) throw new ProtocolError(400, 'invalid_email', 'Invalid email address.');
  return normalized;
}

function scanValue(source: string, start: number, depth = 0): number {
  if (depth > 64) throw new ProtocolError(400, 'invalid_json', 'JSON is nested too deeply.');
  let i = start;
  while (/\s/.test(source[i] ?? '')) i++;
  const char = source[i];
  if (char === '"') {
    i++;
    while (i < source.length) {
      if (source[i] === '\\') i += 2;
      else if (source[i++] === '"') return i;
    }
    throw new ProtocolError(400, 'invalid_json', 'Incomplete JSON string.');
  }
  if (char === '{' || char === '[') {
    const close = char === '{' ? '}' : ']';
    const object = char === '{'; const keys = new Set<string>(); i++;
    while (true) {
      while (/\s/.test(source[i] ?? '')) i++;
      if (source[i] === close) return i + 1;
      if (object) {
        if (source[i] !== '"') throw new ProtocolError(400, 'invalid_json', 'JSON key must be a string.');
        const keyStart = i; i = scanValue(source, i, depth + 1); const key = JSON.parse(source.slice(keyStart, i)) as string;
        if (keys.has(key)) throw new ProtocolError(400, 'duplicate_key', `Duplicate JSON key: ${key}.`); keys.add(key);
        while (/\s/.test(source[i] ?? '')) i++;
        if (source[i++] !== ':') throw new ProtocolError(400, 'invalid_json', 'Invalid JSON object.');
      }
      i = scanValue(source, i, depth + 1);
      while (/\s/.test(source[i] ?? '')) i++;
      if (source[i] === ',') { i++; continue; }
      if (source[i] === close) return i + 1;
      throw new ProtocolError(400, 'invalid_json', 'Invalid JSON separator.');
    }
  }
  const match = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) throw new ProtocolError(400, 'invalid_json', 'Invalid JSON value.');
  return i + match[0].length;
}

export function parseJson(raw: string, maxBytes = REQUEST_LIMIT): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) throw new ProtocolError(413, 'payload_too_large', 'JSON payload exceeds the limit.', false, { maxBytes });
  let value: unknown;
  try { value = JSON.parse(raw, (_key, item) => { if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(); return item; }); }
  catch { throw new ProtocolError(400, 'invalid_json', 'Invalid JSON.'); }
  let end = scanValue(raw, 0); while (/\s/.test(raw[end] ?? '')) end++;
  if (end !== raw.length) throw new ProtocolError(400, 'invalid_json', 'JSON contains extra data.');
  return value;
}

export function closedObject(value: unknown, keys: readonly string[], name = 'Request'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(400, 'invalid_object', `${name} must be a JSON object.`);
  const data = value as Record<string, unknown>; const allowed = new Set(keys);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new ProtocolError(400, 'unknown_field', `Field ${key} is unknown.`);
  return data;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new ProtocolError(400, 'invalid_json', 'JSON number must be finite.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new ProtocolError(400, 'invalid_json', 'Unsupported JSON type.');
}

export function sha256(value: string | Uint8Array): Digest { return createHash('sha256').update(value).digest('hex'); }

export function digestCommand(value: unknown): Digest { return sha256(canonicalJson(value)); }

export function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function requestMetadata(headers: Headers) {
  if (headers.get('X-Minarbot-Protocol') !== String(PROTOCOL_VERSION)) throw new ProtocolError(426, 'unsupported_version', 'Unsupported protocol version.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.get('Content-Type') ?? '')) throw new ProtocolError(415, 'unsupported_media_type', 'Use Content-Type application/json.');
  return { requestId: id(headers.get('X-Minarbot-Request-Id'), 'requestId') };
}
