import type { Result, ValidationError } from "@verixa/shared-kernel";

/** The claims an access token carries. Deliberately minimal — see `JwtTokenSigner`. */
export interface AccessTokenPayload {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Signs and verifies access tokens. A **port**: the application layer knows
 * it needs *a* signer, not that it is backed by a JWT — see
 * `docs/guides/domain-modeling.md`.
 *
 * `verify` is not called by any use case in this package yet (Issue 095's
 * dependency chain has no route layer to guard); it exists now, alongside a
 * real adapter and its own tests, because Phase 12's route guard is the
 * consumer and should not have to invent the interface it needs — the same
 * "domain skeleton ahead of its delivery mechanism" pattern as
 * `packages/identity`'s `Invitation`.
 */
export interface TokenSigner {
  /** Signs `payload`, expiring `ttlSeconds` after signing. */
  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string>;
  /**
   * Verifies `token`'s signature and expiry, returning its payload.
   * Returns a `ValidationError` (never throws) for a malformed, expired, or
   * badly-signed token — an invalid token presented by a client is an
   * expected outcome, not a bug.
   */
  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>>;
import type { SessionUserId } from "../../domain/entities/session.js";

/** An access token as produced by a `TokenSigner`. */
export interface IssuedAccessToken {
  /** The signed, encoded token (a JWT, for the real adapter) a client presents on subsequent requests. */
  readonly token: string;
  /** Unique per issuance (a JWT `jti`) — what a `RevocationList` denylists. Never reused across tokens. */
  readonly tokenId: string;
  readonly expiresAt: Date;
}

/**
 * Signs access tokens on behalf of a user.
 *
 * Kept to exactly the one operation these use cases need. Verifying a
 * presented token is a separate concern (an HTTP-layer authentication guard,
 * outside Phase 05's session-lifecycle scope) and does not belong on this
 * port just because the same JWT library would implement both.
 *
 * Takes `userId` alone, not `sessionId`: the access token this issues is a
 * self-contained, stateless JWT, and binding it to a session id it could not
 * yet have (issuance signs the token *before* the session exists — see
 * `IssueSession`) would need either a two-step issue-then-patch dance or a
 * pre-allocated id threaded in for no behavioural benefit. "Log out this
 * specific device" is enforced at the refresh-token/session level instead
 * (`Logout`, `LogoutEverywhere`), which is where the codebase's session
 * revocation already lives.
 */
export interface TokenSigner {
  issueAccessToken(params: { userId: SessionUserId; now: Date }): Promise<IssuedAccessToken>;
}
