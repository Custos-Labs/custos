import { createHmac, timingSafeEqual } from "node:crypto";

import { Result, ValidationError } from "@verixa/shared-kernel";

import type { AccessTokenPayload, TokenSigner } from "../application/ports/token-signer.js";

import type { SigningKeyProvider } from "./signing-key-provider.js";

const HEADER = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

interface AccessTokenClaims extends AccessTokenPayload {
  readonly iat: number;
  readonly exp: number;
}

function isAccessTokenClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    typeof claims["sessionId"] === "string" &&
    typeof claims["userId"] === "string" &&
    typeof claims["exp"] === "number"
  );
}

/**
 * Signs and verifies access tokens as HS256 JWTs, hand-rolled against
 * `node:crypto` rather than a JWT library.
 *
 * The format (three base64url segments — header, payload, HMAC signature)
 * is exactly what any JWT library produces; there is no compatibility gap.
 * Rolling it here trades a well-trodden dependency for zero new supply chain
 * surface on a security-critical path, and the entire implementation is
 * short enough to read start to finish in the time it takes to audit
 * whether a third-party library's defaults match what this file assumes
 * anyway (no `alg: none`, no algorithm confusion between HMAC and RSA — both
 * moot here because only one algorithm is ever implemented).
 *
 * Deliberately minimal claims: `sessionId` and `userId`, nothing else. There
 * is no `role` or permission claim to keep in sync with the database and
 * potentially go stale between issuance and use — authorization decisions
 * re-check current state via `sessionId`/`userId` rather than trusting a
 * cached claim from token-issuance time. See `docs/security/authentication-flows.md`.
 */
export class JwtTokenSigner implements TokenSigner {
  constructor(private readonly keyProvider: SigningKeyProvider) {}

  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      sessionId: payload.sessionId,
      userId: payload.userId,
      iat: now,
      exp: now + ttlSeconds,
    };
    const body = base64UrlEncode(JSON.stringify(claims));
    const signature = this.computeSignature(`${HEADER}.${body}`, this.keyProvider.currentSecret());

    return Promise.resolve(`${HEADER}.${body}.${signature}`);
  }

  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token.")));
    }
    const [header, body, signature] = parts as [string, string, string];

    const expectedSignature = this.computeSignature(`${header}.${body}`, this.keyProvider.currentSecret());
    if (!timingSafeEqualStrings(signature, expectedSignature)) {
      return Promise.resolve(
        Result.err(new ValidationError("Access token signature is invalid.")),
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token payload.")));
    }

    if (!isAccessTokenClaims(decoded)) {
      return Promise.resolve(Result.err(new ValidationError("Malformed access token payload.")));
    }

    if (Date.now() >= decoded.exp * 1000) {
      return Promise.resolve(Result.err(new ValidationError("Access token has expired.")));
    }

    return Promise.resolve(
      Result.ok({ sessionId: decoded.sessionId, userId: decoded.userId }),
    );
  }

  private computeSignature(segment: string, secret: string): string {
    return createHmac("sha256", secret).update(segment, "utf8").digest("base64url");
  }
}

/** Timing-safe comparison of two possibly-different-length strings — see `Invitation.matchesToken`. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
import { Result } from "@verixa/shared-kernel";
import { errors, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { ok, err, type Result } from "@verixa/shared-kernel";

import type {
  AccessTokenClaims,
  IssueAccessTokenParams,
  SignedAccessToken,
  TokenSigner,
} from "../application/ports/token-signer.js";
import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
  SigningError,
} from "../application/ports/token-signer.js";

/**
 * JWT access token signer using RS256 (RSA asymmetric signing).
 *
 * This implementation uses Node's native `crypto` module (via the `jose`
 * library, which wraps it) to sign tokens with a private RSA key and verify
 * them with a public RSA key. Both keys are expected in PEM format (PKCS#8
 * for private keys, SPKI for public keys).
 *
 * **Key Caching:**
 * RSA key import (parsing PEM, converting to the crypto API's internal format)
 * is an expensive operation. On first use, this signer imports both keys and
 * caches them, so subsequent calls reuse the cached versions. This is safe:
 * crypto key objects are immutable.
 *
 * **Thread Safety:**
 * This implementation is stateless and thread-safe. Multiple concurrent
 * sign() and verify() calls do not interfere with each other.
 */
