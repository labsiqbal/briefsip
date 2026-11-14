// Adapted from T3 0af2d216: contracts/auth.ts and auth/PairingGrantStore.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see NOTICE and provenance.json.
import { randomBytes } from 'node:crypto';
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIRING_CODE_LENGTH = 12;
const PAIRING_TOKEN_REJECTION_LIMIT = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
export function generatePairingToken() {
  let credential = '';
  while (credential.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH)) {
      if (byte >= PAIRING_TOKEN_REJECTION_LIMIT) continue;
      credential += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]!;
      if (credential.length === PAIRING_CODE_LENGTH) return credential;
    }
  }
  return credential;
}
export const pairingTokenPattern = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`, 'i');
