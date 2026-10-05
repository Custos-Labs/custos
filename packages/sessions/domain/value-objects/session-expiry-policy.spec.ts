import { Result } from "@verixa/shared-kernel";
import { ValidationError } from "@verixa/shared-kernel";
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
describe("SessionExpiryPolicy", () => {
  describe("sliding mode", () => {
    it("creates a sliding policy with a valid positive duration", () => {
      const policy = SessionExpiryPolicy.sliding(3600000); // 1 hour

      expect(policy.mode).toBe("sliding");
      expect(policy.durationMs).toBe(3600000);
    });

    it("rejects non-positive durations", () => {
      expect(() => SessionExpiryPolicy.sliding(0)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.sliding(-1000)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.sliding(NaN)).toThrow(ValidationError);
    });

    it("rejects non-finite numbers", () => {
      expect(() => SessionExpiryPolicy.sliding(Infinity)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.sliding(-Infinity)).toThrow(ValidationError);
    });

    it("extends expiresAt by durationMs when computeNewExpiresAt is called", () => {
      const policy = SessionExpiryPolicy.sliding(3600000); // 1 hour
      const previousExpiresAt = new Date("2024-01-15T12:00:00Z");
      const touchedAt = new Date("2024-01-15T11:30:00Z");

      const newExpiresAt = policy.computeNewExpiresAt(previousExpiresAt, touchedAt);

      // Should be touchedAt + durationMs = 11:30 + 1 hour = 12:30
      expect(newExpiresAt.getTime()).toBe(touchedAt.getTime() + 3600000);
      // Not equal to previous expiry
      expect(newExpiresAt.getTime()).not.toBe(previousExpiresAt.getTime());
    });

    it("extends expiresAt even when called well before previous expiry", () => {
      const policy = SessionExpiryPolicy.sliding(3600000);
      const previousExpiresAt = new Date("2024-01-15T12:00:00Z");
      const touchedAt = new Date("2024-01-15T10:00:00Z"); // 2 hours before previous expiry

      const newExpiresAt = policy.computeNewExpiresAt(previousExpiresAt, touchedAt);

      // Should be 10:00 + 1 hour = 11:00, which is still before previous expiry
      expect(newExpiresAt.getTime()).toBe(touchedAt.getTime() + 3600000);
      expect(newExpiresAt.getTime()).toBeLessThan(previousExpiresAt.getTime());
    });
  });

  describe("absolute mode", () => {
    it("creates an absolute policy with a valid positive duration", () => {
      const policy = SessionExpiryPolicy.absolute(86400000); // 1 day

      expect(policy.mode).toBe("absolute");
      expect(policy.durationMs).toBe(86400000);
    });

    it("rejects non-positive durations", () => {
      expect(() => SessionExpiryPolicy.absolute(0)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.absolute(-1000)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.absolute(NaN)).toThrow(ValidationError);
    });

    it("rejects non-finite numbers", () => {
      expect(() => SessionExpiryPolicy.absolute(Infinity)).toThrow(ValidationError);
      expect(() => SessionExpiryPolicy.absolute(-Infinity)).toThrow(ValidationError);
    });

    it("leaves expiresAt unchanged when computeNewExpiresAt is called", () => {
      const policy = SessionExpiryPolicy.absolute(86400000);
      const previousExpiresAt = new Date("2024-01-15T12:00:00Z");
      const touchedAt = new Date("2024-01-15T11:30:00Z");

      const newExpiresAt = policy.computeNewExpiresAt(previousExpiresAt, touchedAt);

      // Should be identical to previous expiry
      expect(newExpiresAt.getTime()).toBe(previousExpiresAt.getTime());
      expect(newExpiresAt).toEqual(previousExpiresAt);
    });

    it("ignores activity and never extends expiry", () => {
      const policy = SessionExpiryPolicy.absolute(3600000);
      const previousExpiresAt = new Date("2024-01-15T12:00:00Z");

      // Call touch at various times
      const touch1 = policy.computeNewExpiresAt(
        previousExpiresAt,
        new Date("2024-01-15T10:00:00Z"),
      );
      const touch2 = policy.computeNewExpiresAt(
        previousExpiresAt,
        new Date("2024-01-15T11:00:00Z"),
      );
      const touch3 = policy.computeNewExpiresAt(
        previousExpiresAt,
        new Date("2024-01-15T11:59:00Z"),
      );

      // All should be unchanged
      expect(touch1).toEqual(previousExpiresAt);
      expect(touch2).toEqual(previousExpiresAt);
      expect(touch3).toEqual(previousExpiresAt);
    });
  });

  describe("equals", () => {
    it("considers two sliding policies with the same duration equal", () => {
      const policy1 = SessionExpiryPolicy.sliding(3600000);
      const policy2 = SessionExpiryPolicy.sliding(3600000);

      expect(policy1.equals(policy2)).toBe(true);
    });

    it("considers two absolute policies with the same duration equal", () => {
      const policy1 = SessionExpiryPolicy.absolute(86400000);
      const policy2 = SessionExpiryPolicy.absolute(86400000);

      expect(policy1.equals(policy2)).toBe(true);
    });

    it("considers two policies with different durations not equal", () => {
      const policy1 = SessionExpiryPolicy.sliding(3600000);
      const policy2 = SessionExpiryPolicy.sliding(7200000);

      expect(policy1.equals(policy2)).toBe(false);
    });

    it("considers a sliding and absolute policy with the same duration not equal", () => {
      const sliding = SessionExpiryPolicy.sliding(3600000);
      const absolute = SessionExpiryPolicy.absolute(3600000);

      expect(sliding.equals(absolute)).toBe(false);
    });

    it("is not reflexively equal to different instances even with same values", () => {
      const policy1 = SessionExpiryPolicy.sliding(3600000);
      const policy2 = SessionExpiryPolicy.sliding(3600000);

      // Different object references
      expect(policy1).not.toBe(policy2);
      // But equal by value
      expect(policy1.equals(policy2)).toBe(true);
    });
  });
});
