import { type TransactionSigner } from "@verixa/stellar-anchor";
import { beforeAll, describe, expect, it } from "vitest";

import { buildContainer } from "./composition-root.js";

describe("Composition Root boot smoke test", () => {
  beforeAll(() => {
    process.env["SESSION_ACCESS_TOKEN_SECRET"] ??= "test-only-secret-value-at-least-32-chars";
  });

  it("resolves all domain contexts and use cases including MFA", async () => {
    const container = buildContainer();

    // Identity context
    expect(container.identity).toBeDefined();
    expect(container.identity.registerUser).toBeDefined();
    expect(container.identity.updateUserProfile).toBeDefined();

    // Credentials context
    expect(container.credentials).toBeDefined();
    expect(container.credentials.authenticateWithPassword).toBeDefined();
    expect(container.credentials.registerUserWithPassword).toBeDefined();

    // Audit context
    expect(container.audit).toBeDefined();
    expect(container.audit.recordEvent).toBeDefined();

    // MFA context (Issue 119)
    expect(container.mfa).toBeDefined();
    expect(container.mfa.registerWebAuthnCredential).toBeDefined();
    expect(container.mfa.verifyWebAuthnAssertion).toBeDefined();

    await container.dispose();
  });

  it("wires anchor with funding guard derived from secret key when secret key is configured", async () => {
    const originalSecret = process.env["STELLAR_ANCHOR_SECRET_KEY"];
    const originalThreshold = process.env["STELLAR_ANCHOR_MIN_XLM"];
    try {
      process.env["STELLAR_ANCHOR_SECRET_KEY"] =
        "SDSRAEM4LGGLJSJJNVP66N3ZHWRXBCEF5UZWY34Z7X5XO2GYBWULLMA6";
      process.env["STELLAR_ANCHOR_MIN_XLM"] = "2";

      const container = buildContainer();
      expect(container.audit.anchor).toBeDefined();

      await container.dispose();
    } finally {
      if (originalSecret === undefined) {
        delete process.env["STELLAR_ANCHOR_SECRET_KEY"];
      } else {
        process.env["STELLAR_ANCHOR_SECRET_KEY"] = originalSecret;
      }
      if (originalThreshold === undefined) {
        delete process.env["STELLAR_ANCHOR_MIN_XLM"];
      } else {
        process.env["STELLAR_ANCHOR_MIN_XLM"] = originalThreshold;
      }
    }
  });

  it("throws when STELLAR_ANCHOR_MIN_XLM is malformed or negative", () => {
    const originalSecret = process.env["STELLAR_ANCHOR_SECRET_KEY"];
    const originalThreshold = process.env["STELLAR_ANCHOR_MIN_XLM"];
    try {
      process.env["STELLAR_ANCHOR_SECRET_KEY"] =
        "SDSRAEM4LGGLJSJJNVP66N3ZHWRXBCEF5UZWY34Z7X5XO2GYBWULLMA6";
      process.env["STELLAR_ANCHOR_MIN_XLM"] = "-1";

      expect(() => buildContainer()).toThrow(
        "STELLAR_ANCHOR_MIN_XLM must be a non-negative number of XLM.",
      );
    } finally {
      if (originalSecret === undefined) {
        delete process.env["STELLAR_ANCHOR_SECRET_KEY"];
      } else {
        process.env["STELLAR_ANCHOR_SECRET_KEY"] = originalSecret;
      }
      if (originalThreshold === undefined) {
        delete process.env["STELLAR_ANCHOR_MIN_XLM"];
      } else {
        process.env["STELLAR_ANCHOR_MIN_XLM"] = originalThreshold;
      }
    }
  });

  it("logs error when signer is supplied without public key", async () => {
    const originalSecret = process.env["STELLAR_ANCHOR_SECRET_KEY"];
    const originalPubkey = process.env["STELLAR_ANCHOR_PUBLIC_KEY"];
    delete process.env["STELLAR_ANCHOR_SECRET_KEY"];
    delete process.env["STELLAR_ANCHOR_PUBLIC_KEY"];

    const logged: Record<string, unknown>[] = [];
    const dummySigner: TransactionSigner = {
      accountId: () =>
        Promise.resolve({
          kind: "ok",
          value: "GCK22GKTGLSITO3CKOWIRFIFAER4I6OQWEE2QO3CNYLTPGBFUTZODD7T",
        }),
      sign: () => Promise.resolve({ kind: "ok", value: new Uint8Array(64) }),
      describe: () => "kms:test-key",
    };

    try {
      const container = buildContainer(undefined, {
        signer: dummySigner,
        logger: {
          error: (obj) => {
            logged.push(obj);
          },
        },
      });

      expect(logged).toEqual([
        {
          type: "anchor_funding_guard_disabled",
          reason: "STELLAR_ANCHOR_PUBLIC_KEY is not set",
        },
      ]);
      expect(container.audit.anchor).toBeDefined();

      await container.dispose();
    } finally {
      if (originalSecret !== undefined) process.env["STELLAR_ANCHOR_SECRET_KEY"] = originalSecret;
      if (originalPubkey !== undefined) process.env["STELLAR_ANCHOR_PUBLIC_KEY"] = originalPubkey;
    }
  });
});
