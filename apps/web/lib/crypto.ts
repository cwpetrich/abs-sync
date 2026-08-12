import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getEnv } from './env';

/**
 * Credential encryption at rest.
 *
 * Server credentials (API keys, passwords) are the whole prize if this app's
 * database leaks, so they are never stored in plaintext. AES-256-GCM gives
 * confidentiality plus tamper detection; the key is derived from
 * ABS_SYNC_SECRET via scrypt so a human-typed secret is still a strong key.
 */

const VERSION = 'v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const SCRYPT_SALT = 'abs-sync/credential-encryption/v1';

let keyCache: { secret: string; key: Buffer } | null = null;

function deriveKey(): Buffer {
  const { secret } = getEnv();
  if (keyCache && keyCache.secret === secret) return keyCache.key;
  // N=16384 keeps derivation ~50ms, and it only happens once per process.
  const key = scryptSync(secret, SCRYPT_SALT, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  keyCache = { secret, key };
  return key;
}

/** Encrypts an arbitrary JSON-serializable value. */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

/** Decrypts a value produced by encryptJson. */
export function decryptJson<T>(payload: string): T {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError('Stored credential is not in the expected format');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch (cause) {
    throw new DecryptionError(
      'Could not decrypt a stored credential. This usually means ABS_SYNC_SECRET changed — ' +
        're-enter the affected server credentials.',
      { cause },
    );
  }
}

/** Constant-time string comparison, for any future shared-secret checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Redacts a secret for display, keeping just enough to identify it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
