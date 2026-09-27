import { PrismaClient } from "@verixa/database";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaMfaMethodRepository } from "./prisma-mfa-method-repository.js";
import { mfaMethodRepositoryContract } from "../testing/contracts/mfa-method-repository.contract.js";
import { MfaMethod, type UserId } from "../../domain/entities/mfa-method.js";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

describe("PrismaMfaMethodRepository", () => {
  beforeAll(async () => {
    await prisma.mfaMethod.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let repo: PrismaMfaMethodRepository;
  
  beforeAll(() => {
    repo = new PrismaMfaMethodRepository(prisma);
  });

  async function setupUser(): Promise<UserId> {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: "test-" + id + "@example.com",
        displayName: "Test User",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
    return id as UserId;
  }

  mfaMethodRepositoryContract(
    () => new PrismaMfaMethodRepository(prisma),
    setupUser
  );

  describe("Encryption assertion", () => {
    it("stores the TOTP secret encrypted at rest", async () => {
      const repo = new PrismaMfaMethodRepository(prisma);
      const userId = await setupUser();

      const plaintextSecret = "my-super-secret-totp";
      const method = MfaMethod.create(userId, "totp", plaintextSecret);
      await repo.save(method);

      const rawRow = await prisma.mfaMethod.findUnique({
        where: { id: method.id }
      });

      expect(rawRow).toBeDefined();
      expect(rawRow?.secret).not.toBeNull();
      expect(rawRow?.secret).not.toBe(plaintextSecret);
      expect(rawRow?.secret).not.toContain(plaintextSecret);
      
      const fetchedMethod = await repo.findById(method.id);
      expect(fetchedMethod?.secret).toBe(plaintextSecret);
    });
  });
});
