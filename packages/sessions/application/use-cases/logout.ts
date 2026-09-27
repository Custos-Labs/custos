import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionId } from "../../domain/entities/session.js";
import { asId, Result } from "@verixa/shared-kernel";

import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface LogoutCommand {
  readonly sessionId: string;
  /**
   * How long to keep `sessionId` on the revocation list — normally the
   * access token's own remaining lifetime. Defaults to a day, generous
   * enough to outlive any access token issued by the default
   * `SessionExpiryPolicy` even if the caller doesn't know the exact expiry.
   */
  readonly revokeUntil?: Date;
}

export type LogoutError = ValidationError;

const DEFAULT_REVOCATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Logs a single session out: revokes it, and records it on the
 * `RevocationList` so its still-valid access token stops working
 * immediately rather than merely at its next natural expiry.
 *
 * Idempotent, and deliberately silent about whether `sessionId` existed —
 * logging out a session that is already gone (already logged out from
 * another tab, already expired) is a success from the caller's point of
 * view, not an error to report. Returning `NotFoundError` here would let a
 * caller enumerate valid session ids by trying random ones and watching
 * which come back 404 vs. 200.
  readonly now?: Date;
}

/**
 * Revokes one session: the current refresh token stops working, and the
 * session's current access token is denylisted so it stops working too,
 * before it would otherwise expire on its own.
 *
 * ## Why both tokens have to be handled, not just one
 *
 * Verixa's access tokens are stateless JWTs — accepted on their signature
 * alone, without a database or Redis round trip, which is the entire reason
 * to use them. Revoking only the refresh token would leave the access token
 * fully functional for however long its remaining lifetime is: "log out"
 * would not actually log anyone out, it would just prevent the *next*
 * token. Revoking only the access token (denylisting it) would stop the
 * current token but leave the refresh token able to mint a fresh,
 * non-denylisted one moments later.
 *
 * So this revokes the session (kills the refresh token) *and* denylists
 * `currentAccessToken` (kills the access token already issued), which
 * together are what Issue 091's acceptance criterion asks for: "the access
 * token fails `isRevoked` checks and the refresh token can no longer be used
 * to refresh." See `docs/security/authentication-flows.md`.
 *
 * ## Idempotence
 *
 * Logging out twice, or logging out a session that never existed, both
 * succeed rather than erroring. A logout failing because the user is
 * "already logged out" is not a state worth surfacing to a client whose
 * only intent was "make sure I am not signed in" — the property that
 * matters is achieved either way.
 */
export class Logout {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly revocationList: RevocationList,
  ) {}

  async execute(command: LogoutCommand): Promise<Result<void, LogoutError>> {
    if (command.sessionId.trim() === "") {
      return Result.err(
        new ValidationError("sessionId is required.", { sessionId: ["is required"] }),
      );
    }

    const sessionId = asId<"SessionId">(command.sessionId) as SessionId;
    const session = await this.sessionRepository.findById(sessionId);
  async execute(command: LogoutCommand): Promise<Result<void, never>> {
    const now = command.now ?? new Date();

    const session = await this.sessionRepository.findById(asId<"SessionId">(command.sessionId));
    if (session === undefined) {
      return Result.ok(undefined);
    }

    const now = new Date();
    await this.sessionRepository.save(session.revoke(now));
    await this.revocationList.revoke(
      sessionId,
      command.revokeUntil ?? new Date(now.getTime() + DEFAULT_REVOCATION_WINDOW_MS),
    );
    if (session.currentAccessToken !== undefined) {
      await this.revocationList.revoke(
        session.currentAccessToken.tokenId,
        session.currentAccessToken.expiresAt,
      );
    }

    await this.sessionRepository.save(session.revoke(now));

    return Result.ok(undefined);
  }
}
