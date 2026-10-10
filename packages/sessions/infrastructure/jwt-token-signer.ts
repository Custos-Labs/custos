import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

import { Result, ValidationError } from "@verixa/shared-kernel";

import type { AccessTokenPayload, TokenSigner } from "../application/ports/token-signer.js";
import type { SigningKeyProvider } from "./signing-key-provider.js";

/**
 * JWT access token signer using RS256 (RSA asymmetric signing) — the design
 * `docs/security/token-design.md` specifies.
 *
 * Claims are the doc's registered names (`sub`, `sid`, `iat`, `exp`) with the
 * signing key's `kid` in the JWS header; the port's domain-level payload
 * (`sessionId`, `userId`) is mapped here so the token format can change
 * without the use cases changing. Verification reads the `kid` from the
 * header *before* verifying and asks the provider for exactly that key, so
 * rotation is zero-downtime: retired keys keep verifying until their last
 * token expires. The accepted-algorithm list is pinned to the provider's
 * `algorithms()`, closing algorithm-substitution (`alg: none`, RS256→HS256).
 *
 * `verify` never throws: malformed, expired, badly-signed, and unknown-`kid`
 * tokens all come back as a `ValidationError`, per the port contract.
 */
export class JwtTokenSigner implements TokenSigner {
  constructor(private readonly keyProvider: SigningKeyProvider) {}

  async sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string> {
    const active = this.keyProvider.signingKey();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: payload.userId, sid: payload.sessionId })
      .setProtectedHeader({ alg: active.algorithm, typ: "JWT", kid: active.kid })
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(active.privateKey);
  }

  async verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>> {
    const invalid = (reason: string) =>
      Result.err(new ValidationError(`Invalid access token: ${reason}.`, { token: ["invalid"] }));

    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return invalid("malformed");
    }
    if (typeof kid !== "string" || kid === "") return invalid("malformed");
    const key = this.keyProvider.verificationKey(kid);
    if (key === undefined) return invalid("unknown signing key");

    try {
      const { payload } = await jwtVerify(token, key.publicKey, {
        algorithms: [...this.keyProvider.algorithms()],
      });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
        return invalid("malformed");
      }
      return Result.ok({ sessionId: payload.sid, userId: payload.sub });
    } catch {
      return invalid("signature or expiry check failed");
    }
  }
}
