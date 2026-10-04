import { AuthenticationError, Result } from "@verixa/shared-kernel";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { RevocationList } from "../ports/revocation-list.js";
import { asId, AuthenticationError, Result } from "@verixa/shared-kernel";

import type { Session, SessionMetadata } from "../../domain/entities/session.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { TokenSigner } from "../ports/token-signer.js";

export interface RefreshAccessTokenCommand {
  readonly refreshToken: string;
}

export interface RefreshedAccessToken {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type RefreshAccessTokenError = AuthenticationError;

/**
 * Redeems a refresh token for a new access/refresh token pair, rotating the
 * refresh token in the process.
 *
 * One error for every failure reason — an unknown token, an expired one, one
 * belonging to a revoked session, and a *reused* one (see below) are all
 * reported identically as {@link AuthenticationError}. Distinguishing them on
 * the wire would tell a caller holding a stolen token exactly what's wrong
 * with it, which is information that only helps whoever isn't supposed to
 * have it. See `AuthenticationError` and `docs/security/authentication-flows.md`.
 *
 * ## Reuse detection
 *
 * Rotation marks the presented token {@link RefreshToken.markUsed}. If this
 * token has *already* been marked used, that is not "the client sent a stale
 * request" — a legitimate client discards a token the moment rotation
 * replaces it, so presenting an already-consumed one means someone else has
 * a copy. The response is to revoke the whole session, not just the token:
 * see `Session.revokeDueToRefreshTokenReuse` and
 * `docs/security/threat-model-sessions.md`.
  readonly sessionId: string;
  readonly refreshToken: string;
  /** What the client presents on *this* request — compared against what the session last saw. */
  readonly metadata: SessionMetadata;
  readonly now?: Date;
}

export interface RefreshAccessTokenResult {
  readonly session: Session;
  readonly accessToken: string;
}

/**
 * Exchanges a refresh token for a new access token, and — this is Issue
 * 093's other half — updates the session's metadata history if what the
 * client presents this time differs from what it presented last.
 *
 * ## Why a wrong or expired refresh token gets the same error as a wrong
 * session id
 *
 * Same reasoning as `AuthenticateWithPassword`: "no such session", "session
 * revoked", "session expired", and "refresh token does not match" are all
 * `AuthenticationError` to the caller. A client holding a stale or stolen
 * refresh token learns nothing about *which* of those is true, which is what
 * keeps a leaked refresh token from being a probe for session ids.
 *
 * ## Rotation and reuse detection are explicitly not this use case's job
 *
 * `RefreshToken` and `RefreshTokenReuseDetected` exist elsewhere in this
 * package as their own, still-unimplemented pieces (a separate roadmap
 * item). Detecting reuse of an already-rotated refresh token needs the
 * refresh token itself to be a tracked, single-use entity — which is a
 * bigger change than Issue 093 asks for and would be scope creep on a "just
 * capture the metadata" ticket. This use case therefore verifies the
 * session's *current* refresh token hash and re-signs the access token,
 * without rotating the refresh token. Rotation can be layered on top of this
 * later without touching the metadata-capture behaviour this issue is for.
 */
export class RefreshAccessToken {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly tokenSigner: TokenSigner,
    private readonly revocationList: RevocationList,
    private readonly expiryPolicy: SessionExpiryPolicy,
  ) {}

  async execute(
    command: RefreshAccessTokenCommand,
  ): Promise<Result<RefreshedAccessToken, RefreshAccessTokenError>> {
    const tokenHash = RefreshToken.hashToken(command.refreshToken);
    const presented = await this.sessionRepository.findRefreshTokenByHash(tokenHash);
    if (presented === undefined) {
      return Result.err(new AuthenticationError());
    }

    const session = await this.sessionRepository.findById(presented.sessionId);
    if (session === undefined) {
      return Result.err(new AuthenticationError());
    }

    const now = new Date();

    if (presented.isUsed) {
      const revokedSession = session.revokeDueToRefreshTokenReuse(presented.id, now);
      await this.sessionRepository.save(revokedSession);
      await this.revocationList.revoke(revokedSession.id, this.accessTokenExpiryFrom(now));
      return Result.err(new AuthenticationError());
    }

    if (!presented.isRedeemable(now) || !session.isActive(this.expiryPolicy, now)) {
      return Result.err(new AuthenticationError());
    }

    const usedToken = presented.markUsed(now);
    const { refreshToken: nextRefreshToken, token: rawNextToken } = RefreshToken.issue({
      sessionId: session.id,
      expiresAt: this.expiryPolicy.refreshTokenExpiryFrom(now),
      now,
    });
    const touchedSession = session.touch(now);

    await this.sessionRepository.saveRefreshToken(usedToken);
    await this.sessionRepository.saveRefreshToken(nextRefreshToken);
    await this.sessionRepository.save(touchedSession);

    const accessToken = await this.tokenSigner.sign(
      { sessionId: touchedSession.id, userId: touchedSession.userId },
      Math.floor(this.expiryPolicy.accessTokenTtlMs / 1000),
    );

    return Result.ok({ accessToken, refreshToken: rawNextToken });
  }

  private accessTokenExpiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.expiryPolicy.accessTokenTtlMs);
  ): Promise<Result<RefreshAccessTokenResult, AuthenticationError>> {
    const now = command.now ?? new Date();

    const session = await this.sessionRepository.findById(asId<"SessionId">(command.sessionId));
    if (session === undefined) {
      return Result.err(new AuthenticationError("Invalid or expired session."));
    }

    if (!session.isActiveAt(now) || !session.matchesRefreshToken(command.refreshToken)) {
      return Result.err(new AuthenticationError("Invalid or expired session."));
    }

    const accessToken = await this.tokenSigner.issueAccessToken({ userId: session.userId, now });

    const refreshed = session.recordActivity({
      metadata: command.metadata,
      accessToken: { tokenId: accessToken.tokenId, expiresAt: accessToken.expiresAt },
      now,
    });

    await this.sessionRepository.save(refreshed);

    return Result.ok({ session: refreshed, accessToken: accessToken.token });
  }
}
