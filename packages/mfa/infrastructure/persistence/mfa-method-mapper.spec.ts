import type { MfaMethodRow as PrismaMfaMethodRow } from "@verixa/database";
import { describe, expect, it } from "vitest";

import { MfaMethodMapper } from "./mfa-method-mapper.js";

function createRow(overrides: Partial<PrismaMfaMethodRow> = {}): PrismaMfaMethodRow {
  return {
    id: "m1",
    userId: "u1",
    type: "totp",
    status: "active",
    secret: null,
    lastUsedAt: null,
    failedAttempts: 3,
    lockedUntil: new Date("2026-10-09T18:00:00.000Z"),
    lastUsedStep: 1234567,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-09T17:00:00.000Z"),
    ...overrides,
  };
}

describe("MfaMethodMapper", () => {
  it("round-trips lockout and replay state instead of resetting it", () => {
    const method = MfaMethodMapper.toDomain(createRow());
    expect(method.failedAttempts).toBe(3);
    expect(method.lockedUntil).toEqual(new Date("2026-10-09T18:00:00.000Z"));
    expect(method.lastUsedStep).toBe(1234567);

    const back = MfaMethodMapper.toRow(method);
    expect(back.failedAttempts).toBe(3);
    expect(back.lockedUntil).toEqual(new Date("2026-10-09T18:00:00.000Z"));
    expect(back.lastUsedStep).toBe(1234567);
  });

  it("rehydrates zero state for a fresh method", () => {
    const method = MfaMethodMapper.toDomain(
      createRow({ failedAttempts: 0, lockedUntil: null, lastUsedStep: null }),
    );
    expect(method.failedAttempts).toBe(0);
    expect(method.lockedUntil).toBeNull();
    expect(method.lastUsedStep).toBeNull();
    expect(method.isLockedAt(new Date())).toBe(false);
  });
});
