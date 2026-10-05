import type { PrismaClient } from "@verixa/database";

import type { SessionRepository } from "../../application/ports/session-repository.js";
import { RefreshToken, type RefreshTokenId } from "../../domain/entities/refresh-token.js";
import { Session, type SessionId, type SessionUserId } from "../../domain/entities/session.js";

type SessionRow = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  revokedAt: Date | null;
};

type RefreshTokenRow = {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

function sessionToDomain(row: SessionRow): Session {
  return Session.reconstitute({
    id: row.id as SessionId,
    userId: row.userId as SessionUserId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    ipAddress: row.ipAddress ?? undefined,
    userAgent: row.userAgent ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
  });
}

function sessionToRow(session: Session): SessionRow {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
    revokedAt: session.revokedAt ?? null,
  };
}

function refreshTokenToDomain(row: RefreshTokenRow): RefreshToken {
  return RefreshToken.reconstitute({
    id: row.id as RefreshTokenId,
    sessionId: row.sessionId as SessionId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
  });
}

function refreshTokenToRow(refreshToken: RefreshToken): RefreshTokenRow {
  return {
    id: refreshToken.id,
    sessionId: refreshToken.sessionId,
    tokenHash: refreshToken.tokenHash,
    createdAt: refreshToken.createdAt,
    expiresAt: refreshToken.expiresAt,
    usedAt: refreshToken.usedAt ?? null,
    revokedAt: refreshToken.revokedAt ?? null,
  };
}

/**
 * Prisma-backed `SessionRepository`, against the `sessions`/`refresh_tokens`
 * tables added in the migration alongside this file. Satisfies the same port
 * — and is intended to satisfy the same behavioral contract, once a
 * `session-repository.contract.ts` exists — as `InMemorySessionRepository`.
 *
 * Unlike `PrismaUserRepository`, this does not route writes through
 * `withMappedErrors`: every write here is keyed on an id the domain already
 * generated (`createId`), so a unique-constraint violation on `id` would
 * mean a UUID collision, and a violation on `tokenHash` would mean two
 * cryptographically independent 256-bit values collided — astronomically
 * improbable events with no use case that has an opinion on handling them,
 * which is exactly the class of failure `error-mapper.ts`'s own doc comment
 * says to let propagate untouched rather than dress up as an expected
 * domain error.
 *
 * Excluded from `packages/sessions`' coverage gate (see `vitest.config.ts`)
 * for the same reason `PrismaUserRepository` is excluded from identity's:
 * it needs a real Postgres to exercise meaningfully, which is what the
 * (skipped-without-a-database) contract suite is for, not a unit test with a
 * fake.
 */
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(session: Session): Promise<void> {
    const row = sessionToRow(session);
    const { id, ...withoutId } = row;
    await this.prisma.session.upsert({ where: { id }, create: row, update: withoutId });
  }

  async findById(id: SessionId): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    return row === null ? undefined : sessionToDomain(row);
  }

  async findActiveByUserId(userId: SessionUserId): Promise<readonly Session[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
    });
    return rows.map(sessionToDomain);
  }

  async revokeAllForUser(userId: SessionUserId, now: Date = new Date()): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async saveRefreshToken(refreshToken: RefreshToken): Promise<void> {
    const row = refreshTokenToRow(refreshToken);
    const { id, ...withoutId } = row;
    await this.prisma.refreshToken.upsert({ where: { id }, create: row, update: withoutId });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row === null ? undefined : refreshTokenToDomain(row);
import type { Session, SessionId, UserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";

import { withMappedErrors } from "./error-mapper.js";
import { SessionMapper } from "./session-mapper.js";

/**
 * Prisma-backed `SessionRepository`. Satisfies exactly the same port — and the
 * same behavioral contract (`session-repository.contract.ts`) — as
 * `InMemorySessionRepository`, which is what makes them substitutable rather
 * than merely similar.
 *
 * Takes a `PrismaClient` rather than constructing one. That's what lets a
 * caller hand it a transaction client instead (`prisma.$transaction(tx =>
 * ...)`), which later issues depend on for multi-aggregate atomicity — a
 * repository that owned its own connection could never participate in
 * someone else's transaction.
 *
 * ### Expiry policy
 *
 * Sessions are stored with the result of their expiry policy applied
 * (`expiresAt`, the timestamp), but the policy itself is a runtime
 * configuration supplied by the use case or caller. This repository does not
 * store policies — it only looks at the fields they produce. When a session is
 * loaded and needs to be touched (to extend the expiry, if using a sliding
 * policy), the caller supplies the policy to `toDomain()` or to `touch()`.
 */
export class PrismaSessionRepository implements SessionRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultExpiryPolicy: SessionExpiryPolicy,
  ) {}

  async save(session: Session): Promise<void> {
    const row = SessionMapper.toRow(session);

    await withMappedErrors("Session", () =>
      this.prisma.session.upsert({
        where: { id: row.id },
        create: row,
        update: row,
      }),
    );
  }

  async findById(sessionId: SessionId): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    return row === null ? undefined : SessionMapper.toDomain(row, this.defaultExpiryPolicy);
  }

  async findActiveByUserId(userId: UserId): Promise<Session[]> {
    const now = new Date();

    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        status: "active",
        expiresAt: {
          gt: now,
        },
      },
    });

    return rows.map((row) => SessionMapper.toDomain(row, this.defaultExpiryPolicy));
  }

  async revoke(sessionId: SessionId): Promise<void> {
    // Idempotent: only revoke if not already revoked. Load the session first
    // to preserve its original revokedAt if it's already revoked.
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (existing && existing.status !== "revoked") {
      await withMappedErrors("Session", () =>
        this.prisma.session.update({
          where: { id: sessionId },
          data: {
            status: "revoked",
            revokedAt: new Date(),
          },
        }),
      );
    }
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    await withMappedErrors("Session", () =>
      this.prisma.session.updateMany({
        where: {
          userId,
          status: "active", // Only revoke non-revoked sessions (idempotent)
        },
        data: {
          status: "revoked",
          revokedAt: new Date(),
        },
      }),
    );
  }
}
