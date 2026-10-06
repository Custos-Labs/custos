import type { Redis } from "ioredis";

import type { RevocationList } from "../application/ports/revocation-list.js";
import type { SessionId } from "../domain/entities/session.js";

export interface RedisRevocationListOptions {
  /**
   * Namespace prepended to every session id before it becomes a Redis key.
   * Keeps the deny-list from colliding with anything else sharing the same
   * Redis, and makes `SCAN revoked:session:*` a meaningful operational query.
   */
  readonly keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = "sessions:revoked:";

/**
 * A Redis-backed {@link RevocationList}.
 *
 * Stored as a plain key per revoked session, with a `PX` expiry matching how
 * much longer the revocation needs to matter — once the key expires, the
 * access token it was blocking would have expired naturally anyway, so there
 * is nothing left to clean up. This is exactly what makes Redis the right
 * store for this port and not, say, an extra Postgres table: the TTL *is*
 * the cleanup job, rather than something a background process has to
 * remember to run. See `RevocationList` for the fuller "why Redis" reasoning.
 *
 * `PX` treats a duration in the past as "expire immediately" rather than
 * erroring, so a caller passing an `until` that's already elapsed still
 * gets a (harmlessly immediately-expired) key rather than a thrown Redis
 * error interrupting a security-critical revoke call.
 *
 * ## Fail-closed, and why
 *
 * The interesting decision is what {@link isRevoked} does when Redis is
 * unreachable. Two choices:
 *
 * - **Fail open** — "can't check, assume not revoked" — keeps logins working
 *   during a Redis outage, at the cost of honoring tokens that may have been
 *   revoked. A revoked (possibly stolen) session silently regains access for
 *   the duration of the outage.
 * - **Fail closed** — "can't check, assume revoked" — refuses those tokens,
 *   at the cost of turning a Redis outage into an auth outage.
 *
 * This adapter **fails closed**. The deny-list exists specifically to shut
 * down sessions believed compromised; an implementation that quietly stops
 * enforcing it the moment its datastore hiccups defeats the reason it was
 * built. An auth outage is loud, bounded, and pages someone; a
 * revocation-bypass window is silent and is exactly the state an attacker
 * with a revoked token is waiting for. Availability is recoverable; a
 * re-admitted stolen session may not be. See `docs/security/token-design.md`.
 *
 * {@link revoke}, by contrast, lets errors propagate. A revocation that
 * failed to persist has not happened, and the caller (a logout, a reset)
 * needs to know that and retry or surface it — swallowing it would report
 * success for a session that is still live.
 */
export class RedisRevocationList implements RevocationList {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: Redis,
    options: RedisRevocationListOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async revoke(sessionId: SessionId, until: Date): Promise<void> {
    const ttlMs = Math.max(1, until.getTime() - Date.now());
    await this.client.set(this.keyFor(sessionId), "1", "PX", ttlMs);
  }

  async isRevoked(sessionId: SessionId): Promise<boolean> {
    try {
      const value = await this.client.get(this.keyFor(sessionId));
      return value !== null;
    } catch {
      // Fail closed. See the class comment: a session we cannot confirm is
      // safe is treated as revoked, not waved through.
      return true;
    }
  }

  private keyFor(sessionId: SessionId): string {
    return `${this.keyPrefix}${sessionId}`;
  }
}
