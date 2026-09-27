import { Result } from "@verixa/shared-kernel";
import { errors, type JWTPayload, jwtVerify, SignJWT } from "jose";

import type {
  AccessTokenInput,
  TokenSigner,
  VerifiedAccessToken,
} from "../application/ports/token-signer.js";
import { TokenVerificationError } from "../domain/errors/token-verification-error.js";
import { asSessionId } from "../domain/value-objects/session-id.js";

import type { SigningKeyProvider } from "./signing-key-provider.js";

export interface JwtTokenSignerOptions {
  /**
   * How long a minted access token stays valid, in seconds.
   *
   * Short on purpose — minutes, not days. A stateless access token cannot be
   * un-issued (that is what the deny-list in Issue 088 is for, and even that is
   * bounded by this number), so its lifetime *is* the worst-case window a
   * leaked one keeps working. Long refresh tokens (Issue 086) restore the
   * seamless-session experience without widening that window.
   */
  readonly accessTokenTtlSeconds: number;
  /** Optional `iss` claim, set on signing and required on verification when present. */
  readonly issuer?: string;
  /** Optional `aud` claim, set on signing and required on verification when present. */
  readonly audience?: string;
  /**
   * Clock used to stamp `iat`/`exp`, injectable so tests can mint a token that
   * is already expired without waiting for wall-clock time to pass. Verification
   * always uses the real current time (jose's default), which is the point: a
   * token stamped in the past by this clock is genuinely expired to a verifier.
   */
  readonly now?: () => Date;
}

/**
 * A {@link TokenSigner} that mints and verifies RFC 7519 JWTs, delegating all
 * key selection to a {@link SigningKeyProvider}.
 *
 * The division of labor is deliberate: this class knows the *token format*
 * (which claims, how they map, what the header looks like) and the provider
 * knows the *keys* (which is current, which are retired, which `kid` resolves to
 * what). That is why rotation needs no change here — swap the provider's current
 * key and this signer starts stamping the new `kid` and keeps verifying the old
 * one, with not a line of format code touched.
 */
export class JwtTokenSigner implements TokenSigner {
  private readonly now: () => Date;

  constructor(
    private readonly keyProvider: SigningKeyProvider,
    private readonly options: JwtTokenSignerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async sign(input: AccessTokenInput): Promise<string> {
    const key = this.keyProvider.signingKey();
    const issuedAtSeconds = Math.floor(this.now().getTime() / 1000);

    const payload: JWTPayload = { sid: input.sessionId };
    if (input.organizationId !== undefined) {
      payload["orgId"] = input.organizationId;
    }
    if (input.roles !== undefined && input.roles.length > 0) {
      payload["roles"] = [...input.roles];
    }

    const builder = new SignJWT(payload)
      // The `kid` is what makes rotation work — it is read back on verification
      // to pick this exact key out of the provider's set.
      .setProtectedHeader({ alg: key.algorithm, kid: key.kid })
      .setSubject(input.subject)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + this.options.accessTokenTtlSeconds);

    if (this.options.issuer !== undefined) {
      builder.setIssuer(this.options.issuer);
    }
    if (this.options.audience !== undefined) {
      builder.setAudience(this.options.audience);
    }

    return builder.sign(key.privateKey);
  }

  async verify(token: string): Promise<Result<VerifiedAccessToken, TokenVerificationError>> {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          const kid = header.kid;
          if (kid === undefined) {
            // A token with no `kid` cannot be routed to a key. We only ever mint
            // tokens with one, so this is a foreign or forged token.
            throw TokenVerificationError.unknownKey("(none)");
          }
          const verificationKey = this.keyProvider.verificationKey(kid);
          if (verificationKey === undefined) {
            // The rotation boundary: a `kid` the provider no longer holds — a
            // key removed after its last token expired, or one that never
            // existed here. Retired-but-held keys never reach this branch.
            throw TokenVerificationError.unknownKey(kid);
          }
          return verificationKey.publicKey;
        },
        {
          algorithms: [...this.keyProvider.algorithms()],
          ...(this.options.issuer !== undefined ? { issuer: this.options.issuer } : {}),
          ...(this.options.audience !== undefined ? { audience: this.options.audience } : {}),
        },
      );

      return this.toVerifiedToken(payload, protectedHeader.kid);
    } catch (error) {
      return Result.err(toVerificationError(error));
    }
  }

  private toVerifiedToken(
    payload: JWTPayload,
    keyId: string | undefined,
  ): Result<VerifiedAccessToken, TokenVerificationError> {
    const sid = payload.sid;
    if (payload.sub === undefined || typeof sid !== "string" || keyId === undefined) {
      // Correctly signed by a trusted key, but missing claims every token this
      // system issues carries. That means it was minted by something else that
      // happens to share our keys, or by an older format — either way it is not
      // a valid access token, and treating it as well-formed would let a
      // stripped-down token through.
      return Result.err(
        TokenVerificationError.malformed("Access token is missing required claims."),
      );
    }

    const roles = Array.isArray(payload["roles"])
      ? payload["roles"].filter((role): role is string => typeof role === "string")
      : [];

    const verified: VerifiedAccessToken = {
      subject: payload.sub,
      sessionId: asSessionId(sid),
      roles,
      keyId,
      issuedAt: new Date((payload.iat ?? 0) * 1000),
      expiresAt: new Date((payload.exp ?? 0) * 1000),
      ...(typeof payload["orgId"] === "string" ? { organizationId: payload["orgId"] } : {}),
    };
    return Result.ok(verified);
  }
}

/** Maps jose's thrown errors (and our own) onto the domain's rejection reasons. */
function toVerificationError(error: unknown): TokenVerificationError {
  if (error instanceof TokenVerificationError) {
    // Thrown from the key resolver (unknown/absent kid) — already precise.
    return error;
  }
  if (error instanceof errors.JWTExpired) {
    return TokenVerificationError.expired();
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return TokenVerificationError.invalidSignature();
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    // Wrong issuer or audience: a real, correctly-signed token, but not one
    // meant for us. Refused, and deliberately not distinguished on the wire.
    return TokenVerificationError.invalidSignature("Access token claims are not accepted here.");
  }
  if (error instanceof errors.JOSEError) {
    // Undecodable header, wrong segment count, unsupported alg, etc. — it never
    // got far enough to be about a key.
    return TokenVerificationError.malformed();
  }
  // Not a jose error at all. Fail closed on the safe side: reject rather than
  // risk treating an unexpected failure as a valid token.
  return TokenVerificationError.malformed("Access token could not be verified.", { cause: error });
}
﻿export class JwtTokenSigner {}
