import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import {
  Session,
  type SessionMetadata,
  type SessionUserId,
} from "../../domain/entities/session.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionAuditLogger } from "../ports/session-audit-logger.js";
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
 * Zero (the default) disables enforcement — see Issue 094's acceptance
 * criterion "limit of 0/unset disables enforcement." Sizing this above zero
 * is a per-deployment product decision (banking apps tend to pick 1–3,
 * consumer SaaS often skips it entirely), which is why it is a constructor
 * parameter here rather than a constant: the composition root reads it from
 * `@verixa/config` and this use case stays ignorant of environment
 * variables entirely.
 */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 0;

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
 *
 * ## Concurrent-session eviction (Issue 094)
 *
 * When `maxConcurrentSessions` is positive and the user is already at the
 * limit, the least-recently-active existing session is evicted *before* the
 * new one is created — not after. If the new session were saved first, a
 * limit of `N` would briefly allow `N + 1` live sessions to exist, and a
 * crash between the save and the eviction would leave that extra session
 * behind permanently. Evicting first means the invariant ("at most `N`
 * active sessions") holds after every step, not just at the end of a
 * successful run.
 *
 * An evicted session's access token is denylisted on `RevocationList`,
 * keyed by the session's own id — see `RevocationList` for why that's
 * enough without `Session` tracking which token is current.
 */
export class IssueSession {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly tokenSigner: TokenSigner,
    private readonly expiryPolicy: SessionExpiryPolicy,
    private readonly revocationList: RevocationList,
    private readonly sessionAuditLogger: SessionAuditLogger,
    private readonly maxConcurrentSessions: number = DEFAULT_MAX_CONCURRENT_SESSIONS,
  ) {}

  async execute(command: IssueSessionCommand): Promise<Result<IssuedSession, IssueSessionError>> {
    if (command.userId.trim() === "") {
      return Result.err(new ValidationError("userId is required.", { userId: ["is required"] }));
    }

    const userId = asId<"UserId">(command.userId) as SessionUserId;
    const now = new Date();

    if (this.maxConcurrentSessions > 0) {
      await this.evictOldestUntilUnderLimit(userId, now);
    }

    const metadata: SessionMetadata = {
      ipAddress: command.ipAddress,
      userAgent: command.userAgent,
    };

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

  private async evictOldestUntilUnderLimit(userId: SessionUserId, now: Date): Promise<void> {
    // The new session is not saved yet, so "at the limit" (not "over it") is
    // the trigger: adding one more would make `active.length + 1` exceed
    // `maxConcurrentSessions` unless one is evicted first.
    for (;;) {
      const active = await this.sessionRepository.findActiveByUserId(userId);
      if (active.length < this.maxConcurrentSessions) {
        return;
      }

      // `findActiveByUserId` is documented to return oldest-`lastSeenAt`
      // first; the eviction target is therefore always `active[0]`.
      const oldest = active[0]!;
      await this.sessionRepository.save(oldest.revoke(now));
      // The evicted session's access token has no tracked expiry on the
      // entity (see `Session`'s doc comment); revoking through at least
      // `now + accessTokenTtlMs` covers any token issued under it, however
      // recently.
      await this.revocationList.revoke(
        oldest.id,
        new Date(now.getTime() + this.expiryPolicy.accessTokenTtlMs),
      );
      await this.sessionAuditLogger.record("session.evicted", userId, {
        evictedSessionId: oldest.id,
        reason: "concurrent_session_limit",
      });
    }
  }
}
