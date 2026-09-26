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
  });
});
