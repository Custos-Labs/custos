import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/** AES-256 takes a 32-byte key. */
const KEY_BYTES = 32;
/** The IV length GCM is specified for; other lengths weaken it. */
const IV_BYTES = 12;
/** GCM's authentication tag is always 16 bytes. */
const AUTH_TAG_BYTES = 16;

/**
 * The key used to encrypt MFA secrets at rest, read from `MFA_ENCRYPTION_KEY`
 * as base64.
 *
 * There is deliberately no fallback. An earlier version returned
 * `Buffer.alloc(32, 1)` when the variable was unset, as a test convenience —
 * which meant a deployment that forgot to set it would encrypt every TOTP
 * secret under a constant, publicly-known key and report no error at all. The
 * database would look encrypted while offering no protection, and nothing would
 * surface the problem until someone read this file.
 *
 * Tests that need a key set one explicitly; see `encryption.spec.ts`.
 */
function getEncryptionKey(): Buffer {
  const keyBase64 = process.env.MFA_ENCRYPTION_KEY;

  if (!keyBase64) {
    throw new Error(
      "MFA_ENCRYPTION_KEY is not set. MFA secrets cannot be encrypted without it. " +
        `Generate one with: openssl rand -base64 ${String(KEY_BYTES)}`,
    );
  }

  const key = Buffer.from(keyBase64, "base64");

  // Base64 decoding is lenient, so a truncated or mistyped value yields a
  // short buffer rather than an error. Checking here names the problem;
  // `createCipheriv` would otherwise fail with "Invalid key length", which
  // does not say which key or where it came from.
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to ${String(KEY_BYTES)} bytes for AES-256, ` +
        `but it decoded to ${String(key.length)}.`,
    );
  }

  return key;
}

/**
 * Encrypts a secret with AES-256-GCM, returning base64 of
 * `iv || authTag || ciphertext`.
 *
 * The IV is random per call, so encrypting the same secret twice produces
 * different output — reusing an IV under GCM is catastrophic, leaking the
 * XOR of the plaintexts and the authentication subkey.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/**
 * Reverses {@link encrypt}.
 *
 * Throws if the payload was tampered with: GCM verifies the tag in
 * `decipher.final()`, so a modified ciphertext, IV or tag fails rather than
 * returning plausible-looking garbage.
 */
export function decrypt(encryptedPayload: string): string {
  const key = getEncryptionKey();
  const payload = Buffer.from(encryptedPayload, "base64");

  // A payload shorter than the header cannot be ours. Without this check the
  // subarrays silently come back empty and the failure surfaces as an opaque
  // error from the cipher.
  if (payload.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Encrypted MFA secret is malformed: payload is too short to contain a tag.");
  }

  const iv = payload.subarray(0, IV_BYTES);
  const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
