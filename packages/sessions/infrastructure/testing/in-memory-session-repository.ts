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
import type { Session, SessionId, SessionUserId } from "../../domain/entities/session.js";

/**
 * A `SessionRepository` backed by an in-memory `Map`, satisfying the exact
 * same port a real (Prisma-backed) adapter will. Exists so use cases and
 * their tests never need a database — see `InMemoryUserRepository` in
 * `@verixa/identity` for the identical pattern.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessionsById = new Map<SessionId, Session>();

  findById(id: SessionId): Promise<Session | undefined> {
    return Promise.resolve(this.sessionsById.get(id));
  }

  findActiveByUserId(userId: SessionUserId): Promise<readonly Session[]> {
    return Promise.resolve(
      [...this.sessionsById.values()].filter(
        (session) => session.userId === userId && !session.isRevoked,
      ),
    );
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
  /**
   * Active means neither revoked nor expired as of `now`, sorted
   * oldest-`lastActiveAt`-first — the ordering `IssueSession`'s
   * concurrent-session-limit eviction depends on. See the port doc.
   */
  findActiveByUserId(userId: SessionUserId, now: Date): Promise<readonly Session[]> {
    const active = [...this.sessionsById.values()]
      .filter((session) => session.userId === userId && session.isActiveAt(now))
      .sort((a, b) => a.lastActiveAt.getTime() - b.lastActiveAt.getTime());
    return Promise.resolve(active);
  }

  save(session: Session): Promise<void> {
    this.sessionsById.set(session.id, session);
    return Promise.resolve();
  }
}
