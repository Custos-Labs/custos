/**
 * Supplies the HMAC secret `JwtTokenSigner` signs and verifies access tokens
 * with.
 *
 * A separate class rather than passing the raw string straight to
 * `JwtTokenSigner` for one reason: it is the seam Phase 11's key rotation
 * lands on. Rotating a signing key safely means accepting the *old* key for
 * verification while only ever signing with the new one, until every
 * outstanding access token issued under the old key has expired — a change
 * to this class's internals, not to `JwtTokenSigner` or anything that calls
 * it. Today there is exactly one key, so `currentSecret` and
 * `isKnownSecret` agree; the two methods already exist because the call
 * sites that will need them to disagree already exist as this comment.
 */
export class SigningKeyProvider {
  private readonly secret: string;

  constructor(params: { secret: string }) {
    if (params.secret.trim() === "") {
      throw new Error("SigningKeyProvider requires a non-empty secret.");
    }
    this.secret = params.secret;
  }

  /** The secret new tokens are signed with. */
  currentSecret(): string {
    return this.secret;
  }

  /** Whether `secret` is one this provider accepts for verifying an already-issued token. */
  isKnownSecret(secret: string): boolean {
    return secret === this.secret;
  }
}
