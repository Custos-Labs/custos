import type { SessionId } from "../../domain/entities/session.js";

/**
 * A deny-list of revoked sessions, checked on every request that presents an
 * access token.
 *
 * Access tokens are stateless JWTs (`JwtTokenSigner`) — signature and expiry
 * are enough to validate them without a database round trip, which is the
 * whole reason to use them. But that same statelessness means revoking one
 * (logout, "logout everywhere", a detected refresh-token reuse) can't be done
 * by deleting a row: the token is still cryptographically valid until it
 * expires on its own. `RevocationList` is the side channel that closes that
 * gap — a revoked session's id is recorded here, with a TTL no longer than
 * the access token's own lifetime, and checked alongside signature
 * verification. See `docs/security/threat-model-sessions.md`.
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
/**
 * The deny-list for access tokens that must stop working before they would
 * naturally expire.
 *
 * Access tokens are stateless JWTs, verified without a database round trip
 * — that is the entire point of using them. But "stateless" and "instantly
 * revocable" are in tension: a JWT that is valid until its `exp` claim keeps
 * working everywhere it is presented, including after `Logout`, unless
 * *something* stateful can say "no, not this one." This is that something.
 *
 * Deliberately not the `SessionRepository`. A session revocation is a
 * refresh-token-level fact ("no further refresh will succeed") and an access
 * token can remain independently valid for minutes after it, since it is
 * verified without consulting the session at all. Denylisting the specific
 * `tokenId` is what closes that window; see `Logout`.
 */
export interface RevocationList {
  /**
   * Denylists `tokenId` until `expiresAt`. The expiry is supplied by the
   * caller (it is the access token's own `exp`) so an adapter backed by a
   * TTL store (Redis, most likely) can set the entry to expire at the same
   * moment the token would have anyway — there is no reason to retain a
   * denylist entry for a token that can no longer be presented regardless.
   */
  revoke(tokenId: string, expiresAt: Date): Promise<void>;

  /** Whether `tokenId` has been revoked and has not yet passed the expiry it was revoked with. */
  isRevoked(tokenId: string): Promise<boolean>;
}
