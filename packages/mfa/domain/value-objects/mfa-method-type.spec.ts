import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { MfaMethodType } from "./mfa-method-type.js";

describe("MfaMethodType", () => {
  it("creates for valid types", () => {
    const totpResult = MfaMethodType.create("totp");
    expect(Result.isOk(totpResult) && totpResult.value.value).toBe("totp");

    const webauthnResult = MfaMethodType.create("webauthn");
    expect(Result.isOk(webauthnResult)).toBe(true);

    const backupResult = MfaMethodType.create("backup-codes");
    expect(Result.isOk(backupResult)).toBe(true);
  });

  it("fails for invalid types", () => {
    const result = MfaMethodType.create("invalid");
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBeDefined();
    }
  });

  it("implements equals correctly", () => {
    const totp1 = MfaMethodType.create("totp");
    const totp2 = MfaMethodType.create("totp");
    const webauthn = MfaMethodType.create("webauthn");

    if (Result.isOk(totp1) && Result.isOk(totp2) && Result.isOk(webauthn)) {
      expect(totp1.value.equals(totp2.value)).toBe(true);
      expect(totp1.value.equals(webauthn.value)).toBe(false);
    } else {
      throw new Error("fixture setup failed");
    }
  });
});
