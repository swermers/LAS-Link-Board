// ═══════════════════════════════════════════════════
// VoiceType — API Key Encryption (AES-256-GCM)
// ═══════════════════════════════════════════════════
//
// Encrypts API keys before storing in Supabase.
// Uses a secret from VOICETYPE_ENCRYPTION_KEY env var.
//
// Ciphertext format: "enc:v1:<iv_hex>:<ciphertext_hex>:<tag_hex>"
// This makes it obvious in the DB that the value is encrypted.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Get the 32-byte encryption key from environment.
 * Falls back to a deterministic key derived from the service role key
 * if VOICETYPE_ENCRYPTION_KEY is not set.
 */
function getKey() {
  const envKey = process.env.VOICETYPE_ENCRYPTION_KEY;
  if (envKey) {
    // If it's a hex string, use directly; otherwise hash it
    if (/^[0-9a-f]{64}$/i.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    return crypto.createHash('sha256').update(envKey).digest();
  }

  // Fallback: derive from service role key (not ideal, but better than plaintext)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (serviceKey) {
    return crypto.createHash('sha256').update('voicetype-enc:' + serviceKey).digest();
  }

  return null;
}

/**
 * Encrypt a plaintext string.
 * Returns "enc:v1:<iv>:<ciphertext>:<tag>" or the original string if no key.
 */
function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getKey();
  if (!key) return plaintext; // No key available, store as-is

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return 'enc:v1:' + iv.toString('hex') + ':' + encrypted + ':' + tag;
}

/**
 * Decrypt an encrypted string.
 * If the string doesn't start with "enc:v1:", returns it as-is (legacy plaintext).
 */
function decrypt(ciphertext) {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:v1:')) return ciphertext; // Legacy plaintext

  const key = getKey();
  if (!key) return ''; // Can't decrypt without key

  const parts = ciphertext.split(':');
  // Format: enc:v1:<iv>:<encrypted>:<tag>
  if (parts.length !== 5) return '';

  const iv = Buffer.from(parts[2], 'hex');
  const encrypted = parts[3];
  const tag = Buffer.from(parts[4], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if a string is encrypted (starts with enc:v1:)
 */
function isEncrypted(value) {
  return value && value.startsWith('enc:v1:');
}

module.exports = { encrypt, decrypt, isEncrypted };
