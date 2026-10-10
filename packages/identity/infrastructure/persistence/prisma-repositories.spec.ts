import { Result } from "@verixa/shared-kernel";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CreateOrganization } from "../../application/use-cases/create-organization.js";
import { Invitation } from "../../domain/entities/invitation.js";
import { Organization } from "../../domain/entities/organization.js";
import { Email } from "../../domain/value-objects/email.js";
import { organizationMembershipRepositoryContract } from "../testing/contracts/organization-membership-repository.contract.js";
import { organizationRepositoryContract } from "../testing/contracts/organization-repository.contract.js";
import { userRepositoryContract } from "../testing/contracts/user-repository.contract.js";
import { startTestDatabase, type TestDatabase } from "../testing/database-harness.js";

import { PrismaInvitationRepository } from "./prisma-invitation-repository.js";
import {
  PrismaOrganizationMembershipRepository,
  PrismaOrganizationRepository,
} from "./prisma-organization-repository.js";
import { PrismaUnitOfWork } from "./prisma-unit-of-work.js";
import { PrismaUserRepository } from "./prisma-user-repository.js";

/**
 * Runs the *same* contract suites the in-memory fakes pass
 * (`repository-contract.spec.ts`) against the real Prisma adapters and a real
 * Postgres, plus the guarantees only a real database can make.
 *
 * This is the payoff of Issue 031 writing those contracts as reusable
 * functions rather than inline `it` blocks: two implementations, one set of
 * assertions, so "the fake behaves like the real thing" is proven rather than
 * assumed — which matters because every use-case unit test in this package
 * silently depends on that assumption.
 *
 * Skips when no database is reachable and Docker isn't available; see
 * `database-harness.ts`.
 */

const database = await startTestDatabase();

/**
 * Ids the shared contracts reference as fixtures. Against the in-memory fakes
 * these are arbitrary strings, because a `Map` has no notion of a foreign
 * key. Against Postgres they must actually exist, or every insert fails on a
 * foreign-key violation.
 *
 * That divergence is itself a finding worth stating plainly: the fakes do not
 * enforce referential integrity, so a use case that references a nonexistent
 * user passes against a fake and fails against a database. Seeding here keeps
 * the contracts implementation-agnostic — they assert behavior, not schema —
 * while acknowledging the real constraint honestly rather than weakening the
 * schema to match the fake.
 */
const CONTRACT_USER_ID = "00000000-0000-0000-0000-000000000001";
const CONTRACT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000002";
const CONTRACT_OTHER_USER_ID = "00000000-0000-0000-0000-000000000003";

