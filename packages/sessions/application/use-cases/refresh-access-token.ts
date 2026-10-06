import { AuthenticationError, Result } from "@verixa/shared-kernel";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { RevocationList } from "../ports/revocation-list.js";
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
  }
}
