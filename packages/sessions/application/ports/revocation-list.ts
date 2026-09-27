import type { SessionId } from "../../domain/value-objects/session-id.js";

/**
 * A short-lived deny-list of revoked sessions, consulted on every access-token
 * verification.
 *
 * ## The problem this exists to solve
 *
 * Access tokens are stateless (see {@link
 * import("./token-signer.js").TokenSigner}): they verify without a store
 * lookup, which is what makes them cheap. The flip side is the textbook
 * stateless-JWT question — *how do you revoke something you never stored?* You
 * can delete the session row, but the access token already in an attacker's
 * hands keeps verifying until its `exp`, because verification never looks at
 * that row.
 *
 * The answer here is not "make access tokens stateful" (that throws away the
 * reason they exist). It is a **deny-list**: a small set of session ids whose
 * still-unexpired access tokens must be refused. On revocation, the session id
 * goes on the list; on every verification, the list is checked; and each entry
 * is set to expire at the same time the last access token for that session
 * would have anyway. Once no live token could reference a session, its entry is
 * pointless and evicts itself — so the list's size is bounded by the
 * access-token TTL, not by how many sessions have ever been revoked.
 *
 * ## Why the caller passes the TTL
 *
 * `revoke` takes the remaining lifetime rather than computing it, because only
 * the caller knows the access-token TTL in force when the token being revoked
 * was issued. An entry that expires too *early* re-opens the revocation window;
 * one that expires too *late* just wastes a little memory. When in doubt, round
 * up — correctness sits on the generous side.
 *
 * ## Availability tradeoff (fail-closed)
 *
 * An adapter backed by an external store (Redis, Issue 088) has to decide what
 * `isRevoked` does when that store is unreachable. This port does not dictate
 * the answer, but it does constrain how it is expressed: `isRevoked` returns a
 * plain boolean, so an adapter that chooses to **fail closed** — treat "cannot
 * check" as "assume revoked" — reports `true` rather than throwing. That trades
 * availability for safety, and the choice is documented at the adapter. See
 * `docs/security/token-design.md`.
 */
export interface RevocationList {
  /**
   * Marks `sessionId` revoked for at least `ttlSeconds`. Idempotent: revoking
   * an already-revoked session is fine and simply refreshes the entry. A
   * `ttlSeconds` of zero or less is a no-op — there is no live token left to
   * deny, so nothing needs to go on the list.
   */
  revoke(sessionId: SessionId, ttlSeconds: number): Promise<void>;

  /** Whether `sessionId` is currently on the deny-list. */
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
