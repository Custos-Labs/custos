import { generateKeyPairSync } from "node:crypto";
import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { JwtTokenSigner } from "./jwt-token-signer.js";
import { createConfigSigningKeyProvider } from "./signing-key-provider.js";

function testKey(kid: string, current = false) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    algorithm: "RS256" as const,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    current,
  };
}

async function testSigner(kid = "test-key-1") {
  const key = testKey(kid, true);
  const provider = await createConfigSigningKeyProvider([key]);
  return { signer: new JwtTokenSigner(provider), key, provider };
}

describe("JwtTokenSigner (RS256 with key rotation)", () => {
  it("signs a token that verifies back to the same payload", async () => {
    const { signer } = await testSigner();
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);
    const result = await signer.verify(token);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ sessionId: "session-1", userId: "user-1" });
    }
  });

  it("produces standard three-segment dot-separated JWT", async () => {
    const { signer } = await testSigner();
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);

    expect(token.split(".")).toHaveLength(3);
  });

  it("still verifies a token signed by a now-retired key when held in provider", async () => {
    const keyOld = testKey("key-old", true);
    const providerOld = await createConfigSigningKeyProvider([keyOld]);
    const signerOld = new JwtTokenSigner(providerOld);

    const token = await signerOld.sign({ sessionId: "session-old", userId: "user-old" }, 3600);

    // Rotate: keyNew is now current, keyOld is retired (not current)
    const keyNew = testKey("key-new", true);
    const keyOldRetired = { ...keyOld, current: false };
    const providerRotated = await createConfigSigningKeyProvider([keyNew, keyOldRetired]);
    const verifierRotated = new JwtTokenSigner(providerRotated);

    const result = await verifierRotated.verify(token);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ sessionId: "session-old", userId: "user-old" });
    }
  });

  it("rejects a token whose kid the provider does not hold", async () => {
    const { signer: signer1 } = await testSigner("key-1");
    const { signer: signer2 } = await testSigner("key-2");

    const token = await signer1.sign({ sessionId: "session-1", userId: "user-1" }, 3600);
    const result = await signer2.verify(token);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("unknown signing key");
    }
  });

  it("rejects a tampered payload segment", async () => {
    const { signer } = await testSigner();
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);

    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", sid: "session-1", iat: 0, exp: 9999999999 }),
    ).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    const result = await signer.verify(tamperedToken);
    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects an expired token", async () => {
    const { signer } = await testSigner();
    // Negative TTL so it's already expired
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, -10);

    const result = await signer.verify(token);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("signature or expiry check failed");
    }
  });

  it("rejects a malformed token that is not three dot-separated segments", async () => {
    const { signer } = await testSigner();

    const result = await signer.verify("invalid.token");
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("malformed");
    }
  });

  it("rejects token without kid in protected header", async () => {
    const { signer } = await testSigner();
    // Header without kid
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user-1", sid: "session-1" })).toString("base64url");
    const fakeToken = `${header}.${body}.fakesig`;

    const result = await signer.verify(fakeToken);
    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toContain("malformed");
    }
  });
});
