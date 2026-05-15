/**
 * attendance-api/utils/encryption.js
 *
 * AES-256-GCM symmetric encryption for AI provider API keys.
 *
 * Why AES-256-GCM:
 *   - AES-256     → 256-bit key, industry standard, no known practical attacks
 *   - GCM mode    → authenticated encryption: detects tampering in addition to
 *                   encrypting. If the ciphertext is modified in the DB, decrypt()
 *                   throws rather than silently returning garbage.
 *   - Built-in    → Node.js crypto module, zero extra dependencies.
 *
 * Storage format (stored in ai_providers.api_key_encrypted):
 *   "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 *
 *   iv         — 12 random bytes (96-bit), unique per encryption call.
 *                GCM standard recommends 12 bytes. Never reused with same key.
 *   authTag    — 16 bytes GCM authentication tag. Verifies integrity on decrypt.
 *   ciphertext — encrypted API key bytes.
 *
 * Environment variable:
 *   AI_ENCRYPTION_KEY — 64-character hex string (= 32 bytes = 256-bit key).
 *
 *   Generate once and store securely:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 *   Add to .env:
 *     AI_ENCRYPTION_KEY=your64hexcharshere
 *
 *   !! If this key is lost, all stored API keys become unrecoverable.
 *   !! Back it up in a password manager or secure vault.
 *
 * Usage:
 *   const { encrypt, decrypt, isEncrypted } = require('./utils/encryption');
 *
 *   // Before storing to DB:
 *   const stored = encrypt('sk-ant-api03-...');
 *
 *   // Before passing to API client:
 *   const plaintext = decrypt(stored);
 *
 *   // Check if a value is already encrypted (avoid double-encrypting):
 *   if (!isEncrypted(value)) stored = encrypt(value);
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES   = 12;   // 96-bit IV — GCM recommended length
const TAG_BYTES  = 16;   // 128-bit auth tag — GCM default
const KEY_BYTES  = 32;   // 256-bit key

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

/**
 * Load and validate the encryption key from environment.
 * Called once at module load — crashes early if misconfigured rather than
 * failing silently at runtime when an admin tries to save an API key.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function loadKey() {
  const hex = process.env.AI_ENCRYPTION_KEY;

  if (!hex) {
    throw new Error(
      '[encryption] AI_ENCRYPTION_KEY is not set in environment. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `[encryption] AI_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes). ` +
      `Got ${hex.length} characters.`
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('[encryption] AI_ENCRYPTION_KEY must contain only hex characters (0-9, a-f).');
  }

  return Buffer.from(hex, 'hex');
}

// Load key at module initialisation — fail fast, not at first API key save.
const ENCRYPTION_KEY = loadKey();

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param  {string} plaintext — the API key or any sensitive string
 * @returns {string}          — "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 * @throws  {Error}           — if plaintext is empty or not a string
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.trim().length === 0) {
    throw new Error('[encryption] encrypt() requires a non-empty string.');
  }

  // Fresh random IV for every encryption call — critical for GCM security.
  // Reusing an IV with the same key breaks GCM's security guarantees entirely.
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // getAuthTag() must be called AFTER cipher.final()
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypt a stored ciphertext string back to plaintext.
 *
 * @param  {string} stored — "<hex_iv>:<hex_authTag>:<hex_ciphertext>"
 * @returns {string}       — original plaintext API key
 * @throws  {Error}        — if format is invalid, auth tag fails, or key is wrong
 */
function decrypt(stored) {
  if (typeof stored !== 'string' || stored.trim().length === 0) {
    throw new Error('[encryption] decrypt() requires a non-empty string.');
  }

  const parts = stored.split(':');

  // Validate format: must have exactly 3 colon-separated parts.
  // Note: some API keys contain colons (e.g. Anthropic: "sk-ant-api03-xxx:yyy").
  // We reconstruct ciphertext from parts[2..] to handle that safely.
  if (parts.length < 3) {
    throw new Error(
      '[encryption] Invalid encrypted format. Expected "<hex_iv>:<hex_authTag>:<hex_ciphertext>". ' +
      'The value may not be encrypted or may be corrupted.'
    );
  }

  const iv         = Buffer.from(parts[0], 'hex');
  const authTag    = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts.slice(2).join(':'), 'hex');

  // Validate lengths before attempting decryption
  if (iv.length !== IV_BYTES) {
    throw new Error(`[encryption] IV must be ${IV_BYTES} bytes. Got ${iv.length}.`);
  }

  if (authTag.length !== TAG_BYTES) {
    throw new Error(`[encryption] Auth tag must be ${TAG_BYTES} bytes. Got ${authTag.length}.`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  // If the ciphertext was tampered with, or the wrong key is used,
  // decipher.final() throws "Unsupported state or unable to authenticate data".
  // This is GCM's integrity check — do not catch this error, let it propagate.
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check whether a string is already in encrypted storage format.
 * Useful to avoid double-encrypting if a route is called twice.
 *
 * This is a format check only — it does NOT verify the ciphertext is valid
 * or decryptable. Use decrypt() for that.
 *
 * @param  {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;

  const parts = value.split(':');
  if (parts.length < 3) return false;

  // IV should be IV_BYTES * 2 hex chars, authTag TAG_BYTES * 2 hex chars
  const ivHex      = parts[0];
  const authTagHex = parts[1];

  return (
    ivHex.length      === IV_BYTES  * 2 &&
    authTagHex.length === TAG_BYTES * 2 &&
    /^[0-9a-f]+$/i.test(ivHex) &&
    /^[0-9a-f]+$/i.test(authTagHex)
  );
}

/**
 * Safely decrypt an API key for use in an outgoing API call.
 * Returns null instead of throwing if the stored value is null/undefined
 * (e.g. Ollama provider which has no key).
 *
 * Use this in route handlers where a missing key should be handled gracefully
 * rather than crashing the process.
 *
 * @param  {string|null} stored
 * @returns {string|null}
 */
function decryptOrNull(stored) {
  if (stored === null || stored === undefined) return null;

  try {
    return decrypt(stored);
  } catch (err) {
    // Log the error but don't expose the reason to the API response caller.
    // The route handler should check for null and return a 500 with a safe message.
    console.error('[encryption] decryptOrNull failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  encrypt,
  decrypt,
  decryptOrNull,
  isEncrypted,
};