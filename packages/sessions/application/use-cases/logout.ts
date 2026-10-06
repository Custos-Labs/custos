import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionId } from "../../domain/entities/session.js";
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
 * ## Why both tokens have to be handled, not just one
 *
 * Verixa's access tokens are stateless JWTs — accepted on their signature
 * alone, without a database or Redis round trip, which is the entire reason
 * to use them. Revoking only the refresh token would leave the access token
 * fully functional for however long its remaining lifetime is: "log out"
 * would not actually log anyone out, it would just prevent the *next*
 * token. Denylisting by `sessionId` on `RevocationList` closes that gap —
 * the access token payload carries `sessionId`, so one revocation entry
 * closes every access token that session ever issued.
 *
 * ## Idempotence
 *
 * Logging out twice, or logging out a session that never existed, both
 * succeed rather than erroring. A logout failing because the user is
 * "already logged out" is not a state worth surfacing to a client whose
 * only intent was "make sure I am not signed in" — the property that
 * matters is achieved either way. Returning `NotFoundError` here would let a
 * caller enumerate valid session ids by trying random ones and watching
 * which come back 404 vs. 200.
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
    if (session === undefined) {
      return Result.ok(undefined);
    }

    const now = new Date();
    await this.sessionRepository.save(session.revoke(now));
    await this.revocationList.revoke(
      sessionId,
      command.revokeUntil ?? new Date(now.getTime() + DEFAULT_REVOCATION_WINDOW_MS),
    );

    return Result.ok(undefined);
  }
}
