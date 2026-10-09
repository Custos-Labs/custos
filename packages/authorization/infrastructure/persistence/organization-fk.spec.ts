import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startTestDatabase, type TestDatabase } from "../testing/database-harness.js";

const database = await startTestDatabase();

describe.skipIf(database === undefined)(
  "user_role_assignments.organization_id FK (real Postgres)",
  () => {
    const db = database as TestDatabase;

    beforeAll(async () => {
      await db.prisma.$connect();
    }, 120_000);

    afterEach(async () => {
      await db.prisma.userRoleAssignment.deleteMany({});
      await db.prisma.organization.deleteMany({});
      await db.prisma.role.deleteMany({});
      await db.prisma.user.deleteMany({});
    });

    afterAll(async () => {
      await db.stop();
    }, 120_000);

    async function seedGraph() {
      const now = new Date();
      const userId = randomUUID();
      const roleId = randomUUID();
      const orgId = randomUUID();
      await db.prisma.user.create({
        data: {
          id: userId,
          email: `fk-${userId}@example.com`,
          displayName: "FK User",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
      await db.prisma.role.create({
        data: { id: roleId, name: `fk-role-${roleId}`, createdAt: now, updatedAt: now },
      });
      await db.prisma.organization.create({
        data: {
          id: orgId,
          name: "FK Org",
          slug: `fk-org-${orgId}`,
          ownerId: userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
      return { userId, roleId, orgId };
    }

    it("rejects an assignment naming an organization that does not exist", async () => {
      const { userId, roleId } = await seedGraph();
      await expect(
        db.prisma.userRoleAssignment.create({
          data: {
            id: randomUUID(),
            userId,
            roleId,
            organizationId: "00000000-0000-0000-0000-000000000000",
            assignedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/P2003|Foreign key constraint/);
    });

    it("refuses to delete an organization that still has assignments (Restrict)", async () => {
      const { userId, roleId, orgId } = await seedGraph();
      await db.prisma.userRoleAssignment.create({
        data: { id: randomUUID(), userId, roleId, organizationId: orgId, assignedAt: new Date() },
      });
      await expect(db.prisma.organization.delete({ where: { id: orgId } })).rejects.toThrow(
        /P2003|Foreign key constraint/,
      );
    });
  },
);
