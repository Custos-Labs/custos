import crypto from "node:crypto";
import { base32 } from "./base32.js";
import type { TotpSecret } from "../value-objects/totp-secret.js";

export class TotpAlgorithm {
  static generate(secret: TotpSecret, timestamp: number = Date.now()): string {
    const period = 30;
    const digits = 6;
    const timeStep = Math.floor(timestamp / 1000 / period);

    const buffer = Buffer.alloc(8);
    // Write the 64-bit counter (timeStep) to buffer in big-endian
    // Math.floor() returns a number which is safe up to 2^53.
    // For TOTP, timeStep fits well within 32 bits for the next 100+ years,
    // so we can write the higher 4 bytes as 0 and lower 4 bytes as the timeStep.
    const high = Math.floor(timeStep / 0x100000000);
    const low = timeStep & 0xffffffff;
    buffer.writeUInt32BE(high, 0);
    buffer.writeUInt32BE(low, 4);

    const secretBytes = base32.decode(secret.value);
    const hmac = crypto.createHmac("sha1", secretBytes).update(buffer).digest();

    const offset = hmac[hmac.length - 1]! & 0xf;
    const code =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);

    const otp = code % 10 ** digits;
    return otp.toString().padStart(digits, "0");
  }

  static verify(
    secret: TotpSecret,
    code: string,
    options?: { timestamp?: number; window?: number },
  ): boolean {
    const timestamp = options?.timestamp ?? Date.now();
    const window = options?.window ?? 1; // Default to +/- 1 step (30 seconds before/after)

    // Using constant-time comparison is important to prevent timing attacks
    // But since the code space is only 1,000,000, timing attacks are less practical for TOTP.
    // Still good practice to compare safely if possible.
    for (let i = -window; i <= window; i++) {
      const ts = timestamp + i * 30 * 1000;
      const generated = this.generate(secret, ts);
      if (crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(code))) {
        return true;
      }
    }
    return false;
  }
import { Result } from "@verixa/shared-kernel";
import type { TotpSecret } from "../value-objects/totp-secret.js";

export interface TotpAlgorithm {
  generateSecret(accountName: string, issuer?: string): Promise<TotpSecret>;
  
  /**
   * Verifies a 6-digit TOTP code against the given secret.
   * Tolerates a minor clock skew window.
   * 
   * Returns the matched time step if valid (to be used for replay protection),
   * or null if the code is invalid or outside the acceptable drift window.
   */
  verify(secret: TotpSecret, code: string, driftWindow?: number): Promise<number | null>;
}
