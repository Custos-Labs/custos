import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import { Session, type SessionMetadata, type SessionUserId } from "../../domain/entities/session.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { TokenSigner } from "../ports/token-signer.js";

export interface IssueSessionCommand {
  readonly userId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type IssueSessionError = ValidationError;

/**
 * Opens a new `Session` for a user who just authenticated (e.g. via
 * `AuthenticateWithPassword` in `packages/credentials`), and issues the
 * first access/refresh token pair for it.
 *
 * Deliberately takes an already-authenticated `userId` rather than
 * credentials of its own — proving *who* someone is is a different
 * context's job (Phase 04); this use case only ever runs after that has
 * already succeeded, the same separation `Credential` vs. `User` draws in
 * `packages/identity`/`packages/credentials`.
 */
export class IssueSession {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly tokenSigner: TokenSigner,
    private readonly expiryPolicy: SessionExpiryPolicy,
  ) {}

  async execute(command: IssueSessionCommand): Promise<Result<IssuedSession, IssueSessionError>> {
    if (command.userId.trim() === "") {
      return Result.err(new ValidationError("userId is required.", { userId: ["is required"] }));
    }

    const userId = asId<"UserId">(command.userId) as SessionUserId;
    const metadata: SessionMetadata = {
      ipAddress: command.ipAddress,
      userAgent: command.userAgent,
    };

    const now = new Date();
    const session = Session.open({ userId, policy: this.expiryPolicy, metadata, now });
    const { refreshToken, token: rawRefreshToken } = RefreshToken.issue({
      sessionId: session.id,
      expiresAt: this.expiryPolicy.refreshTokenExpiryFrom(now),
      now,
    });

    await this.sessionRepository.save(session);
    await this.sessionRepository.saveRefreshToken(refreshToken);

    const accessToken = await this.tokenSigner.sign(
      { sessionId: session.id, userId: session.userId },
      Math.floor(this.expiryPolicy.accessTokenTtlMs / 1000),
    );

    return Result.ok({
      sessionId: session.id,
      accessToken,
      refreshToken: rawRefreshToken,
    });
  }
}
