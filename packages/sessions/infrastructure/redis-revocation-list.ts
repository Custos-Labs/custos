import type { Redis } from "ioredis";

import type { RevocationList } from "../application/ports/revocation-list.js";
import type { SessionId } from "../domain/entities/session.js";

const KEY_PREFIX = "sessions:revoked:";

/**
 * Redis-backed `RevocationList`.
 *
 * Stored as a plain key per revoked session (`sessions:revoked:<id>`) with a
 * `PEXPIRE` matching how much longer the revocation needs to matter — once
 * the key expires, the access token it was blocking would have expired
 * naturally anyway, so there is nothing left to clean up. This is exactly
 * what makes Redis the right store for this port and not, say, an extra
 * Postgres table: the TTL *is* the cleanup job, rather than something a
 * background process has to remember to run. See `RevocationList` for the
 * fuller "why Redis" reasoning.
 *
 * `EX`/`PX` treats a duration in the past as "expire immediately" rather
 * than erroring, so a caller passing an `until` that's already elapsed still
 * gets a (harmlessly immediately-expired) key rather than a thrown Redis
 * error interrupting a security-critical revoke call.
 */
export class RedisRevocationList implements RevocationList {
  constructor(private readonly client: Redis) {}

  async revoke(sessionId: SessionId, until: Date): Promise<void> {
    const ttlMs = Math.max(1, until.getTime() - Date.now());
    await this.client.set(KEY_PREFIX + sessionId, "1", "PX", ttlMs);
  }

  async isRevoked(sessionId: SessionId): Promise<boolean> {
    const value = await this.client.get(KEY_PREFIX + sessionId);
    return value !== null;
  }
}
