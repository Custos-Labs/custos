import { Prisma, type PrismaClient } from "@verixa/database";
import { describe, expect, it } from "vitest";

import { AuthorizationError } from "../domain/authorization.js";

import { PrismaAuthorizationRepository } from "./prisma-authorization-repository.js";

function prismaKnownError(code: string): Error {
  return new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
    code,
    clientVersion: "test",
  });
}

describe("PrismaAuthorizationRepository", () => {
  describe("revokeAssignment", () => {
    it("revoking an unknown assignment id raises NOT_FOUND, not a Prisma error", async () => {
      const mockPrisma = {
        userRoleAssignment: {
          delete: () => Promise.reject(prismaKnownError("P2025")),
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      await expect(repository.revokeAssignment("assignment-that-does-not-exist")).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(AuthorizationError);
          expect((err as AuthorizationError).code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("revoking a real assignment calls delete and resolves", async () => {
      let deletedId: string | undefined;
      const mockPrisma = {
        userRoleAssignment: {
          delete: ({ where }: { where: { id: string } }) => {
            deletedId = where.id;
            return Promise.resolve({ id: where.id });
          },
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      await expect(repository.revokeAssignment("assignment-123")).resolves.toBeUndefined();
      expect(deletedId).toBe("assignment-123");
    });

    it("propagates unhandled database errors untouched", async () => {
      const dbError = new Error("connection lost");
      const mockPrisma = {
        userRoleAssignment: {
          delete: () => Promise.reject(dbError),
        },
      } as unknown as PrismaClient;

      const repository = new PrismaAuthorizationRepository(mockPrisma);

      await expect(repository.revokeAssignment("assignment-123")).rejects.toBe(dbError);
    });
  });
});
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
