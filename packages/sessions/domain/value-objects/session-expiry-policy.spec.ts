import { Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { SessionExpiryPolicy } from "./session-expiry-policy.js";

describe("SessionExpiryPolicy.create", () => {
  it("accepts a valid policy", () => {
    const result = SessionExpiryPolicy.create({
      accessTokenTtlMs: 60_000,
      refreshTokenTtlMs: 3_600_000,
      absoluteLifetimeMs: 3_600_000,
      idleTimeoutMs: 1_800_000,
    });

    expect(Result.isOk(result)).toBe(true);
  });

  it("rejects a non-positive value for any field", () => {
    const result = SessionExpiryPolicy.create({
      accessTokenTtlMs: 0,
      refreshTokenTtlMs: 3_600_000,
      absoluteLifetimeMs: 3_600_000,
      idleTimeoutMs: 1_800_000,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["accessTokenTtlMs"]).toBeDefined();
    }
  });

  it("rejects a negative or non-finite value", () => {
    const result = SessionExpiryPolicy.create({
      accessTokenTtlMs: 60_000,
      refreshTokenTtlMs: -1,
      absoluteLifetimeMs: Number.NaN,
      idleTimeoutMs: 1_800_000,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["refreshTokenTtlMs"]).toBeDefined();
      expect(result.error.fieldErrors["absoluteLifetimeMs"]).toBeDefined();
    }
  });

  it("rejects an access token TTL longer than the refresh token TTL", () => {
    const result = SessionExpiryPolicy.create({
      accessTokenTtlMs: 7_200_000,
      refreshTokenTtlMs: 3_600_000,
      absoluteLifetimeMs: 3_600_000,
      idleTimeoutMs: 1_800_000,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.fieldErrors["accessTokenTtlMs"]).toContain(
        "must not be longer than refreshTokenTtlMs",
      );
    }
  });
});

describe("SessionExpiryPolicy.default", () => {
  it("returns a policy that satisfies its own validation", () => {
    const policy = SessionExpiryPolicy.default();

    expect(policy.accessTokenTtlMs).toBeLessThanOrEqual(policy.refreshTokenTtlMs);
    expect(policy.absoluteLifetimeMs).toBeGreaterThan(0);
    expect(policy.idleTimeoutMs).toBeGreaterThan(0);
  });
});

describe("SessionExpiryPolicy derived timestamps", () => {
  const policy = SessionExpiryPolicy.create({
    accessTokenTtlMs: 60_000,
    refreshTokenTtlMs: 3_600_000,
    absoluteLifetimeMs: 7_200_000,
    idleTimeoutMs: 1_800_000,
  });
  if (Result.isErr(policy)) throw new Error("fixture setup failed");
  const subject = policy.value;

  it("computes the absolute expiry from when the session opened", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(subject.absoluteExpiryFrom(openedAt).toISOString()).toBe("2026-01-01T02:00:00.000Z");
  });

  it("computes the refresh token expiry from when it was issued", () => {
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(subject.refreshTokenExpiryFrom(issuedAt).toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("treats a session as idle-expired once idleTimeoutMs has elapsed since lastSeenAt", () => {
    const lastSeenAt = new Date("2026-01-01T00:00:00.000Z");

    expect(subject.isIdleExpired(lastSeenAt, new Date("2026-01-01T00:29:59.000Z"))).toBe(false);
    expect(subject.isIdleExpired(lastSeenAt, new Date("2026-01-01T00:30:00.000Z"))).toBe(true);
  });
});
