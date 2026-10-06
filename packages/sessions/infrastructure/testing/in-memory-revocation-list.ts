import type { RevocationList } from "../../application/ports/revocation-list.js";
import type { SessionId } from "../../domain/entities/session.js";

/**
 * An in-memory {@link RevocationList} for unit-testing anything that revokes
 * or checks sessions, without a Redis. Satisfies the exact same port
 * `RedisRevocationList` does — see `InMemorySessionRepository` for the same
 * reasoning applied to persistence.
 *
 * Checks `until` against an injectable clock on every `isRevoked` call
 * rather than relying on a TTL store to self-expire, and lazily evicts past
 * entries — mirroring how Redis drops a key once its `PX` elapses. The clock
 * defaults to the real one; tests that need to cross an expiry boundary
 * without sleeping can supply their own.
 */
export class InMemoryRevocationList implements RevocationList {
  private readonly revokedUntilBySessionId = new Map<SessionId, Date>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  revoke(sessionId: SessionId, until: Date): Promise<void> {
    this.revokedUntilBySessionId.set(sessionId, until);
    return Promise.resolve();
  }

  isRevoked(sessionId: SessionId): Promise<boolean> {
    const until = this.revokedUntilBySessionId.get(sessionId);
    if (until === undefined) {
      return Promise.resolve(false);
    }
    if (until.getTime() <= this.now()) {
      this.revokedUntilBySessionId.delete(sessionId);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}
