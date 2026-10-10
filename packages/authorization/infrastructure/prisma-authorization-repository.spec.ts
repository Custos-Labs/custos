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
