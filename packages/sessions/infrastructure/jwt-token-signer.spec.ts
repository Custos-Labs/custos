import { Result } from "@verixa/shared-kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JwtTokenSigner } from "./jwt-token-signer.js";
import { SigningKeyProvider } from "./signing-key-provider.js";

describe("JwtTokenSigner", () => {
  const keyProvider = new SigningKeyProvider({ secret: "test-signing-secret-value" });
  const signer = new JwtTokenSigner(keyProvider);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs a token that verifies back to the same payload", async () => {
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);
    const result = await signer.verify(token);

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ sessionId: "session-1", userId: "user-1" });
    }
  });

  it("produces the standard three-segment, dot-separated JWT shape", async () => {
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);

    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects a token signed with a different secret", async () => {
    const otherSigner = new JwtTokenSigner(
      new SigningKeyProvider({ secret: "a-different-secret" }),
    );
    const token = await otherSigner.sign({ sessionId: "session-1", userId: "user-1" }, 3600);

    const result = await signer.verify(token);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toMatch(/signature/i);
    }
  });

  it("rejects a tampered payload segment", async () => {
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);
    const [header, , signature] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ sessionId: "session-2", userId: "user-1", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");

    const result = await signer.verify(`${header}.${tamperedBody}.${signature}`);

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a malformed token that isn't three dot-separated segments", async () => {
    const result = await signer.verify("not-a-jwt");

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toMatch(/malformed/i);
    }
  });

  it("rejects a payload segment that isn't valid base64url JSON", async () => {
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 3600);
    const [header, , signature] = token.split(".");

    const result = await signer.verify(`${header}.not-json.${signature}`);

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 60);

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    const result = await signer.verify(token);

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.message).toMatch(/expired/i);
    }
  });
});

describe("JwtTokenSigner construction", () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("stamps iat/exp from the current time at signing", async () => {
    const keyProvider = new SigningKeyProvider({ secret: "test-signing-secret-value" });
    const signer = new JwtTokenSigner(keyProvider);
    Date.now = () => new Date("2026-01-01T00:00:00.000Z").getTime();

    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 60);
    const [, body] = token.split(".");
    const claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as {
      iat: number;
      exp: number;
    };

    expect(claims.iat).toBe(Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1000));
    expect(claims.exp).toBe(claims.iat + 60);
import { describe, expect, it } from "vitest";

import type { AccessTokenInput } from "../application/ports/token-signer.js";
import { createSessionId } from "../domain/value-objects/session-id.js";

import { JwtTokenSigner, type JwtTokenSignerOptions } from "./jwt-token-signer.js";
import { createConfigSigningKeyProvider, type SigningKeyProvider } from "./signing-key-provider.js";
import { asCurrent, asRetired, generateTestKey } from "./testing/signing-key-fixtures.js";

function makeInput(overrides: Partial<AccessTokenInput> = {}): AccessTokenInput {
  return {
    subject: "user-123",
    sessionId: createSessionId(),
    organizationId: "org-456",
    roles: ["member"],
    ...overrides,
  };
}

function signerOver(
  provider: SigningKeyProvider,
  options: Partial<JwtTokenSignerOptions> = {},
): JwtTokenSigner {
  return new JwtTokenSigner(provider, { accessTokenTtlSeconds: 900, ...options });
}

describe("JwtTokenSigner", () => {
  it("round-trips claims through sign and verify", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);
    const signer = signerOver(provider);
    const input = makeInput();

    const token = await signer.sign(input);
    const result = await signer.verify(token);

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;
    expect(result.value.subject).toBe("user-123");
    expect(result.value.sessionId).toBe(input.sessionId);
    expect(result.value.organizationId).toBe("org-456");
    expect(result.value.roles).toEqual(["member"]);
    expect(result.value.keyId).toBe("k1");
    expect(result.value.expiresAt.getTime()).toBeGreaterThan(result.value.issuedAt.getTime());
  });

  it("defaults roles to an empty array when none were signed in", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);
    const signer = signerOver(provider);

    const token = await signer.sign(makeInput({ roles: [] }));
    const result = await signer.verify(token);

    expect(Result.isOk(result) && result.value.roles).toEqual([]);
  });

  // The headline acceptance criterion of Issue 085: a token minted before a
  // rotation still verifies after it, because the key that signed it is kept in
  // the set as verification-only.
  it("still verifies a token signed by a now-retired key", async () => {
    const oldKey = generateTestKey("2026-06");
    const newKey = generateTestKey("2026-09");

    // Minted while oldKey was current.
    const beforeRotation = await createConfigSigningKeyProvider([asCurrent(oldKey)]);
    const token = await signerOver(beforeRotation).sign(makeInput());

    // Rotate: newKey signs now, oldKey demoted to verification-only.
    const afterRotation = await createConfigSigningKeyProvider([
      asCurrent(newKey),
      asRetired(oldKey),
    ]);

    const result = await signerOver(afterRotation).verify(token);

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value.keyId).toBe("2026-06");
  });

  // The other side of Issue 085: once a key is gone from the set (or never
  // existed here), its tokens — and any forgery naming its kid — are rejected.
  it("rejects a token whose kid the provider no longer holds", async () => {
    const removedKey = generateTestKey("removed");
    const token = await signerOver(
      await createConfigSigningKeyProvider([asCurrent(removedKey)]),
    ).sign(makeInput());

    const currentProvider = await createConfigSigningKeyProvider([
      asCurrent(generateTestKey("current")),
    ]);

    const result = await signerOver(currentProvider).verify(token);

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isErr(result) && result.error.reason).toBe("unknown_key");
  });

  it("rejects a tampered payload as an invalid signature", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);
    const signer = signerOver(provider);
    const token = await signer.sign(makeInput());

    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    decoded["sub"] = "attacker";
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tampered = [header, forgedPayload, signature].join(".");

    const result = await signer.verify(tampered);

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isErr(result) && result.error.reason).toBe("invalid_signature");
  });

  it("rejects an expired token", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);
    const expiredSigner = signerOver(provider, {
      accessTokenTtlSeconds: 60,
      now: () => new Date(Date.now() - 60 * 60 * 1000),
    });
    const token = await expiredSigner.sign(makeInput());

    const result = await signerOver(provider).verify(token);

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isErr(result) && result.error.reason).toBe("expired");
  });

  it("rejects a malformed token", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);

    const result = await signerOver(provider).verify("this.is.not-a-jwt");

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isErr(result) && result.error.reason).toBe("malformed");
  });

  it("rejects a token minted for a different issuer", async () => {
    const provider = await createConfigSigningKeyProvider([asCurrent(generateTestKey("k1"))]);
    const token = await signerOver(provider, { issuer: "issuer-a", audience: "aud" }).sign(
      makeInput(),
    );

    const result = await signerOver(provider, { issuer: "issuer-b", audience: "aud" }).verify(
      token,
    );

    expect(Result.isErr(result)).toBe(true);
    expect(Result.isErr(result) && result.error.reason).toBe("invalid_signature");
  });

  it("round-trips under RS256, the documented production default", async () => {
    const provider = await createConfigSigningKeyProvider([
      asCurrent(generateTestKey("rsa", "RS256")),
    ]);
    const signer = signerOver(provider);

    const token = await signer.sign(makeInput());
    const result = await signer.verify(token);

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value.keyId).toBe("rsa");
  });
});
