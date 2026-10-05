import { Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Permission } from "../../domain/value-objects/permission.js";
import { InMemoryRoleRepository } from "../../infrastructure/fakes/in-memory-role-repository.js";

import { CreateRole } from "./create-role.js";

describe("CreateRole", () => {
  let roleRepository: InMemoryRoleRepository;
  let createRole: CreateRole;

  beforeEach(() => {
    roleRepository = new InMemoryRoleRepository();
    createRole = new CreateRole(roleRepository);
  });

  it("creates a global role successfully and persists it", async () => {
    const result = await createRole.execute({
      name: "billing-manager",
      description: "Manages subscriptions and invoices",
      permissions: ["billing:read", "billing:write"],
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.name).toBe("billing-manager");
      expect(result.value.description).toBe("Manages subscriptions and invoices");
      expect(result.value.hasPermission("billing:read")).toBe(true);
      expect(result.value.hasPermission("billing:write")).toBe(true);

      const persisted = await roleRepository.findById(result.value.id);
      expect(persisted).toBeDefined();
      expect(persisted?.id).toBe(result.value.id);
    }
  });

  it("rejects a duplicate name, because roles are global", async () => {
    // Role names are unique across the deployment, not per organization:
    // `model Role` has `name @unique` and no `organization_id`, because the set
    // of roles a deployment supports is administrative rather than per-tenant.
    const first = await createRole.execute({
      name: "viewer",
      permissions: [Permission.from("docs:read")],
    });
    expect(Result.isOk(first)).toBe(true);

    const duplicate = await createRole.execute({ name: "viewer" });

    expect(Result.isErr(duplicate)).toBe(true);
    if (Result.isErr(duplicate)) {
      expect(duplicate.error.code).toBe("CONFLICT");
      expect(duplicate.error.message).toContain('Role with name "viewer" already exists');
    }
  });

  it("rejects creating a non-system role with the global wildcard *:*", async () => {
    const result = await createRole.execute({
      name: "super-user",
      permissions: ["*:*"],
      isSystemRole: false,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("Global wildcard");
    }
  });

  it("allows creating a system role with the global wildcard *:*", async () => {
    const result = await createRole.execute({
      name: "super-admin",
      permissions: ["*:*"],
      isSystemRole: true,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.isSystemRole).toBe(true);
      expect(result.value.hasPermission("*:*")).toBe(true);
    }
  });

  it("rejects invalid role parameters without writing to repository", async () => {
    const result = await createRole.execute({ name: "" });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