describe.skipIf(database === undefined)("Prisma repositories (real Postgres)", () => {
  // Safe under `skipIf`: the body only runs when `database` is defined.
  const db = database as TestDatabase;

  beforeAll(async () => {
    await db.prisma.$connect();
  }, 120_000);

  afterEach(async () => {
    // The contracts assume they start from an empty store — the in-memory
    // fakes get that free from a new Map per factory call, so the Prisma
    // implementation has to provide it explicitly. Order matters:
    // `organizations.owner_id` is ON DELETE RESTRICT, so users go last.
    await db.prisma.userRoleAssignment.deleteMany({});
    await db.prisma.verificationRequest.deleteMany({});
    await db.prisma.invitation.deleteMany({});
    await db.prisma.organizationMembership.deleteMany({});
    await db.prisma.organization.deleteMany({});
    await db.prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await db.stop();
  }, 120_000);

  describe("UserRepository", () => {
    userRepositoryContract(() => new PrismaUserRepository(db.prisma));
  });

  describe("OrganizationRepository", () => {
    beforeEach(async () => {
      await db.prisma.user.create({
        data: {
          id: CONTRACT_USER_ID,
          email: `owner-${CONTRACT_USER_ID}@example.com`,
          displayName: "Contract Owner",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    organizationRepositoryContract(() => new PrismaOrganizationRepository(db.prisma));
  });

  describe("OrganizationMembershipRepository", () => {
    beforeEach(async () => {
      const now = new Date();
      await db.prisma.user.createMany({
        data: [CONTRACT_USER_ID, CONTRACT_OTHER_USER_ID].map((id) => ({
          id,
          email: `member-${id}@example.com`,
          displayName: "Contract Member",
          status: "active" as const,
          createdAt: now,
          updatedAt: now,
        })),
      });
      await db.prisma.organization.create({
        data: {
          id: CONTRACT_ORGANIZATION_ID,
          name: "Contract Org",
          slug: "contract-org",
          ownerId: CONTRACT_USER_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
    });

    organizationMembershipRepositoryContract(
      () => new PrismaOrganizationMembershipRepository(db.prisma),
    );
  });

  describe("database-enforced invariants the fakes cannot provide", () => {
    async function seedOwner(id: string): Promise<void> {
      const now = new Date();
      await db.prisma.user.create({
        data: {
          id,
          email: `owner-${id}@example.com`,
          displayName: "Owner",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    it("rejects a second active membership for the same user and organization", async () => {
      const now = new Date();
      await seedOwner(CONTRACT_USER_ID);
      await db.prisma.organization.create({
        data: {
          id: CONTRACT_ORGANIZATION_ID,
          name: "Org",
          slug: "org",
          ownerId: CONTRACT_USER_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      const membership = {
        userId: CONTRACT_USER_ID,
        organizationId: CONTRACT_ORGANIZATION_ID,
        status: "active" as const,
        joinedAt: now,
      };
      await db.prisma.organizationMembership.create({
        data: { ...membership, id: "00000000-0000-0000-0000-0000000000aa" },
      });

      // The partial unique index from Issue 044. `OrganizationMembership.create()`
      // already rejects this on the normal path; the index is what holds when
      // two concurrent requests both read "no active membership" before either
      // writes — a race no amount of application-level checking can close.
      const duplicate = db.prisma.organizationMembership.create({
        data: { ...membership, id: "00000000-0000-0000-0000-0000000000bb" },
      });

      await expect(duplicate).rejects.toThrow();
    });

    it("allows rejoining after a membership is revoked", async () => {
      const now = new Date();
      await seedOwner(CONTRACT_USER_ID);
      await db.prisma.organization.create({
        data: {
          id: CONTRACT_ORGANIZATION_ID,
          name: "Org",
          slug: "org",
          ownerId: CONTRACT_USER_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      // Proves the index is *partial*. A plain composite UNIQUE would forbid
      // this, and leaving-then-rejoining an organization is ordinary behavior.
      await db.prisma.organizationMembership.create({
        data: {
          id: "00000000-0000-0000-0000-0000000000aa",
          userId: CONTRACT_USER_ID,
          organizationId: CONTRACT_ORGANIZATION_ID,
          status: "revoked",
          joinedAt: now,
        },
      });

      const rejoin = db.prisma.organizationMembership.create({
        data: {
          id: "00000000-0000-0000-0000-0000000000bb",
          userId: CONTRACT_USER_ID,
          organizationId: CONTRACT_ORGANIZATION_ID,
          status: "active",
          joinedAt: now,
        },
      });

      await expect(rejoin).resolves.toBeDefined();
    });

    it("refuses to delete a user who still owns an organization", async () => {
      const now = new Date();
      await seedOwner(CONTRACT_USER_ID);
      await db.prisma.organization.create({
        data: {
          id: CONTRACT_ORGANIZATION_ID,
          name: "Org",
          slug: "org",
          ownerId: CONTRACT_USER_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      // ON DELETE RESTRICT. Cascading here would mean erasing one account
      // silently destroys an entire organization and every other member's
      // access to it.
      await expect(db.prisma.user.delete({ where: { id: CONTRACT_USER_ID } })).rejects.toThrow();
    });
  });

  describe("PrismaInvitationRepository", () => {
    it("finds an invitation by its raw token, and never stores that token", async () => {
      const now = new Date();
      await db.prisma.user.create({
        data: {
          id: CONTRACT_USER_ID,
          email: `inviter-${CONTRACT_USER_ID}@example.com`,
          displayName: "Inviter",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
      await db.prisma.organization.create({
        data: {
          id: CONTRACT_ORGANIZATION_ID,
          name: "Org",
          slug: "org",
          ownerId: CONTRACT_USER_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      const email = Email.create("invitee@example.com");
      if (!Result.isOk(email)) throw new Error("fixture setup failed");

      const { invitation, token } = Invitation.create({
        organizationId: CONTRACT_ORGANIZATION_ID as never,
        email: email.value,
        invitedByUserId: CONTRACT_USER_ID as never,
      });

      const repository = new PrismaInvitationRepository(db.prisma);
      await repository.save(invitation);

      const found = await repository.findByToken(token);
      expect(found?.id).toBe(invitation.id);

      // The security property, asserted against the actual stored row: the
      // raw token appears nowhere. See docs/security/token-storage.md.
      const row = await db.prisma.invitation.findUnique({ where: { id: invitation.id } });
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row?.tokenHash).toBe(Invitation.hashToken(token));
    });

    it("returns undefined for a token that was never issued", async () => {
      const repository = new PrismaInvitationRepository(db.prisma);

      await expect(repository.findByToken("never-issued")).resolves.toBeUndefined();
    });
  });

  describe("PrismaUnitOfWork", () => {
    it("commits an organization and its owner membership together", async () => {
      await db.prisma.user.create({
        data: {
          id: CONTRACT_USER_ID,
          email: `owner-${CONTRACT_USER_ID}@example.com`,
          displayName: "Owner",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const useCase = new CreateOrganization(new PrismaUnitOfWork(db.prisma));
      const result = await useCase.execute({
        name: "Acme Inc",
        slug: "acme",
        ownerId: CONTRACT_USER_ID as never,
      });

      expect(Result.isOk(result)).toBe(true);
      await expect(db.prisma.organization.count({ where: { slug: "acme" } })).resolves.toBe(1);
      await expect(db.prisma.organizationMembership.count()).resolves.toBe(1);
    });

    it("rolls back every write in the unit when the work rejects", async () => {
      await db.prisma.user.create({
        data: {
          id: CONTRACT_USER_ID,
          email: `owner-${CONTRACT_USER_ID}@example.com`,
          displayName: "Owner",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const unitOfWork = new PrismaUnitOfWork(db.prisma);

      // Saves a valid organization, then fails. The save must not survive:
      // without a transaction it would, leaving an organization with no
      // owner-member — precisely the corrupt half-written state the unit of
      // work exists to prevent. This is the port's documented contract
      // ("if `work` throws, every write inside it is rolled back") verified
      // against the only implementation that can actually honor it.
      const attempt = unitOfWork.run(async (repositories) => {
        const organization = Organization.create({
          name: "Doomed",
          slug: "doomed",
          ownerId: CONTRACT_USER_ID as never,
        });
        if (!Result.isOk(organization)) throw new Error("fixture setup failed");

        await repositories.organizations.save(organization.value);

        // Stand-in for any later step failing — a constraint violation, a
        // dropped connection, a bug. The cause is irrelevant; the guarantee
        // is that nothing before it sticks.
        throw new Error("simulated failure after the first write");
      });

      await expect(attempt).rejects.toThrow("simulated failure after the first write");
      await expect(db.prisma.organization.count({ where: { slug: "doomed" } })).resolves.toBe(0);
    });
  });
});
