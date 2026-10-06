import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createId, type Id } from "@verixa/shared-kernel";

import type { SessionId } from "./session.js";

export type RefreshTokenId = Id<"RefreshTokenId">;

/**
 * A `RefreshToken` plus the one-time raw bearer value issued with it. The raw
 * value is never a field on {@link RefreshToken} — see
 * `docs/security/token-storage.md` and `Invitation.create` in
 * `packages/identity`, which this follows exactly.
 */
export interface IssuedRefreshToken {
  readonly refreshToken: RefreshToken;
  readonly token: string;
}

/**
 * Byte length for the opaque refresh token's raw value.
 *
 * 256 bits (32 bytes): exceeds the OWASP 128-bit minimum entropy
 * recommendation (RFC 6819, §5.2.2) for long-lived bearer tokens, and
 * base64url-encodes to a size that fits comfortably in standard HTTP
 * headers and cookies.
 */
const REFRESH_TOKEN_BYTE_LENGTH = 32;

interface RefreshTokenProps {
  readonly id: RefreshTokenId;
  readonly sessionId: SessionId;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** When this token was consumed by a rotation. `undefined` while still current. */
  readonly usedAt: Date | undefined;
  readonly revokedAt: Date | undefined;
}

/**
 * One link in a session's refresh-token rotation chain.
 *
 * Refresh tokens rotate: every successful `RefreshAccessToken` call consumes
 * the presented token (marks it {@link usedAt}) and issues a brand-new one.
 * Keeping consumed tokens around, rather than deleting them, is what makes
 * reuse detection possible — presenting a token that is already `usedAt` is
 * the strongest available signal that it was copied and is being replayed,
 * since a legitimate client discards a token the moment rotation replaces it.
 * See `RefreshTokenReuseDetected` and `docs/security/threat-model-sessions.md`.
 */
export class RefreshToken {
  readonly id: RefreshTokenId;
  readonly sessionId: SessionId;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | undefined;
  readonly revokedAt: Date | undefined;

  private constructor(props: RefreshTokenProps) {
    this.id = props.id;
    this.sessionId = props.sessionId;
    this.tokenHash = props.tokenHash;
    this.createdAt = props.createdAt;
    this.expiresAt = props.expiresAt;
    this.usedAt = props.usedAt;
    this.revokedAt = props.revokedAt;
  }

  /**
   * SHA-256 hash of a raw token, hex-encoded — the only form ever stored or
   * looked up by. Public so callers (`RefreshAccessToken`) can hash a
   * presented token before passing it to
   * `SessionRepository.findRefreshTokenByHash`.
   */
  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /**
   * Issues a new refresh token bound to `sessionId`.
   *
   * The raw token is 256 bits from a CSPRNG (`randomBytes`, not `randomUUID`
   * — a bearer credential benefits from more entropy than an identifier
   * needs), returned alongside the entity exactly once. See
   * `docs/security/token-storage.md`.
   */
  static issue(params: { sessionId: SessionId; expiresAt: Date; now?: Date }): IssuedRefreshToken {
    const token = randomBytes(REFRESH_TOKEN_BYTE_LENGTH).toString("base64url");
    const refreshToken = new RefreshToken({
      id: createId<"RefreshTokenId">(),
      sessionId: params.sessionId,
      tokenHash: RefreshToken.hashToken(token),
      createdAt: params.now ?? new Date(),
      expiresAt: params.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });

    return { refreshToken, token };
  }

  /** Rebuilds a `RefreshToken` from already-trusted data (e.g. a database row). */
  static reconstitute(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }

  /** Whether `token` is the raw value this entity was issued with. Timing-safe — see `Invitation.matchesToken`. */
  matchesToken(token: string): boolean {
    const candidate = Buffer.from(RefreshToken.hashToken(token), "hex");
    const actual = Buffer.from(this.tokenHash, "hex");
    return candidate.length === actual.length && timingSafeEqual(candidate, actual);
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  get isUsed(): boolean {
    return this.usedAt !== undefined;
  }

  get isRevoked(): boolean {
    return this.revokedAt !== undefined;
  }

  /** Whether this token may still be redeemed to rotate: not used, not revoked, not expired. */
  isRedeemable(now: Date = new Date()): boolean {
    return !this.isUsed && !this.isRevoked && !this.isExpired(now);
  }

  /** Marks this token consumed by a rotation. Not idempotent by design — calling it twice is exactly the reuse case this exists to catch. */
  markUsed(now: Date = new Date()): RefreshToken {
    return new RefreshToken({ ...this, usedAt: now });
  }

  /** Revokes this specific token outright (e.g. as part of revoking its whole session). */
  revoke(now: Date = new Date()): RefreshToken {
    if (this.isRevoked) {
      return this;
    }
    return new RefreshToken({ ...this, revokedAt: now });
  }
}
