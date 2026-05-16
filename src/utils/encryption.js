/**
 * attendance-api/src/utils/encryption.js
 *
 * AES-256-GCM symmetric encryption for AI provider API keys.
 *
 * Why AES-256-GCM:
 *   - AES-256  → 256-bit key, industry standard
 *   - GCM mode → authenticated encryption: detects tampering. If the
 *                ciphertext is modified in the DB, decrypt() throws rather
 *                than silently returning garbage.
 *   - Built-in → Node.js crypto module, zero extra dependencies.
 *
 * Storage format (stored in ai_providers.api_key_encrypted):
 *   "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 *
 *   iv         — 12 random bytes, unique per encryption call. Never reused.
 *   authTag    — 16-byte GCM authentication tag. Verifies integrity on decrypt.
 *   ciphertext — encrypted API key bytes.
 *
 * Environment variable:
 *   AI_ENCRYPTION_KEY — 64-char hex string (= 32 bytes = 256-bit key)
 *
 *   Generate once:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 *   Add to .env:
 *     AI_ENCRYPTION_KEY=your64hexcharshere
 *
 *   !! If this key is lost, all stored API keys are unrecoverable. Back it up.
 *
 * Usage:
 *   import { encrypt, decrypt, decryptOrNull, isEncrypted } from './utils/encryption.js';
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;   // 96-bit IV — GCM recommended length
const TAG_BYTES = 16;   // 128-bit auth tag — GCM default
const KEY_BYTES = 32;   // 256-bit key

// ---------------------------------------------------------------------------
// Key loading — fail fast at module init, not at first runtime use
// ---------------------------------------------------------------------------

function loadKey() {
  const hex = process.env.AI_ENCRYPTION_KEY;

  if (!hex) {
    throw new Error(
      '[encryption] AI_ENCRYPTION_KEY is not set.\n' +
      'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `[encryption] AI_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars. Got ${hex.length}.`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('[encryption] AI_ENCRYPTION_KEY must contain only hex characters.');
  }

  return Buffer.from(hex, 'hex');
}

const ENCRYPTION_KEY = loadKey();

// ---------------------------------------------------------------------------
// encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @param  {string} plaintext
 * @returns {string} "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 */
export function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) {
    throw new Error('[encryption] encrypt() requires a non-empty string.');
  }

  const iv     = crypto.randomBytes(IV_BYTES); // fresh IV every call — critical for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag(); // must call AFTER final()

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

// ---------------------------------------------------------------------------
// decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a stored ciphertext string.
 * Throws if format is wrong, auth tag fails, or key is incorrect.
 * @param  {string} stored "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 * @returns {string} original plaintext
 */
export function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.trim()) {
    throw new Error('[encryption] decrypt() requires a non-empty string.');
  }

  const parts = stored.split(':');
  if (parts.length < 3) {
    throw new Error('[encryption] Invalid format. Expected "<hex_iv>:<hex_authTag>:<hex_ciphertext>".');
  }

  const iv         = Buffer.from(parts[0], 'hex');
  const authTag    = Buffer.from(parts[1], 'hex');
  // Rejoin from parts[2..] — handles API keys that may contain colons
  const ciphertext = Buffer.from(parts.slice(2).join(':'), 'hex');

  if (iv.length !== IV_BYTES) {
    throw new Error(`[encryption] IV must be ${IV_BYTES} bytes. Got ${iv.length}.`);
  }
  if (authTag.length !== TAG_BYTES) {
    throw new Error(`[encryption] Auth tag must be ${TAG_BYTES} bytes. Got ${authTag.length}.`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  // GCM auth check: throws "unable to authenticate data" if tampered or wrong key.
  // Do NOT catch this — let it propagate as a hard error.
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// decryptOrNull — safe version for route handlers
// ---------------------------------------------------------------------------

/**
 * Decrypt, returning null instead of throwing.
 * Use in routes where a missing/invalid key should return a clean 500,
 * not crash the process. Ollama passes null (no key needed) — returns null.
 * @param  {string|null} stored
 * @returns {string|null}
 */
export function decryptOrNull(stored) {
  if (stored == null) return null;
  try {
    return decrypt(stored);
  } catch (e) {
    console.error('[encryption] decryptOrNull failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// isEncrypted — format check to avoid double-encrypting
// ---------------------------------------------------------------------------

/**
 * Returns true if the string looks like our encrypted format.
 * Format check only — does NOT verify decryptability.
 * @param  {string} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length < 3) return false;
  return (
    parts[0].length === IV_BYTES  * 2 &&
    parts[1].length === TAG_BYTES * 2 &&
    /^[0-9a-f]+$/i.test(parts[0]) &&
    /^[0-9a-f]+$/i.test(parts[1])
  );
}