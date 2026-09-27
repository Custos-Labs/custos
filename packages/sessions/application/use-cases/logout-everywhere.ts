import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionUserId } from "../../domain/entities/session.js";
import { asId, Result } from "@verixa/shared-kernel";

import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface LogoutEverywhereCommand {
  readonly userId: string;
}

export type LogoutEverywhereError = ValidationError;

const DEFAULT_REVOCATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Revokes every active session belonging to a user — "log out everywhere",
 * and the adapter `packages/credentials`' `ConfirmPasswordReset` calls
 * through the `SessionRevoker` port once this package exists (Issue 070's
 * `NoSessionsRevoker` is replaced with an adapter over this use case in the
 * composition root; see `apps/api/src/composition-root.ts`).
 *
 * Idempotent, same reasoning as `Logout`: a user with no active sessions is
 * a successful (trivial) "logout everywhere", not an error.
  readonly now?: Date;
}

export interface LogoutEverywhereResult {
  /** How many sessions were revoked — diagnostic only, not a security-relevant count. */
  readonly revokedCount: number;
}

/**
 * Revokes every active session belonging to a user: the blunt-force tool
 * behind "log out all devices," password-change flows (`ConfirmPasswordReset`
 * in `@verixa/credentials`, via its `SessionRevoker` port — Issue 070), and
 * admin-initiated account lockdown.
 *
 * ## Why this loads every active session instead of a single bulk update
 *
 * A bulk `UPDATE sessions SET revoked_at = now() WHERE user_id = ...` would
 * be one round trip instead of `N`, but it would also revoke the refresh
 * token side of every session while leaving each one's already-issued
 * access token untouched — the same gap `Logout` closes for a single
 * session. Denylisting every one of those access tokens needs each
 * session's `currentAccessToken`, which means reading the sessions is
 * unavoidable regardless of how the revocation itself is written. Once the
 * data has to be read anyway, going through the domain entity (rather than a
 * raw update) keeps the "revoke" behaviour defined in exactly one place —
 * `Session.revoke` — instead of a SQL statement re-deriving it.
 *
 * ## Why new logins after the call are unaffected
 *
 * Only *existing* rows returned by `findActiveByUserId` at the moment this
 * runs are touched. A session created by a concurrent `IssueSession` call
 * that lands after this method has already read the list is a different
 * row this call never sees — which is exactly Issue 092's second acceptance
 * criterion: "new logins after the call are unaffected." That is not a
 * synchronization gap to close; a user who logs back in immediately after
 * "log out everywhere" is not the scenario this defends against, and a
 * fix would mean holding a lock across the entire user's session table for
 * no benefit.
 */
export class LogoutEverywhere {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly revocationList: RevocationList,
  ) {}

  async execute(command: LogoutEverywhereCommand): Promise<Result<void, LogoutEverywhereError>> {
    if (command.userId.trim() === "") {
      return Result.err(new ValidationError("userId is required.", { userId: ["is required"] }));
    }

    const userId = asId<"UserId">(command.userId) as SessionUserId;
    const now = new Date();
    const revokeUntil = new Date(now.getTime() + DEFAULT_REVOCATION_WINDOW_MS);

    // Revoked in the deny-list *before* the repository write, not after:
    // this is the check every still-valid access token is validated against,
    // so it must already be in place before any caller could possibly learn
    // the sessions were revoked and go looking for a window in which their
    // token still works.
    const activeSessions = await this.sessionRepository.findActiveByUserId(userId);
    await Promise.all(
      activeSessions.map((session) => this.revocationList.revoke(session.id, revokeUntil)),
    );

    await this.sessionRepository.revokeAllForUser(userId, now);

    return Result.ok(undefined);
  async execute(command: LogoutEverywhereCommand): Promise<Result<LogoutEverywhereResult, never>> {
    const now = command.now ?? new Date();
    const userId = asId<"UserId">(command.userId);

    const active = await this.sessionRepository.findActiveByUserId(userId, now);

    for (const session of active) {
      if (session.currentAccessToken !== undefined) {
        await this.revocationList.revoke(
          session.currentAccessToken.tokenId,
          session.currentAccessToken.expiresAt,
        );
      }
      await this.sessionRepository.save(session.revoke(now));
    }

    return Result.ok({ revokedCount: active.length });
  }
}
