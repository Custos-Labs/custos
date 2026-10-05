import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decrypt, encrypt } from "./encryption.js";

/** A valid 32-byte key, base64-encoded, for tests that need one. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("MFA secret encryption", () => {
  const original = process.env.MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MFA_ENCRYPTION_KEY;
    } else {
      process.env.MFA_ENCRYPTION_KEY = original;
    }
  });

  it("round-trips a secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";

    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("round-trips multi-byte characters", () => {
    // The payload is assembled as Buffers and the plaintext is read back with
    // an explicit utf8 decode. Slicing by byte offsets would corrupt anything
    // outside ASCII if a length were counted in characters instead of bytes.
    const secret = "sécret—🔐";

    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertext each time for the same secret", () => {
    // A fresh random IV per call. If the IV were fixed, identical secrets would
    // encrypt identically, so the database would reveal which users share a
    // secret — and under GCM, IV reuse leaks far more than that.
    const secret = "JBSWY3DPEHPK3PXP";

    expect(encrypt(secret)).not.toBe(encrypt(secret));
  });

  it("refuses to encrypt when no key is configured", () => {
    // The regression this file exists for. A previous version fell back to
    // `Buffer.alloc(32, 1)` when the variable was unset, so a deployment that
    // forgot the key encrypted every TOTP secret under a constant that anyone
    // reading the source would know — silently, with no error to notice.
    delete process.env.MFA_ENCRYPTION_KEY;

    expect(() => encrypt("JBSWY3DPEHPK3PXP")).toThrow(/MFA_ENCRYPTION_KEY is not set/);
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(16, 7).toString("base64");

    expect(() => encrypt("JBSWY3DPEHPK3PXP")).toThrow(/must decode to 32 bytes/);
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const payload = Buffer.from(encrypt("JBSWY3DPEHPK3PXP"), "base64");
    // Flip a bit in the ciphertext, past the 12-byte IV and 16-byte tag.
    const last = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(last) ^ 0xff, last);

    expect(() => decrypt(payload.toString("base64"))).toThrow();
  });

  it("rejects a tampered authentication tag", () => {
    const payload = Buffer.from(encrypt("JBSWY3DPEHPK3PXP"), "base64");
    payload.writeUInt8(payload.readUInt8(12) ^ 0xff, 12);

    expect(() => decrypt(payload.toString("base64"))).toThrow();
  });

  it("rejects a payload too short to hold an IV and tag", () => {
    expect(() => decrypt(Buffer.alloc(8).toString("base64"))).toThrow(/too short/);
  });

  it("cannot decrypt a secret encrypted under a different key", () => {
    const payload = encrypt("JBSWY3DPEHPK3PXP");
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

    expect(() => decrypt(payload)).toThrow();
  });
});
