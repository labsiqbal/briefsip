import { verify } from 'node:crypto';
import { base64url, closedObject, digestCommand, existingRevision, id, label, ProtocolError, publicKey } from '../shared/protocol.ts';

const knownCapabilities = new Set(['execution', 'workspace-read', 'workspace-write', 'browser', 'provider', 'mcp']);
const denied = () => new ProtocolError(401, 'device_session_invalid', 'Invalid session or device proof.');

export function deviceZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 120 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) throw new ProtocolError(400, 'invalid_zone', 'Use an IANA time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new ProtocolError(400, 'invalid_zone', 'Invalid IANA time zone.'); }
  return value;
}
export function capabilityList(value: unknown) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !knownCapabilities.has(item))) throw new ProtocolError(422, 'capability_missing', 'Unsupported device capability.');
  return [...new Set<string>(value)].sort();
}
export function parseLinkChallenge(value: unknown) {
  const d = closedObject(value, ['requestId', 'installationId', 'deviceId', 'mode', 'expectedGeneration', 'expectedKeyRevision', 'installationPublicKey', 'deviceSigningKey', 'deviceEncryptionKey', 'deviceLabel', 'requestedCapabilities', 'zone', 'zoneRevision']);
  if (d.mode !== 'new' && d.mode !== 'reenroll' && d.mode !== 'rotate') throw new ProtocolError(400, 'invalid_mode', 'Invalid enrollment mode.');
  if (d.mode === 'new' && (d.expectedGeneration !== undefined || d.expectedKeyRevision !== undefined)) throw new ProtocolError(400, 'invalid_revision', 'New enrollment does not accept an old revision.');
  const installationKey = publicKey(d.installationPublicKey, 'ed25519'), signingKey = publicKey(d.deviceSigningKey, 'ed25519'), encryptionKey = publicKey(d.deviceEncryptionKey, 'x25519');
  if (installationKey.thumbprint === signingKey.thumbprint) throw new ProtocolError(400, 'invalid_key', 'Installation and device must use different keys.');
  return { requestId: id(d.requestId), installationId: id(d.installationId), deviceId: id(d.deviceId), mode: d.mode,
    ...(d.mode === 'new' ? {} : { expectedGeneration: existingRevision(d.expectedGeneration), expectedKeyRevision: existingRevision(d.expectedKeyRevision) }),
    installationPublicKey: installationKey.encoded, deviceSigningKey: signingKey.encoded, deviceEncryptionKey: encryptionKey.encoded,
    deviceLabel: label(d.deviceLabel, 'deviceLabel', 120), requestedCapabilities: capabilityList(d.requestedCapabilities), zone: deviceZone(d.zone), zoneRevision: existingRevision(d.zoneRevision) };
}
export type DeviceDescriptor = { v: 1; accountId: string; installationId: string; deviceId: string; authorityGeneration: string; deviceGeneration: number; keyRevision: number; zone: string; zoneRevision: number; signingPublicKey: string; encryptionPublicKey: string; signature: string };
export function descriptorBody(d: Omit<DeviceDescriptor, 'signature'>) {
  return ['minarbot-device-descriptor-v1', d.accountId, d.installationId, d.deviceId, d.authorityGeneration, d.deviceGeneration, d.keyRevision, d.zone, d.zoneRevision, d.signingPublicKey, d.encryptionPublicKey];
}
export function parseDeviceDescriptor(value: unknown, checkSignature = true): DeviceDescriptor {
  const d = closedObject(value, ['v', 'accountId', 'installationId', 'deviceId', 'authorityGeneration', 'deviceGeneration', 'keyRevision', 'zone', 'zoneRevision', 'signingPublicKey', 'encryptionPublicKey', 'signature']);
  if (d.v !== 1) throw new ProtocolError(400, 'invalid_descriptor', 'Unsupported descriptor version.');
  const signing = publicKey(d.signingPublicKey, 'ed25519'), encryption = publicKey(d.encryptionPublicKey, 'x25519');
  const result: DeviceDescriptor = { v: 1, accountId: id(d.accountId), installationId: id(d.installationId), deviceId: id(d.deviceId), authorityGeneration: id(d.authorityGeneration), deviceGeneration: existingRevision(d.deviceGeneration), keyRevision: existingRevision(d.keyRevision), zone: deviceZone(d.zone), zoneRevision: existingRevision(d.zoneRevision), signingPublicKey: signing.encoded, encryptionPublicKey: encryption.encoded, signature: String(d.signature) };
  const signature = base64url(d.signature, 64);
  if (checkSignature && !verify(null, Buffer.from(JSON.stringify(descriptorBody(result))), signing.key, signature)) throw denied();
  return result;
}
export type LinkChallengeResponse = { challengeId: string; accountId: string; clerkSub: string; authorityGeneration: string; deviceGeneration: number; keyRevision: number; nonce: string; expiresAt: number; installationThumbprint: string; signingThumbprint: string; encryptionThumbprint: string };
export function deviceLinkBody(c: ReturnType<typeof parseLinkChallenge>, r: LinkChallengeResponse) {
  return ['minarbot-link-v1', r.challengeId, r.accountId, r.clerkSub, c.installationId, c.deviceId, r.installationThumbprint, r.signingThumbprint, r.encryptionThumbprint, c.deviceLabel, digestCommand(['minarbot-device-capabilities-v1', c.requestedCapabilities]), r.authorityGeneration, r.deviceGeneration, r.keyRevision, c.zone, c.zoneRevision, c.mode, c.expectedGeneration ?? null, c.expectedKeyRevision ?? null, r.nonce, r.expiresAt];
}
export type DeviceProof = { deviceId: string; deviceGeneration: number; authorityGeneration: string; requestId: string; nonce: string; iat: number; exp: number; method: string; path: string; bodyDigest: string; signature: string };
export function deviceProofBody(p: Omit<DeviceProof, 'signature'>) { return ['minarbot-device-request-v1', p.deviceId, p.deviceGeneration, p.authorityGeneration, p.requestId, p.nonce, p.iat, p.exp, p.method, p.path, p.bodyDigest]; }
