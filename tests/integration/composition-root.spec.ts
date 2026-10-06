import { buildContainer, type Container } from "@verixa/api/composition-root";
import { Result } from "@verixa/shared-kernel";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestPrismaClient, databaseAvailability } from "./helpers/database.js";

/**
 * Exercises the composition root (Issue 050) end to end: a use case, wired to
 * a real Prisma repository, writing to a real Postgres.
 *
 * Every layer below has been tested in isolation — the domain against no
 * infrastructure, the use cases against in-memory fakes, the adapters against
 * the shared contract suite. What none of those can prove is that the wiring
 * is right: that `RegisterUser` was handed a working repository, that the
 * mapper round-trips through an actual table, that the object graph is
 * connected at all. A container that constructs the wrong thing typechecks
 * perfectly.
 */

const available = await databaseAvailability();

describe.skipIf(!available)("composition root", () => {
  let container: Container;

  beforeAll(() => {
    // Inject a client pointed at the test database rather than letting the
    // container build its own from DATABASE_URL — a test that writes rows
    // should never be one environment variable away from a developer's
    // development database.
    container = buildContainer(createTestPrismaClient());
  });

  afterEach(async () => {
    await container.prisma.invitation.deleteMany({});
    await container.prisma.organizationMembership.deleteMany({});
    await container.prisma.organization.deleteMany({});
    await container.prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await container.dispose();
  });

  it("registers a user through the full stack and persists it", async () => {
    const result = await container.identity.registerUser.execute({
      email: "alice@example.com",
      displayName: "Alice",
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    // Read back through the raw client, not the repository: going through the
    // same adapter that wrote the row could mask a mapper bug that's
    // symmetric in both directions.
    const row = await container.prisma.user.findUnique({ where: { id: result.value.id } });
    expect(row?.email).toBe("alice@example.com");
    expect(row?.displayName).toBe("Alice");
    expect(row?.status).toBe("pending");
  });

  it("enforces email uniqueness across separate use case invocations", async () => {
    const first = await container.identity.registerUser.execute({
      email: "bob@example.com",
      displayName: "Bob",
    });
    expect(Result.isOk(first)).toBe(true);

    // Different case, so this also proves the citext column and the use
    // case's uniqueness check agree — the domain lowercases before the query,
    // and the column would have caught it even if it hadn't.
    const second = await container.identity.registerUser.execute({
      email: "BOB@EXAMPLE.COM",
      displayName: "Bob Again",
    });

    expect(Result.isErr(second)).toBe(true);
    if (Result.isErr(second)) {
      expect(second.error.code).toBe("CONFLICT");
    }
    await expect(container.prisma.user.count()).resolves.toBe(1);
  });

  it("round-trips a user through update, proving the mapper is symmetric", async () => {
    const registered = await container.identity.registerUser.execute({
      email: "carol@example.com",
      displayName: "Carol",
      givenName: "Carol",
      familyName: "Smith",
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const updated = await container.identity.updateUserProfile.execute({
      userId: registered.value.id,
      displayName: "Caroline",
    });

    expect(Result.isOk(updated)).toBe(true);
    if (!Result.isOk(updated)) return;

    // The person name survived a write, a read, a domain mutation, and a
    // second write — the path where a lossy mapper would quietly drop it.
    expect(updated.value.personName?.toFullName()).toBe("Carol Smith");
    expect(updated.value.displayName.value).toBe("Caroline");
  });

  it("creates an organization and its owner membership atomically", async () => {
    const owner = await container.identity.registerUser.execute({
      email: "dave@example.com",
      displayName: "Dave",
    });
    if (!Result.isOk(owner)) throw new Error("fixture setup failed");

    const result = await container.identity.createOrganization.execute({
      name: "Acme Inc",
      slug: "acme",
      ownerId: owner.value.id,
    });

    expect(Result.isOk(result)).toBe(true);
    await expect(container.prisma.organization.count()).resolves.toBe(1);
    await expect(
      container.prisma.organizationMembership.count({
        where: { userId: owner.value.id, status: "active" },
      }),
    ).resolves.toBe(1);
  });
});
