import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { SessionRepository } from "../../../application/ports/session-repository.js";
import { RefreshToken } from "../../../domain/entities/refresh-token.js";
import { Session, type SessionUserId } from "../../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../../domain/value-objects/session-expiry-policy.js";

function makeUserId(): SessionUserId {
  return createId<"UserId">();
}

function makeSession(userId: SessionUserId, now = new Date()): Session {
  return Session.open({ userId, policy: SessionExpiryPolicy.default(), now });
}

/**
 * Behavioral contract every `SessionRepository` implementation must satisfy —
 * run against `InMemorySessionRepository` and, when a database is available,
 * `PrismaSessionRepository`, via the same test bodies. This is **contract
 * testing**: one shared suite, multiple implementations, each proven to
 * behave identically rather than merely "compile against the same
 * interface." See `docs/guides/testing.md`.
 */
export function sessionRepositoryContract(createRepository: () => SessionRepository): void {
  describe("SessionRepository contract", () => {
    it("returns undefined for a session that was never saved", async () => {
      const repository = createRepository();
      const session = makeSession(makeUserId());

      const found = await repository.findById(session.id);

      expect(found).toBeUndefined();
    });

    it("finds a saved session by id", async () => {
      const repository = createRepository();
      const session = makeSession(makeUserId());

      await repository.save(session);

      const found = await repository.findById(session.id);

      // Asserts equality of state, not object identity: a real adapter
      // reconstructs the instance from storage, never returning the exact
      // object instance it was given.
      expect(found?.id).toBe(session.id);
      expect(found?.userId).toBe(session.userId);
      expect(found?.createdAt).toEqual(session.createdAt);
      expect(found?.lastSeenAt).toEqual(session.lastSeenAt);
      expect(found?.expiresAt).toEqual(session.expiresAt);
      expect(found?.ipAddress).toBe(session.ipAddress);
      expect(found?.userAgent).toBe(session.userAgent);
      expect(found?.revokedAt).toEqual(session.revokedAt);
      expect(found?.isRevoked).toBe(session.isRevoked);
    });

    it("save is an idempotent upsert", async () => {
      const repository = createRepository();
      const session = makeSession(makeUserId());

      await repository.save(session);

      const touched = session.touch(new Date(session.lastSeenAt.getTime() + 1000));
      await repository.save(touched);

      const found = await repository.findById(session.id);

      expect(found?.lastSeenAt).toEqual(touched.lastSeenAt);
    });

    it("returns empty array when a user has no active sessions", async () => {
      const repository = createRepository();

      const active = await repository.findActiveByUserId(makeUserId());

      expect(active).toEqual([]);
    });

    it("finds active sessions for a user", async () => {
      const repository = createRepository();
      const userId = makeUserId();
      const session1 = makeSession(userId);
      const session2 = makeSession(userId);

      await repository.save(session1);
      await repository.save(session2);

      const active = await repository.findActiveByUserId(userId);

      expect(active).toHaveLength(2);
      expect(active.map((s) => s.id)).toContain(session1.id);
      expect(active.map((s) => s.id)).toContain(session2.id);
    });

    it("excludes revoked sessions from findActiveByUserId", async () => {
      const repository = createRepository();
      const userId = makeUserId();
      const session1 = makeSession(userId);
      const session2 = makeSession(userId);

      await repository.save(session1.revoke());
      await repository.save(session2);

      const active = await repository.findActiveByUserId(userId);

      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(session2.id);
    });

    it("orders findActiveByUserId results by lastSeenAt ascending (oldest first)", async () => {
      const repository = createRepository();
      const userId = makeUserId();
      const now = new Date();

      const session1 = makeSession(userId, new Date(now.getTime() - 3000));
      const session2 = makeSession(userId, new Date(now.getTime() - 2000));
      const session3 = makeSession(userId, new Date(now.getTime() - 1000));

      await repository.save(session1);
      await repository.save(session2);
      await repository.save(session3);

      const active = await repository.findActiveByUserId(userId);

      expect(active[0]?.id).toBe(session1.id);
      expect(active[1]?.id).toBe(session2.id);
      expect(active[2]?.id).toBe(session3.id);
    });

    it("revokeAllForUser marks all sessions for that user as revoked", async () => {
      const repository = createRepository();
      const userId = makeUserId();
      const session1 = makeSession(userId);
      const session2 = makeSession(userId);

      await repository.save(session1);
      await repository.save(session2);

      await repository.revokeAllForUser(userId);

      const found1 = await repository.findById(session1.id);
      const found2 = await repository.findById(session2.id);

      expect(found1?.isRevoked).toBe(true);
      expect(found2?.isRevoked).toBe(true);
    });

    it("revokeAllForUser does not affect other users' sessions", async () => {
      const repository = createRepository();
      const user1Id = makeUserId();
      const user2Id = makeUserId();
      const user1Session = makeSession(user1Id);
      const user2Session = makeSession(user2Id);

      await repository.save(user1Session);
      await repository.save(user2Session);

      await repository.revokeAllForUser(user1Id);

      const user1Found = await repository.findById(user1Session.id);
      const user2Found = await repository.findById(user2Session.id);

      expect(user1Found?.isRevoked).toBe(true);
      expect(user2Found?.isRevoked).toBe(false);
    });

    it("revokeAllForUser for a user with no sessions is a silent no-op", async () => {
      const repository = createRepository();

      await expect(repository.revokeAllForUser(makeUserId())).resolves.toBeUndefined();
    });

    it("after revokeAllForUser, findActiveByUserId returns an empty array", async () => {
      const repository = createRepository();
      const userId = makeUserId();
      const session1 = makeSession(userId);
      const session2 = makeSession(userId);

      await repository.save(session1);
      await repository.save(session2);

      await repository.revokeAllForUser(userId);

      const active = await repository.findActiveByUserId(userId);

      expect(active).toEqual([]);
    });

    it("finds a saved refresh token by its hash", async () => {
      const repository = createRepository();
      const session = makeSession(makeUserId());
      await repository.save(session);

      const { refreshToken, token } = RefreshToken.issue({
        sessionId: session.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await repository.saveRefreshToken(refreshToken);

      const found = await repository.findRefreshTokenByHash(RefreshToken.hashToken(token));

      expect(found?.id).toBe(refreshToken.id);
      expect(found?.sessionId).toBe(session.id);
      expect(found?.tokenHash).toBe(refreshToken.tokenHash);
    });

    it("returns undefined for a refresh token hash that was never saved", async () => {
      const repository = createRepository();

      const found = await repository.findRefreshTokenByHash("not-a-real-hash");

      expect(found).toBeUndefined();
    });

    it("saveRefreshToken is an idempotent upsert", async () => {
      const repository = createRepository();
      const session = makeSession(makeUserId());
      await repository.save(session);

      const { refreshToken, token } = RefreshToken.issue({
        sessionId: session.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await repository.saveRefreshToken(refreshToken);

      const used = refreshToken.markUsed();
      await repository.saveRefreshToken(used);

      const found = await repository.findRefreshTokenByHash(RefreshToken.hashToken(token));

      expect(found?.isUsed).toBe(true);
    });
  });
}
