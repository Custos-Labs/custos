import type { PrismaClient } from "@verixa/database";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationError } from "../domain/authorization.js";
import { SystemRoleImmutableError } from "../domain/errors/system-role-immutable-error.js";

import { PrismaAuthorizationRepository } from "./prisma-authorization-repository.js";

describe("PrismaAuthorizationRepository", () => {
  describe("deleteRole", () => {
    it("throws AuthorizationError('NOT_FOUND') when role does not exist", async () => {
      const deleteMock = vi.fn();
      const mockPrisma = {
        role: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: deleteMock,
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      await expect(repository.deleteRole("non-existent-id")).rejects.toThrow(AuthorizationError);
    });

    it("throws SystemRoleImmutableError when attempting to delete a system role", async () => {
      const deleteMock = vi.fn();
      const mockPrisma = {
        role: {
          findUnique: vi.fn().mockResolvedValue({
            id: "system-role-id",
            name: "super-admin",
            isSystemRole: true,
          }),
          delete: deleteMock,
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      let caughtError: unknown;
      try {
        await repository.deleteRole("system-role-id");
      } catch (error) {
        caughtError = error;
      }

      // Acceptance criterion: A spec asserts the error type, not the message.
      expect(caughtError).toBeInstanceOf(SystemRoleImmutableError);
      const immutableError = caughtError as SystemRoleImmutableError;
      expect(immutableError.attemptedAction).toBe("delete");
      expect(immutableError.roleId).toBe("system-role-id");
      expect(immutableError.roleName).toBe("super-admin");
      expect(immutableError.code).toBe("SYSTEM_ROLE_IMMUTABLE");
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("deletes a standard (non-system) role successfully", async () => {
      const deleteMock = vi.fn().mockResolvedValue({ id: "custom-role-id" });
      const mockPrisma = {
        role: {
          findUnique: vi.fn().mockResolvedValue({
            id: "custom-role-id",
            name: "custom-editor",
            isSystemRole: false,
          }),
          delete: deleteMock,
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      await expect(repository.deleteRole("custom-role-id")).resolves.toBeUndefined();
      expect(deleteMock).toHaveBeenCalledWith({
        where: { id: "custom-role-id" },
      });
    });
  });
});
