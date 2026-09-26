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
  }
}
