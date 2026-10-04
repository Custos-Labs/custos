import { asId, createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { SessionExpiryPolicy } from "../value-objects/session-expiry-policy.js";

import type { RefreshTokenId } from "./refresh-token.js";
import { Session, type SessionUserId } from "./session.js";

const userId = asId<"UserId">("00000000-0000-0000-0000-000000000001") as SessionUserId;
const policy = SessionExpiryPolicy.default();

describe("Session.open", () => {
  it("opens an active session with no metadata", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const session = Session.open({ userId, policy, now });

    expect(session.userId).toBe(userId);
    expect(session.createdAt).toEqual(now);
    expect(session.lastSeenAt).toEqual(now);
    expect(session.expiresAt.getTime()).toBe(now.getTime() + policy.absoluteLifetimeMs);
    expect(session.ipAddress).toBeUndefined();
    expect(session.userAgent).toBeUndefined();
    expect(session.isRevoked).toBe(false);
    expect(session.isActive(policy, now)).toBe(true);
  });

  it("records metadata when provided", () => {
    const session = Session.open({
      userId,
      policy,
      metadata: { ipAddress: "203.0.113.5", userAgent: "curl/8" },
    });

    expect(session.ipAddress).toBe("203.0.113.5");
    expect(session.userAgent).toBe("curl/8");
  });
});

describe("Session.isActive", () => {
  it("is inactive once past its absolute expiry, even with recent activity", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    const session = Session.open({ userId, policy, now: openedAt });
    const wellPastExpiry = new Date(openedAt.getTime() + policy.absoluteLifetimeMs + 1);

    expect(session.isActive(policy, wellPastExpiry)).toBe(false);
  });

  it("is inactive once idle for longer than the policy allows", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    const session = Session.open({ userId, policy, now: openedAt });
    const idleTooLong = new Date(openedAt.getTime() + policy.idleTimeoutMs + 1);

    expect(session.isActive(policy, idleTooLong)).toBe(false);
  });

  it("is inactive once revoked, regardless of expiry", () => {
    const session = Session.open({ userId, policy }).revoke();

    expect(session.isActive(policy)).toBe(false);
  });
});

describe("Session.touch", () => {
  it("advances lastSeenAt without changing anything else", () => {
    const session = Session.open({ userId, policy, now: new Date("2026-01-01T00:00:00.000Z") });
    const touchedAt = new Date("2026-01-02T00:00:00.000Z");

    const touched = session.touch(touchedAt);

    expect(touched.lastSeenAt).toEqual(touchedAt);
    expect(touched.id).toBe(session.id);
    expect(touched.createdAt).toEqual(session.createdAt);
    expect(touched.expiresAt).toEqual(session.expiresAt);
  });
});

describe("Session.revoke", () => {
  it("marks the session revoked", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const revoked = Session.open({ userId, policy }).revoke(now);

    expect(revoked.isRevoked).toBe(true);
    expect(revoked.revokedAt).toEqual(now);
  });

  it("is idempotent: revoking twice keeps the first revokedAt", () => {
    const firstRevokeAt = new Date("2026-01-01T00:00:00.000Z");
    const revoked = Session.open({ userId, policy }).revoke(firstRevokeAt);

    const revokedAgain = revoked.revoke(new Date("2026-01-02T00:00:00.000Z"));

    expect(revokedAgain.revokedAt).toEqual(firstRevokeAt);
  });
});

describe("Session.revokeDueToRefreshTokenReuse", () => {
  const refreshTokenId = createId<"RefreshTokenId">() as RefreshTokenId;

  it("revokes the session and records a RefreshTokenReuseDetected event", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const session = Session.open({ userId, policy });

    const revoked = session.revokeDueToRefreshTokenReuse(refreshTokenId, now);

    expect(revoked.isRevoked).toBe(true);
    expect(revoked.revokedAt).toEqual(now);
    const events = revoked.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: "sessions.refresh_token.reuse_detected",
      aggregateId: session.id,
      userId,
      refreshTokenId,
    });
  });

  it("is idempotent: does nothing to an already-revoked session", () => {
    const session = Session.open({ userId, policy }).revoke(new Date("2026-01-01T00:00:00.000Z"));

    const result = session.revokeDueToRefreshTokenReuse(
      refreshTokenId,
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(result.revokedAt).toEqual(session.revokedAt);
    expect(result.pullDomainEvents()).toHaveLength(0);
  });
});

describe("Session domain events", () => {
  it("a freshly opened session carries no domain events", () => {
    expect(Session.open({ userId, policy }).pullDomainEvents()).toEqual([]);
  });

  it("a plain revoke() does not record a reuse-detection event", () => {
    const revoked = Session.open({ userId, policy }).revoke();
    expect(revoked.pullDomainEvents()).toEqual([]);
  });
});

