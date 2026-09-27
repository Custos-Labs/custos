import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";
import { TotpSecret } from "../value-objects/totp-secret.js";
import { TotpAlgorithm } from "./totp-algorithm.js";

describe("TotpAlgorithm", () => {
  // RFC 6238 test vectors for HMAC-SHA1
  // Secret is "12345678901234567890" in ASCII, which encodes to:
  const rfcSecretString = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  const vectors = [
    { time: 59, code: "287082" },
    { time: 1111111109, code: "081804" },
    { time: 1111111111, code: "050471" },
    { time: 1234567890, code: "005924" },
    { time: 2000000000, code: "279037" },
    { time: 20000000000, code: "353130" },
  ];

  it("generates codes matching RFC 6238 test vectors", () => {
    const secretResult = TotpSecret.fromString(rfcSecretString);
    if (!Result.isOk(secretResult)) throw new Error("Invalid secret");
    const secret = secretResult.value;

    for (const vector of vectors) {
      // time in the RFC is in seconds, algorithm expects milliseconds
      const code = TotpAlgorithm.generate(secret, vector.time * 1000);
      expect(code).toBe(vector.code);
    }
  });

  describe("verify", () => {
    it("accepts a valid code", () => {
      const secretResult = TotpSecret.fromString(rfcSecretString);
      if (!Result.isOk(secretResult)) throw new Error("Invalid secret");
      const secret = secretResult.value;

      const isValid = TotpAlgorithm.verify(secret, "081804", { timestamp: 1111111109 * 1000 });
      expect(isValid).toBe(true);
    });

    it("rejects an invalid code", () => {
      const secretResult = TotpSecret.fromString(rfcSecretString);
      if (!Result.isOk(secretResult)) throw new Error("Invalid secret");
      const secret = secretResult.value;

      const isValid = TotpAlgorithm.verify(secret, "999999", { timestamp: 1111111109 * 1000 });
      expect(isValid).toBe(false);
    });

    it("accepts a code within the time window", () => {
      const secretResult = TotpSecret.fromString(rfcSecretString);
      if (!Result.isOk(secretResult)) throw new Error("Invalid secret");
      const secret = secretResult.value;

      // 1111111109 is in the 1111111080 - 1111111110 window
      // 1111111139 is one window ahead (30s later).
      // If we verify at 1111111139 with window=1, it should accept the previous window's code
      const isValid = TotpAlgorithm.verify(secret, "081804", {
        timestamp: 1111111139 * 1000,
        window: 1,
      });
      expect(isValid).toBe(true);
    });
  });
});
