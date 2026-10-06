import { createConnection } from "node:net";

import { PrismaClient } from "@verixa/database";
import { createId } from "@verixa/shared-kernel";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { PrismaSessionRepository } from "../persistence/prisma-session-repository.js";

import { sessionRepositoryContract } from "./contracts/session-repository.contract.js";

const DEFAULT_TEST_DATABASE_URL = "postgres://verixa:verixa@localhost:5432/verixa_test";
const CONNECT_TIMEOUT_MS = 2000;

function testDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/** Resolves `true` only once a real TCP connection succeeds or fails — see `tests/integration/helpers/tcp-connect.ts`. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      finish(false);
    });
  });
}

async function isDatabaseAvailable(): Promise<boolean> {
  const url = new URL(testDatabaseUrl());
  return canConnect(url.hostname, Number(url.port || 5432));
}

async function databaseAvailability(): Promise<boolean> {
  const available = await isDatabaseAvailable();

  if (!available && process.env["REQUIRE_DATABASE_TESTS"] === "1") {
    throw new Error(
      `REQUIRE_DATABASE_TESTS=1 but no database is reachable at ${testDatabaseUrl()}. ` +
        "Database-backed tests must not silently skip in CI.",
    );
  }

  return available;
}

function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
}

/**
 * Runs the `SessionRepository` contract suite against `PrismaSessionRepository`
 * with a real Postgres database, plus index-usage checks only a real planner
 * can make.
 *
 * Skips when no database is reachable, so `pnpm test` passes on a fresh clone
 * without Docker. CI sets `REQUIRE_DATABASE_TESTS=1` so the skip cannot hide a
 * misconfigured pipeline.
 */
const available = await databaseAvailability();

describe.skipIf(!available)("PrismaSessionRepository (Issue 083)", () => {
  let prisma: PrismaClient;
  const createdSessionIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(() => {
    prisma = createTestPrismaClient();
  });

  afterEach(async () => {
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
      createdSessionIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** `sessions.user_id` carries a foreign key; a real Postgres enforces it even though the in-memory fake can't. */
  async function setupUser(): Promise<SessionUserId> {
    const id = createId<"UserId">();
    const now = new Date();
    await prisma.user.create({
      data: {
        id,
        email: `sessions-${id}@example.com`,
        displayName: "Sessions Test User",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    });
    createdUserIds.push(id);
    return id;
  }

  describe("contract tests", () => {
    sessionRepositoryContract(() => new PrismaSessionRepository(prisma), setupUser);
  });

  describe("index verification", () => {
    it("sessions_user_id_idx is used for findActiveByUserId queries", async () => {
      const repository = new PrismaSessionRepository(prisma);
      const userId = await setupUser();
      const session = Session.open({ userId, policy: SessionExpiryPolicy.default() });

      createdSessionIds.push(session.id);
      await repository.save(session);

      const explainResult = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (FORMAT JSON, ANALYZE)
         SELECT * FROM sessions
         WHERE user_id = $1::uuid AND revoked_at IS NULL`,
        userId,
      );

      const plan = JSON.stringify(explainResult);

      expect(plan).toContain("sessions_user_id_idx");
      expect(plan).not.toMatch(/Seq Scan.*sessions/);

      const results = await repository.findActiveByUserId(userId);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(session.id);
    });

    it("sessions_expires_at_idx is used for expiry sweep queries", async () => {
      const userId = await setupUser();
      const now = new Date();
      const expiredSession = Session.reconstitute({
        id: createId<"SessionId">(),
        userId,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        lastSeenAt: new Date(now.getTime() - 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 30 * 60 * 1000),
        ipAddress: undefined,
        userAgent: undefined,
        revokedAt: undefined,
      });

      createdSessionIds.push(expiredSession.id);
      await new PrismaSessionRepository(prisma).save(expiredSession);

      const explainResult = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN (FORMAT JSON, ANALYZE)
         SELECT * FROM sessions
         WHERE expires_at < now()`,
      );

      const plan = JSON.stringify(explainResult);

      expect(plan).toContain("sessions_expires_at_idx");
      expect(plan).not.toMatch(/Seq Scan.*sessions/);
    });
  });
});