export class JwtTokenSigner implements TokenSigner {
  private cachedPrivateKey: ReturnType<typeof createPrivateKey> | null = null;
  private cachedPublicKey: ReturnType<typeof createPublicKey> | null = null;

  /**
   * Create a new JWT token signer.
   *
   * @param privateKeyPem - RSA private key in PKCS#8 PEM format. Must contain
   *   the "-----BEGIN PRIVATE KEY-----" and "-----END PRIVATE KEY-----" markers.
   * @param publicKeyPem - RSA public key in SPKI PEM format. Must contain the
   *   "-----BEGIN PUBLIC KEY-----" and "-----END PUBLIC KEY-----" markers.
   * @param keyId - A short identifier for this key pair (e.g., "2024-01-15-v1").
   *   Embedded in each token's header as the `kid` claim. Used for key rotation
   *   (Issue 085): when a new key pair is created, this ID changes, but the old
   *   public key is kept for verifying tokens issued moments before the rotation.
   */
  constructor(
    private readonly privateKeyPem: string,
    private readonly publicKeyPem: string,
    private readonly keyId: string,
  ) {}

  /**
   * Lazily import and cache the private key.
   * Repeated calls return the same cached instance.
   */
  private getPrivateKey(): ReturnType<typeof createPrivateKey> {
    if (!this.cachedPrivateKey) {
      try {
        this.cachedPrivateKey = createPrivateKey(this.privateKeyPem);
      } catch (error) {
        throw new SigningError(
          `Failed to import private key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return this.cachedPrivateKey;
  }

  /**
   * Lazily import and cache the public key.
   * Repeated calls return the same cached instance.
   */
  private getPublicKey(): ReturnType<typeof createPublicKey> {
    if (!this.cachedPublicKey) {
      try {
        this.cachedPublicKey = createPublicKey(this.publicKeyPem);
      } catch (error) {
        throw new SigningError(
          `Failed to import public key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return this.cachedPublicKey;
  }

  async sign(params: IssueAccessTokenParams): Promise<Result<SignedAccessToken, SigningError>> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = Math.floor(params.expiresAt.getTime() / 1000);

      // Reject if expiration is not in the future.
      if (expiresAt <= now) {
        return err(new SigningError("Token expiration must be in the future"));
      }

      const claims: AccessTokenClaims = {
        sub: params.userId,
        sid: params.sessionId,
        orgId: params.organizationId,
        iat: now,
        exp: expiresAt,
        kid: this.keyId,
      };

      const privateKey = this.getPrivateKey();

      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.keyId })
        .setIssuedAt(now)
        .setExpirationTime(expiresAt)
        .sign(privateKey);

      return ok({
        token,
        claims,
        expiresAt: params.expiresAt,
      });
    } catch (error) {
      if (error instanceof SigningError) {
        return err(error);
      }
      return err(
        new SigningError(
          `Failed to sign token: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const publicKey = this.getPublicKey();

      // jwtVerify checks signature and expiration.
      const result = await jwtVerify(token, publicKey);
      const payload = result.payload;

      // Validate required claims are present.
      if (
        !payload.sub ||
        !payload.sid ||
        !payload.orgId ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        !payload.kid
      ) {
        throw new MalformedTokenError("Token is missing required claims");
      }

      return {
        sub: payload.sub as any,
        sid: payload.sid as any,
        orgId: payload.orgId as any,
        iat: payload.iat,
        exp: payload.exp,
        kid: payload.kid as string,
      };
    } catch (error) {
      // Map specific error types.
      if (error instanceof MalformedTokenError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      // jose throws with "exp claim expired" or similar for expiry.
      if (message.includes("exp") || message.includes("expired")) {
        throw new ExpiredTokenError(message);
      }

      // Signature failures include "invalid signature" or "verification failed".
      if (
        message.includes("signature") ||
        message.includes("verify") ||
        message.includes("invalid")
      ) {
        throw new InvalidSignatureError(message);
      }

      // Default to malformed for any other parse/validation error.
      throw new MalformedTokenError(`Token verification failed: ${message}`);
    }
  }
}
