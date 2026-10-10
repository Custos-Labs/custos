import { createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { MfaMethod } from "../../domain/entities/mfa-method.js";
import { BackupCodeSet } from "../../domain/services/backup-code-set.js";
import type { TotpAlgorithm } from "../../domain/services/totp-algorithm.js";
import { StepUpAssertion } from "../../domain/value-objects/step-up-assertion.js";
import { InMemoryMfaMethodRepository } from "../../infrastructure/testing/in-memory-mfa-method-repository.js";
import type { StepUpAssertionStore } from "../ports/step-up-assertion-store.js";

import { ConsumeBackupCode } from "./consume-backup-code.js";
import { StepUpAuthentication, type StepUpAuthenticationDeps } from "./step-up-authentication.js";
import { VerifyTotpChallenge } from "./verify-totp-challenge.js";

class InMemoryStepUpAssertionStore implements StepUpAssertionStore {
  private latest = new Map<string, StepUpAssertion>();

  record(assertion: StepUpAssertion): Promise<void> {
    this.latest.set(assertion.userId, assertion);
    return Promise.resolve();
  }

  findLatest(userId: string): Promise<StepUpAssertion | undefined> {
    return Promise.resolve(this.latest.get(userId));
  }
}

const fakeTotpAlgorithm: TotpAlgorithm = {
  generateSecret: () => Promise.resolve({ value: "SECRET", provisioningUri: "uri" }),
  verify: (_secret, code) => Promise.resolve(code === "123456" ? 1000 : null),
};

function setup(overrides?: Partial<StepUpAuthenticationDeps>) {
  const repository = new InMemoryMfaMethodRepository();
  const assertionStore = new InMemoryStepUpAssertionStore();
  const auditLogger = { record: vi.fn().mockResolvedValue(undefined) };
  const verifyTotpChallenge = new VerifyTotpChallenge(repository, fakeTotpAlgorithm);
  const consumeBackupCode = new ConsumeBackupCode(repository, auditLogger);

  const deps: StepUpAuthenticationDeps = {
    mfaMethodRepository: repository,
    verifyTotpChallenge,
    consumeBackupCode,
    assertionStore,
    auditLogger,
    ...overrides,
  };

  const useCase = new StepUpAuthentication(deps);

  return {
    repository,
    assertionStore,
    auditLogger,
    verifyTotpChallenge,
    consumeBackupCode,
    useCase,
    deps,
  };
}

describe("StepUpAuthentication", () => {
  it("skips verification for a disabled subject and verifies nothing (Issue 108)", async () => {
    const { deps, assertionStore, verifyTotpChallenge } = setup({
      resolvePolicy: () => Promise.resolve("disabled"),
    });
    const stepUp = new StepUpAuthentication(deps);
    const spy = vi.spyOn(verifyTotpChallenge, "execute");
    const result = await stepUp.execute({
      userId: "u1",
      method: { type: "totp", methodId: "m1", code: "000000" },
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.methodType).toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await assertionStore.findLatest("u1")).toBeUndefined();
  });

  it("verifies a TOTP code and issues a short-lived assertion", async () => {
    const { repository, useCase, auditLogger } = setup();
    const userId = createId<"UserId">();
    const method = MfaMethod.createPendingTotp(userId, { value: "SECRET" }).activate();
    await repository.save(method);

    const result = await useCase.execute({
      userId,
      method: { type: "totp", methodId: method.id, code: "123456" },
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;
    expect(result.value.methodType).toBe("totp");
    expect(result.value.expiresAt.getTime()).toBeGreaterThan(result.value.verifiedAt.getTime());
    expect(auditLogger.record).toHaveBeenCalledWith("mfa.step_up", userId, { method: "totp" });
  });

  it("reuses VerifyTotpChallenge rather than re-implementing verification", async () => {
    const { repository, useCase, verifyTotpChallenge } = setup();
    const userId = createId<"UserId">();
    const method = MfaMethod.createPendingTotp(userId, { value: "SECRET" }).activate();
    await repository.save(method);

    const spy = vi.spyOn(verifyTotpChallenge, "execute");
    await useCase.execute({
      userId,
      method: { type: "totp", methodId: method.id, code: "123456" },
    });

    expect(spy).toHaveBeenCalledWith({ methodId: method.id, code: "123456" });
  });

  it("verifies a backup code through ConsumeBackupCode", async () => {
    const { repository, useCase, consumeBackupCode } = setup();
    const userId = createId<"UserId">();
    const generation = await BackupCodeSet.generate(1);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repository.save(method);

    const spy = vi.spyOn(consumeBackupCode, "execute");
    const result = await useCase.execute({
      userId,
      method: { type: "backup_code", code: generation.rawCodes[0]! },
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;
    expect(result.value.methodType).toBe("backup_codes");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("rejects a method that belongs to another user", async () => {
    const { repository, useCase } = setup();
    const owner = createId<"UserId">();
    const attacker = createId<"UserId">();
    const method = MfaMethod.createPendingTotp(owner, { value: "SECRET" }).activate();
    await repository.save(method);

    const result = await useCase.execute({
      userId: attacker,
      method: { type: "totp", methodId: method.id, code: "123456" },
    });

    expect(Result.isErr(result)).toBe(true);
  });

  it("rejects a stale assertion in requireFresh", async () => {
    const { assertionStore, useCase } = setup();
    const userId = createId<"UserId">();
    const now = new Date();
    await assertionStore.record(
      StepUpAssertion.from({
        userId,
        methodType: "totp",
        verifiedAt: new Date(now.getTime() - 10 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      }),
    );

    const result = await useCase.requireFresh(userId, now);
    expect(Result.isErr(result)).toBe(true);
  });

  it("accepts a fresh assertion in requireFresh", async () => {
    const { assertionStore, useCase } = setup();
    const userId = createId<"UserId">();
    const now = new Date();
    await assertionStore.record(
      StepUpAssertion.from({
        userId,
        methodType: "totp",
        verifiedAt: new Date(now.getTime() - 60 * 1000),
        expiresAt: new Date(now.getTime() + 4 * 60 * 1000),
      }),
    );

    const result = await useCase.requireFresh(userId, now);
    expect(Result.isOk(result)).toBe(true);
  });

  it("reports no step-up when none was ever performed", async () => {
    const { useCase } = setup();
    const result = await useCase.requireFresh(createId<"UserId">());
    expect(Result.isErr(result)).toBe(true);
  });
});
