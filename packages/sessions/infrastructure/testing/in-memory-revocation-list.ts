import type { RevocationList } from "../../application/ports/revocation-list.js";
import type { SessionId } from "../../domain/entities/session.js";

/**
 * A `RevocationList` backed by an in-memory `Map`, satisfying the exact same
 * port `RedisRevocationList` does. Exists so use cases and their tests never
 * need a Redis instance — see `InMemorySessionRepository` for the same
 * reasoning applied to persistence.
 */
export class InMemoryRevocationList implements RevocationList {
  private readonly revokedUntilBySessionId = new Map<SessionId, Date>();

  revoke(sessionId: SessionId, until: Date): Promise<void> {
    this.revokedUntilBySessionId.set(sessionId, until);
    return Promise.resolve();
  }

  isRevoked(sessionId: SessionId): Promise<boolean> {
    return Promise.resolve(this.revokedUntilBySessionId.has(sessionId));

/**
 * A `RevocationList` backed by an in-memory `Map`, satisfying the exact same
 * port a real (Redis-backed) adapter will. Exists so `Logout`,
 * `LogoutEverywhere`, and `IssueSession`'s eviction path never need Redis in
 * their unit tests.
 */
export class InMemoryRevocationList implements RevocationList {
  private readonly expiresAtByTokenId = new Map<string, Date>();

  revoke(tokenId: string, expiresAt: Date): Promise<void> {
    this.expiresAtByTokenId.set(tokenId, expiresAt);
    return Promise.resolve();
  }

  isRevoked(tokenId: string): Promise<boolean> {
    return Promise.resolve(this.expiresAtByTokenId.has(tokenId));
  }
}
