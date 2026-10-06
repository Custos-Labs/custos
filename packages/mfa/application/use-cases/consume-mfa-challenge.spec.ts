import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { MfaChallenge, type MfaChallengeUserId } from "../../domain/entities/mfa-challenge.js";

import {
  ConsumeMfaChallenge,
  type MfaChallengeRepository,
  type SessionIssuer,
} from "./consume-mfa-challenge.js";

const userId: MfaChallengeUserId = asId("11111111-1111-1111-1111-111111111111");

function fakeChallengeRepository(challenge: MfaChallenge): MfaChallengeRepository {
  return {
    findById: () => Promise.resolve(challenge),
    save: () => Promise.resolve(),
  };
}

describe("ConsumeMfaChallenge", () => {
  it("consumes a valid challenge and calls the session issuer exactly once", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const challenge = MfaChallenge.create({ userId, now });

    // Held in a local and read through that, rather than off `sessionIssuer`
    // after construction: the latter is what `@typescript-eslint/unbound-method`
    // flags, since a method read off its object is detached from `this`.
    const execute = vi
      .fn()
      .mockResolvedValue(
        Result.ok({ session: {}, accessToken: "token", rawRefreshToken: "refresh" }),
      );
    const sessionIssuer: SessionIssuer = { execute };

    const useCase = new ConsumeMfaChallenge(fakeChallengeRepository(challenge), sessionIssuer);

    const result = await useCase.execute({
      challengeId: challenge.id,
      issueSessionCommand: {
        userId,
        metadata: { ipAddress: "127.0.0.1", userAgent: "test" },
        now,
      },
      now,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired challenge and does not call the session issuer", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const challenge = MfaChallenge.create({
      userId,
      expiresAt: new Date("2025-01-01T00:05:00.000Z"),
      now,
    });

    const execute = vi.fn();
    const sessionIssuer: SessionIssuer = { execute };
    const useCase = new ConsumeMfaChallenge(fakeChallengeRepository(challenge), sessionIssuer);

    const future = new Date("2025-01-01T00:06:00.000Z");
    const result = await useCase.execute({
      challengeId: challenge.id,
      issueSessionCommand: {
        userId,
        metadata: { ipAddress: "127.0.0.1", userAgent: "test" },
        now: future,
      },
      now: future,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBe("CHALLENGE_EXPIRED");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an already consumed challenge (single-use enforcement) and does not call the session issuer", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const challenge = MfaChallenge.create({ userId, now }).consume(now);

    const execute = vi.fn();
    const sessionIssuer: SessionIssuer = { execute };
    const useCase = new ConsumeMfaChallenge(fakeChallengeRepository(challenge), sessionIssuer);

    const result = await useCase.execute({
      challengeId: challenge.id,
      issueSessionCommand: {
        userId,
        metadata: { ipAddress: "127.0.0.1", userAgent: "test" },
        now,
      },
      now,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBe("CHALLENGE_ALREADY_CONSUMED");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a challenge id that was never issued", async () => {
    const execute = vi.fn();
    const sessionIssuer: SessionIssuer = { execute };
    const challengeRepository: MfaChallengeRepository = {
      findById: () => Promise.resolve(null),
      save: () => Promise.resolve(),
    };
    const useCase = new ConsumeMfaChallenge(challengeRepository, sessionIssuer);

    const result = await useCase.execute({
      challengeId: asId("99999999-9999-9999-9999-999999999999"),
      issueSessionCommand: {
        userId,
        metadata: { ipAddress: "127.0.0.1", userAgent: "test" },
      },
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error).toBe("CHALLENGE_NOT_FOUND");
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
