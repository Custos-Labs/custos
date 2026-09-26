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
}
