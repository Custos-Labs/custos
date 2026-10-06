import type { SessionId } from "../../domain/entities/session.js";

/**
 * A deny-list of revoked sessions, checked on every request that presents an
 * access token.
 *
 * Access tokens are stateless JWTs (`JwtTokenSigner`) — signature and expiry
 * are enough to validate them without a database round trip, which is the
 * whole reason to use them. But that same statelessness means revoking one
 * (logout, "logout everywhere", a detected refresh-token reuse, or an
 * eviction past the concurrent-session limit) can't be done by deleting a
 * row: the token is still cryptographically valid until it expires on its
 * own. `RevocationList` is the side channel that closes that gap — a
 * revoked session's id is recorded here, with a TTL no longer than the
 * access token's own lifetime, and checked alongside signature
 * verification. See `docs/security/threat-model-sessions.md`.
 *
 * Keyed by `sessionId`, not by a per-token id: the access token payload
 * (`AccessTokenPayload`) already carries `sessionId`, so a session-level
 * revocation closes every access token that session ever issued without
 * `Session` needing to track which one is current.
 *
 * Redis-backed in production (`RedisRevocationList`) because the check sits
 * on every authenticated request's hot path and a TTL is exactly what Redis
 * keys already do — no cleanup job needed, an entry simply expires once the
 * access token it was blocking would have expired anyway.
 */
export interface RevocationList {
  /** Marks `sessionId` revoked until `until` (normally the access token's own expiry). */
  revoke(sessionId: SessionId, until: Date): Promise<void>;
  /** Whether `sessionId` is currently revoked. */
  isRevoked(sessionId: SessionId): Promise<boolean>;
}
