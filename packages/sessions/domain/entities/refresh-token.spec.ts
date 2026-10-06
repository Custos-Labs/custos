import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { RefreshToken } from "./refresh-token.js";
import type { SessionId } from "./session.js";

const sessionId = createId<"SessionId">() as SessionId;
const expiresAt = new Date("2026-02-01T00:00:00.000Z");

describe("RefreshToken.issue", () => {
  it("issues a token bound to the session, redeemable, with the raw value returned once", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { refreshToken, token } = RefreshToken.issue({ sessionId, expiresAt, now });

    expect(refreshToken.sessionId).toBe(sessionId);
    expect(refreshToken.createdAt).toEqual(now);
    expect(refreshToken.expiresAt).toEqual(expiresAt);
    expect(refreshToken.isUsed).toBe(false);
    expect(refreshToken.isRevoked).toBe(false);
    expect(refreshToken.isRedeemable(now)).toBe(true);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(32);
  });

  it("never stores the raw token — only its hash", () => {
    const { refreshToken, token } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.tokenHash).not.toBe(token);
    expect(JSON.stringify(refreshToken)).not.toContain(token);
  });

  it("issues tokens with distinct values and hashes", () => {
    const first = RefreshToken.issue({ sessionId, expiresAt });
    const second = RefreshToken.issue({ sessionId, expiresAt });

    expect(first.token).not.toBe(second.token);
    expect(first.refreshToken.tokenHash).not.toBe(second.refreshToken.tokenHash);
  });
});

describe("RefreshToken.matchesToken", () => {
  it("matches the exact raw token it was issued with", () => {
    const { refreshToken, token } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.matchesToken(token)).toBe(true);
  });

  it("rejects an unrelated token", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.matchesToken("not-the-right-token")).toBe(false);
  });

  it("rejects a different, validly-issued token", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });
    const { token: otherToken } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.matchesToken(otherToken)).toBe(false);
  });
});

describe("RefreshToken expiry and redemption state", () => {
  it("is expired once past its expiresAt", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.isExpired(new Date("2026-02-01T00:00:00.001Z"))).toBe(true);
    expect(refreshToken.isExpired(new Date("2026-01-31T23:59:59.999Z"))).toBe(false);
  });

  it("is not redeemable once expired", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });

    expect(refreshToken.isRedeemable(new Date("2026-02-02T00:00:00.000Z"))).toBe(false);
  });

  it("is not redeemable once marked used", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });

    const used = refreshToken.markUsed(new Date("2026-01-02T00:00:00.000Z"));

    expect(used.isUsed).toBe(true);
    expect(used.usedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
    expect(used.isRedeemable(new Date("2026-01-02T00:00:01.000Z"))).toBe(false);
  });

  it("is not redeemable once revoked", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });

    const revoked = refreshToken.revoke(new Date("2026-01-02T00:00:00.000Z"));

    expect(revoked.isRevoked).toBe(true);
    expect(revoked.isRedeemable()).toBe(false);
  });

  it("revoke is idempotent: keeps the first revokedAt", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });
    const firstRevokeAt = new Date("2026-01-02T00:00:00.000Z");

    const revoked = refreshToken.revoke(firstRevokeAt);
    const revokedAgain = revoked.revoke(new Date("2026-01-03T00:00:00.000Z"));

    expect(revokedAgain.revokedAt).toEqual(firstRevokeAt);
  });
});

describe("RefreshToken.reconstitute", () => {
  it("rebuilds from trusted data as-is", () => {
    const { refreshToken } = RefreshToken.issue({ sessionId, expiresAt });
    const props = {
      id: refreshToken.id,
      sessionId,
      tokenHash: refreshToken.tokenHash,
      createdAt: refreshToken.createdAt,
      expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    };

    expect(RefreshToken.reconstitute(props)).toMatchObject(props);
  });
});
