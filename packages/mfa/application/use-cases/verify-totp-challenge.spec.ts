import { AccountLockedError, createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { MfaMethod } from "../../domain/entities/mfa-method.js";
import type { TotpAlgorithm } from "../../domain/services/totp-algorithm.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";
import { VerifyTotpChallenge } from "./verify-totp-challenge.js";

describe("VerifyTotpChallenge", () => {
  const setup = () => {
    const savedMethods = new Map<string, MfaMethod>();
    
    const fakeRepo: MfaMethodRepository = {
      save: async (method) => { savedMethods.set(method.id, method); },
      findById: async (id) => savedMethods.get(id),
      findActiveByUserId: async () => [],
      findPendingByUserId: async () => [],
      delete: async () => {},
    };

    const fakeAlgo: TotpAlgorithm = {
      generateSecret: async (name) => ({ value: "SECRET", provisioningUri: "uri" }),
      verify: async (secret, code, drift) => {
        if (code === "VALID1") return 1000;
        if (code === "VALID2") return 1001; // Next step
        return null;
      }
    };

    const useCase = new VerifyTotpChallenge(fakeRepo, fakeAlgo);

    return { fakeRepo, fakeAlgo, useCase, savedMethods };
  };

  it("verifies a valid code and updates lastUsedAt and lastUsedStep", async () => {
    const { useCase, fakeRepo, savedMethods } = setup();
    const secret = { value: "SECRET", provisioningUri: "uri" };
    let method = MfaMethod.createPendingTotp(createId<"UserId">(), secret).activate();
    await fakeRepo.save(method);

    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1"
    });

    expect(result.isOk()).toBe(true);
    const updated = savedMethods.get(method.id)!;
    expect(updated.lastUsedStep).toBe(1000);
    expect(updated.lastUsedAt).toBeDefined();
    expect(updated.failedAttempts).toBe(0);
  });

  it("rejects code replay within the same or earlier step", async () => {
    const { useCase, fakeRepo, savedMethods } = setup();
    const secret = { value: "SECRET", provisioningUri: "uri" };
    // Method already used at step 1000
    let method = MfaMethod.createPendingTotp(createId<"UserId">(), secret)
      .activate()
      .recordUse(1000, new Date());
    await fakeRepo.save(method);

    // Try to reuse a code that matches step 1000
    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1" // Maps to 1000
    });

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().message).toContain("already been used");
    
    // It should also record a failed attempt for the replay
    const updated = savedMethods.get(method.id)!;
    expect(updated.failedAttempts).toBe(1);

    // But a newer step code should work
    const result2 = await useCase.execute({
      methodId: method.id,
      code: "VALID2" // Maps to 1001
    });

    expect(result2.isOk()).toBe(true);
    const updated2 = savedMethods.get(method.id)!;
    expect(updated2.lastUsedStep).toBe(1001);
  });

  it("records a failure and enforces rate limits on invalid codes", async () => {
    const { useCase, fakeRepo, savedMethods } = setup();
    const secret = { value: "SECRET", provisioningUri: "uri" };
    let method = MfaMethod.createPendingTotp(createId<"UserId">(), secret).activate();
    
    for (let i = 0; i < 5; i++) {
      method = method.recordFailedAttempt(new Date());
    }
    await fakeRepo.save(method);

    const result = await useCase.execute({
      methodId: method.id,
      code: "VALID1" // Even valid codes are rejected if locked
    });

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr()).toBeInstanceOf(AccountLockedError);
  });
});
