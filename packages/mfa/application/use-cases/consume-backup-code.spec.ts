import { AccountLockedError, Result } from "@verixa/shared-kernel";
import { describe, expect, it, vi } from "vitest";

import { MfaMethod, type UserId } from "../../domain/entities/mfa-method.js";
import { BackupCodeSet } from "../../domain/services/backup-code-set.js";
import { InMemoryMfaMethodRepository } from "../../infrastructure/testing/in-memory-mfa-method-repository.js";

import { ConsumeBackupCode } from "./consume-backup-code.js";

describe("ConsumeBackupCode", () => {
  it("verifies a valid code, marks it consumed, and signals remaining count", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(2);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);
    const rawCode = generation.rawCodes[0]!;

    const result = await useCase.execute({ userId, code: rawCode });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value).toEqual({ kind: "ok", codesRemaining: 1 });

    const updated = await repo.findById(method.id);
    const hashes = JSON.parse(updated!.secret!) as string[];
    expect(hashes).toHaveLength(1);
    expect(hashes).not.toContain(generation.hashedCodes[0]);
    expect(hashes).toContain(generation.hashedCodes[1]);

    expect(record).toHaveBeenCalledWith("backup_code.consumed", userId, {
      remaining: "1",
    });
  });

  it("rejects an invalid code", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(2);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);

    const result = await useCase.execute({ userId, code: "INVALID-CODE" });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value).toEqual({ kind: "failed" });
    expect(record).toHaveBeenCalledWith("backup_code.failed", userId);
  });

  it("rejects a previously consumed code", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(2);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);
    const rawCode = generation.rawCodes[0]!;

    // First use
    await useCase.execute({ userId, code: rawCode });

    // Second use
    const result = await useCase.execute({ userId, code: rawCode });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value).toEqual({ kind: "failed" });
  });

  it("signals exhaustion on the last code", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(1);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);
    const rawCode = generation.rawCodes[0]!;

    const result = await useCase.execute({ userId, code: rawCode });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value).toEqual({ kind: "exhausted" });
  });

  it("returns failed if the user has no backup codes active", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const useCase = new ConsumeBackupCode(repo, auditLogger);
    const result = await useCase.execute({ userId, code: "ANY-CODE" });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value).toEqual({ kind: "failed" });
  });

  it("locks the method after repeated failed attempts and rejects further attempts with AccountLockedError", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(2);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);

    // Fail 4 times (under threshold of 5)
    for (let i = 0; i < 4; i++) {
      const res = await useCase.execute({ userId, code: `WRONG-${i}` });
      expect(Result.isOk(res)).toBe(true);
      if (Result.isOk(res)) {
        expect(res.value).toEqual({ kind: "failed" });
      }
    }

    let stored = await repo.findById(method.id);
    expect(stored!.failedAttempts).toBe(4);
    expect(stored!.lockedUntil).toBeNull();

    // 5th failed attempt triggers lockout
    const fifthRes = await useCase.execute({ userId, code: "WRONG-5" });
    expect(Result.isOk(fifthRes)).toBe(true);
    if (Result.isOk(fifthRes)) {
      expect(fifthRes.value).toEqual({ kind: "failed" });
    }

    stored = await repo.findById(method.id);
    expect(stored!.failedAttempts).toBe(5);
    expect(stored!.lockedUntil).not.toBeNull();
    expect(stored!.isLockedAt(new Date())).toBe(true);

    // 6th attempt while locked must return AccountLockedError rather than generic failure
    const lockedRes = await useCase.execute({ userId, code: generation.rawCodes[0]! });
    expect(Result.isErr(lockedRes)).toBe(true);
    if (Result.isErr(lockedRes)) {
      expect(lockedRes.error).toBeInstanceOf(AccountLockedError);
      expect(lockedRes.error.message).toBe("Authentication attempts are rate-limited.");
    }
  });

  it("clears failed attempts counter and lockout on successful code consumption", async () => {
    const repo = new InMemoryMfaMethodRepository();
    const record = vi.fn().mockResolvedValue(undefined);
    const auditLogger = { record };
    const userId = "user-123" as UserId;

    const generation = await BackupCodeSet.generate(3);
    const method = MfaMethod.create(userId, "backup_codes", JSON.stringify(generation.hashedCodes));
    method.activate();
    await repo.save(method);

    const useCase = new ConsumeBackupCode(repo, auditLogger);

    // Record some failures below threshold
    await useCase.execute({ userId, code: "BAD-1" });
    await useCase.execute({ userId, code: "BAD-2" });

    let stored = await repo.findById(method.id);
    expect(stored!.failedAttempts).toBe(2);

    // Submit a valid code
    const successRes = await useCase.execute({ userId, code: generation.rawCodes[0]! });
    expect(Result.isOk(successRes)).toBe(true);
    if (Result.isOk(successRes)) {
      expect(successRes.value).toEqual({ kind: "ok", codesRemaining: 2 });
    }

    // Counter must be reset to 0
    stored = await repo.findById(method.id);
    expect(stored!.failedAttempts).toBe(0);
    expect(stored!.lockedUntil).toBeNull();
  });
});
