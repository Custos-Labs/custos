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
  });
});
