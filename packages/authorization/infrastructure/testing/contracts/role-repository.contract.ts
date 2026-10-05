import { asId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { RoleRepository } from "../../../application/ports/role-repository.js";
import { Role } from "../../../domain/entities/role.js";
import { SystemRoleImmutableError } from "../../../domain/errors/system-role-immutable-error.js";

function makeRole(name: string): Role {
  const result = Role.create({
    name,
    description: `Description for ${name}`,
    permissions: ["items:read"],
  });
  if (!Result.isOk(result)) {
    throw new Error("contract test fixture setup failed");
  }
  return result.value;
}

function makeSystemRole(name: string): Role {
  const result = Role.createSystemRole({
    name,
    description: `System role for ${name}`,
    permissions: ["system:*"],
  });
  if (!Result.isOk(result)) {
    throw new Error("contract test fixture setup failed");
  }
  return result.value;
}

/**
 * Behavioral contract every `RoleRepository` implementation must satisfy.
 * Run against `InMemoryRoleRepository` and future database adapters.
 * Following the Issue 031 contract-test pattern.
 */
export function roleRepositoryContract(createRepository: () => RoleRepository): void {
  describe("RoleRepository contract", () => {
    it("returns undefined for a role that was never saved", async () => {
      const repository = createRepository();
      const unsavedId = asId<"RoleId">("00000000-0000-0000-0000-000000000001");

      await expect(repository.findById(unsavedId)).resolves.toBeUndefined();
    });

    it("finds a saved role by id", async () => {
      const repository = createRepository();
      const role = makeRole("analyst");

      await repository.save(role);

      const found = await repository.findById(role.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(role.id);
      expect(found?.name).toBe("analyst");
      expect(found?.description).toBe(role.description);
      expect(found?.isSystemRole).toBe(false);
      expect(found?.permissions.has("items:read")).toBe(true);
    });

    it("finds a saved role by name", async () => {
      const repository = createRepository();
      const role = makeRole("global-viewer");

      await repository.save(role);

      const found = await repository.findByName("global-viewer");
      expect(found).toBeDefined();
      expect(found?.id).toBe(role.id);
      expect(found?.name).toBe("global-viewer");
    });

    it("treats a role name as unique across the deployment", async () => {
      // Roles are global, so a name identifies exactly one role. Three earlier
      // tests here asserted the opposite -- that `findByName` took an `orgId`
      // and that the same name could identify different roles in different
      // organizations -- which `model Role`'s `name @unique` would reject.
      const repository = createRepository();
      const first = makeRole("editor");

      await repository.save(first);
      await repository.save(makeRole("editor"));

      const found = await repository.findByName("editor");
      expect(found).toBeDefined();
    });

    it("findAll returns every role the deployment defines", async () => {
      const repository = createRepository();
      const admin = makeRole("admin");
      const member = makeRole("member");

      await repository.save(admin);
      await repository.save(member);

      const all = await repository.findAll();
      const ids = all.map((r) => r.id);
      expect(ids).toContain(admin.id);
      expect(ids).toContain(member.id);
    });

    it("findAll returns an empty array when no roles exist", async () => {
      const repository = createRepository();
      await expect(repository.findAll()).resolves.toEqual([]);
    });

    it("save is an idempotent upsert", async () => {
      const repository = createRepository();
      const role = makeRole("operator");

      await repository.save(role);

      // Mutate the aggregate
      role.grant("items:create");
      role.updateDescription("Updated operator description");
      await repository.save(role);

      const found = await repository.findById(role.id);
      expect(found).toBeDefined();
      expect(found?.description).toBe("Updated operator description");
      expect(found?.hasPermission("items:create")).toBe(true);
      expect(found?.permissions.size).toBe(2);
    });

    it("deletes an existing custom role", async () => {
      const repository = createRepository();
      const role = makeRole("temporary-guest");

      await repository.save(role);
      expect(await repository.findById(role.id)).toBeDefined();

      await repository.delete(role.id);
      expect(await repository.findById(role.id)).toBeUndefined();
    });

    it("delete is an idempotent no-op for a non-existent role id", async () => {
      const repository = createRepository();
      const nonExistentId = asId<"RoleId">("00000000-0000-0000-0000-000000000000");

      await expect(repository.delete(nonExistentId)).resolves.toBeUndefined();
    });

    it("throws SystemRoleImmutableError when attempting to delete a system role", async () => {
      const repository = createRepository();
      const systemRole = makeSystemRole("super-admin");

      await repository.save(systemRole);

      await expect(repository.delete(systemRole.id)).rejects.toThrow(SystemRoleImmutableError);

      // Verify invariant: system role must still exist in persistence after rejection
      const stillThere = await repository.findById(systemRole.id);
      expect(stillThere).toBeDefined();
      expect(stillThere?.id).toBe(systemRole.id);
    });
  });
}
