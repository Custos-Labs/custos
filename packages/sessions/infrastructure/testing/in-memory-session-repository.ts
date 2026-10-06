import type { SessionRepository } from "../../application/ports/session-repository.js";
import type { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { Session, SessionId, SessionUserId } from "../../domain/entities/session.js";

/**
 * A `SessionRepository` backed by in-memory `Map`s, satisfying the exact same
 * port a real (Prisma-backed) adapter will. Exists so use cases and their
 * tests never need a database — see `packages/identity`'s
 * `InMemoryUserRepository` and `docs/guides/testing.md`.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessionsById = new Map<SessionId, Session>();
  private readonly refreshTokensByHash = new Map<string, RefreshToken>();

  save(session: Session): Promise<void> {
    this.sessionsById.set(session.id, session);
    return Promise.resolve();
  }

  findById(id: SessionId): Promise<Session | undefined> {
    return Promise.resolve(this.sessionsById.get(id));
  }

  /** Not revoked, sorted oldest-`lastSeenAt`-first — see the port doc on why that order matters. */
  findActiveByUserId(userId: SessionUserId): Promise<readonly Session[]> {
    const active = [...this.sessionsById.values()]
      .filter((session) => session.userId === userId && !session.isRevoked)
      .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
    return Promise.resolve(active);
  }

  revokeAllForUser(userId: SessionUserId, now: Date = new Date()): Promise<void> {
    for (const session of this.sessionsById.values()) {
      if (session.userId === userId) {
        this.sessionsById.set(session.id, session.revoke(now));
      }
    }
    return Promise.resolve();
  }

  saveRefreshToken(refreshToken: RefreshToken): Promise<void> {
    this.refreshTokensByHash.set(refreshToken.tokenHash, refreshToken);
    return Promise.resolve();
  }

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    return Promise.resolve(this.refreshTokensByHash.get(tokenHash));
  }
}