describe("Session.reconstitute", () => {
  it("rebuilds a session from trusted data as-is", () => {
    const props = {
      id: Session.open({ userId, policy }).id,
      userId,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-31T00:00:00.000Z"),
      ipAddress: "203.0.113.5",
      userAgent: "curl/8",
      revokedAt: undefined,
    };

    const session = Session.reconstitute(props);

    expect(session).toMatchObject(props);
import { asId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "./session.js";

const userId: SessionUserId = asId("11111111-1111-1111-1111-111111111111");

function accessToken(now: Date) {
  return { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) };
}

describe("Session", () => {
  describe("issue", () => {
    it("captures the metadata seen at login as the first history entry", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const metadata = { ipAddress: "203.0.113.10", userAgent: "curl/8.0", deviceLabel: "CLI" };

      const { session, rawRefreshToken } = Session.issue({
        userId,
        metadata,
        accessToken: accessToken(now),
        now,
      });

      expect(session.metadataHistory).toHaveLength(1);
      expect(session.metadataHistory[0]!.metadata).toEqual(metadata);
      expect(session.metadataHistory[0]!.recordedAt).toEqual(now);
      expect(session.currentMetadata).toEqual(metadata);
      expect(session.createdAt).toEqual(now);
      expect(session.lastActiveAt).toEqual(now);
      expect(session.isRevoked).toBe(false);
      expect(rawRefreshToken).toHaveLength(43); // 32 bytes, base64url
    });

    it("issues a session whose refresh token can be verified but no other string matches", () => {
      const now = new Date();
      const { session, rawRefreshToken } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      expect(session.matchesRefreshToken(rawRefreshToken)).toBe(true);
      expect(session.matchesRefreshToken("not-the-token")).toBe(false);
    });

    it("defaults to a 30-day expiry from issuance", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      expect(session.expiresAt.getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe("recordActivity", () => {
    it("appends a new metadata observation when the presented metadata changed", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const { session } = Session.issue({
        userId,
        metadata: { ipAddress: "203.0.113.10" },
        accessToken: accessToken(now),
        now,
      });

      const later = new Date(now.getTime() + 60_000);
      const refreshed = session.recordActivity({
        metadata: { ipAddress: "198.51.100.20" },
        accessToken: { tokenId: "token-2", expiresAt: new Date(later.getTime() + 60_000) },
        now: later,
      });

      expect(refreshed.metadataHistory).toHaveLength(2);
      expect(refreshed.metadataHistory[1]!.metadata).toEqual({ ipAddress: "198.51.100.20" });
      expect(refreshed.metadataHistory[1]!.recordedAt).toEqual(later);
      expect(refreshed.currentMetadata).toEqual({ ipAddress: "198.51.100.20" });
      // The original observation survives — it is not overwritten.
      expect(refreshed.metadataHistory[0]!.metadata).toEqual({ ipAddress: "203.0.113.10" });
    });

    it("does not append a new observation when the presented metadata is unchanged", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const metadata = { ipAddress: "203.0.113.10", userAgent: "curl/8.0" };
      const { session } = Session.issue({ userId, metadata, accessToken: accessToken(now), now });

      const later = new Date(now.getTime() + 60_000);
      const refreshed = session.recordActivity({
        metadata,
        accessToken: { tokenId: "token-2", expiresAt: new Date(later.getTime() + 60_000) },
        now: later,
      });

      expect(refreshed.metadataHistory).toHaveLength(1);
      // Activity is still bumped even without a new observation.
      expect(refreshed.lastActiveAt).toEqual(later);
    });

    it("always updates the current access token, whether or not metadata changed", () => {
      const now = new Date();
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      const refreshed = session.recordActivity({
        metadata: {},
        accessToken: { tokenId: "token-2", expiresAt: new Date(now.getTime() + 120_000) },
        now,
      });

      expect(refreshed.currentAccessToken!.tokenId).toBe("token-2");
    });
  });

  describe("revoke", () => {
    it("marks the session revoked and inactive", () => {
      const now = new Date();
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      const revoked = session.revoke(now);

      expect(revoked.isRevoked).toBe(true);
      expect(revoked.isActiveAt(now)).toBe(false);
    });

    it("is idempotent: revoking an already-revoked session keeps the original timestamp", () => {
      const firstRevocation = new Date("2026-01-01T00:00:00Z");
      const now = new Date();
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      const revokedOnce = session.revoke(firstRevocation);
      const revokedAgain = revokedOnce.revoke(new Date("2026-06-01T00:00:00Z"));

      expect(revokedAgain.revokedAt).toEqual(firstRevocation);
    });
  });

  describe("isActiveAt", () => {
    it("is inactive once expired, even if never revoked", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        ttlMs: 1000,
        now,
      });

      expect(session.isActiveAt(new Date(now.getTime() + 500))).toBe(true);
      expect(session.isActiveAt(new Date(now.getTime() + 1000))).toBe(false);
    });
  });

  describe("reconstitute", () => {
    it("rebuilds a session from stored props without going through issue", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const { session: issued } = Session.issue({
        userId,
        metadata: { deviceLabel: "iPhone" },
        accessToken: accessToken(now),
        now,
      });

      const rebuilt = Session.reconstitute({ ...issued });

      expect(rebuilt.id).toBe(issued.id);
      expect(rebuilt.currentMetadata).toEqual({ deviceLabel: "iPhone" });
    });
  });

  describe("toJSON", () => {
    it("redacts the refresh token hash", () => {
      const now = new Date();
      const { session } = Session.issue({
        userId,
        metadata: {},
        accessToken: accessToken(now),
        now,
      });

      const serialized = session.toJSON();

      expect(serialized["refreshTokenHash"]).toBe("[REDACTED]");
    });
  });
});
