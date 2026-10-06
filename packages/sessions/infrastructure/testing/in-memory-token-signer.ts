import { Result, ValidationError } from "@verixa/shared-kernel";

import type { AccessTokenPayload, TokenSigner } from "../../application/ports/token-signer.js";

/**
 * A `TokenSigner` that keeps every issued payload in memory instead of
 * encoding a real JWT, satisfying the exact same port `JwtTokenSigner` does.
 * Exists so `IssueSession`, `Logout`, and `RefreshAccessToken` never need a
 * real signing key in their unit tests.
 *
 * `sign` returns an opaque token string that is only ever meaningful to this
 * same instance's `verify` — unlike `JwtTokenSigner`, it carries no claims
 * of its own, so a token from one `InMemoryTokenSigner` cannot be verified
 * by another.
 */
export class InMemoryTokenSigner implements TokenSigner {
  private readonly issuedByToken = new Map<
    string,
    { payload: AccessTokenPayload; expiresAt: number }
  >();
  private counter = 0;

  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string> {
    const token = `fake-token-${(this.counter += 1)}`;
    this.issuedByToken.set(token, { payload, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve(token);
  }

  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>> {
    const issued = this.issuedByToken.get(token);
    if (issued === undefined) {
      return Promise.resolve(Result.err(new ValidationError("Unknown access token.")));
    }
    if (Date.now() >= issued.expiresAt) {
      return Promise.resolve(Result.err(new ValidationError("Access token has expired.")));
    }
    return Promise.resolve(Result.ok(issued.payload));
  }
}
