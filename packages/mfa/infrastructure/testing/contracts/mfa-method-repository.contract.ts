import { createId, type Id } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { MfaMethodRepository } from "../../../application/ports/mfa-method-repository.js";
import { MfaMethod } from "../../../domain/entities/mfa-method.js";

function makePendingMethod(userId: Id<"UserId">): MfaMethod {
  return MfaMethod.createPendingTotp(userId, { value: "SECRET", provisioningUri: "uri" });
}

export function mfaMethodRepositoryContract(createRepository: () => MfaMethodRepository): void {
  describe("MfaMethodRepository contract", () => {
    it("returns undefined for a method that was never saved", async () => {
      const repository = createRepository();
      await expect(repository.findById(createId<"MfaMethodId">())).resolves.toBeUndefined();
    });

    it("finds a saved method by id", async () => {
      const repository = createRepository();
      const method = makePendingMethod(createId<"UserId">());

      await repository.save(method);
      const found = await repository.findById(method.id);

      expect(found?.id).toBe(method.id);
      expect(found?.userId).toBe(method.userId);
      expect(found?.status).toBe("pending");
    });

    it("save is an idempotent upsert", async () => {
      const repository = createRepository();
      const method = makePendingMethod(createId<"UserId">());

      await repository.save(method);
      const activated = method.activate();
      await repository.save(activated);

      const found = await repository.findById(method.id);
      expect(found?.status).toBe("active");
    });

    it("filters active methods by user id", async () => {
      const repository = createRepository();
      const userId = createId<"UserId">();
      const otherUserId = createId<"UserId">();

      const method1 = makePendingMethod(userId).activate();
      const method2 = makePendingMethod(userId); // pending
      const method3 = makePendingMethod(otherUserId).activate(); // different user

      await repository.save(method1);
      await repository.save(method2);
      await repository.save(method3);

      const active = await repository.findActiveByUserId(userId);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(method1.id);
    });

    it("filters pending methods by user id", async () => {
      const repository = createRepository();
      const userId = createId<"UserId">();
      const otherUserId = createId<"UserId">();

      const method1 = makePendingMethod(userId);
      const method2 = makePendingMethod(userId).activate(); // active
      const method3 = makePendingMethod(otherUserId); // different user

      await repository.save(method1);
      await repository.save(method2);
      await repository.save(method3);

      const pending = await repository.findPendingByUserId(userId);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(method1.id);
    });

    it("deletes a method", async () => {
      const repository = createRepository();
      const method = makePendingMethod(createId<"UserId">());

      await repository.save(method);
      await repository.delete(method.id);

      await expect(repository.findById(method.id)).resolves.toBeUndefined();
import { describe, expect, it } from "vitest";
import type { MfaMethodRepository } from "../../../application/ports/mfa-method-repository.js";
import { MfaMethod, type UserId, type MfaMethodId } from "../../../domain/entities/mfa-method.js";

export function mfaMethodRepositoryContract(
  createRepository: () => MfaMethodRepository,
  setupUser: () => Promise<UserId>
): void {
  describe("MfaMethodRepository contract", () => {
    it("returns undefined for a missing method", async () => {
      const repo = createRepository();
      const dummyId = "00000000-0000-0000-0000-000000000000" as MfaMethodId;
      await expect(repo.findById(dummyId)).resolves.toBeUndefined();
    });

    it("saves and finds a method by id", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "totp", "super-secret");
      await repo.save(method);

      const found = await repo.findById(method.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(method.id);
      expect(found?.secret).toBe("super-secret");
      expect(found?.userId).toBe(userId);
      expect(found?.type).toBe("totp");
    });

    it("finds active methods by userId", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "totp", "secret1");
      method.activate();
      await repo.save(method);

      const active = await repo.findActiveByUserId(userId);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(method.id);
      
      const pending = await repo.findPendingByUserId(userId);
      expect(pending).toHaveLength(0);
    });

    it("deletes a method", async () => {
      const repo = createRepository();
      const userId = await setupUser();
      const method = MfaMethod.create(userId, "webauthn");
      await repo.save(method);
      await repo.delete(method.id);
      await expect(repo.findById(method.id)).resolves.toBeUndefined();
    });
  });
}
