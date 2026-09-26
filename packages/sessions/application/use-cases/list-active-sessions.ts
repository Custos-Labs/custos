import { AuthorizationError, asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionUserId } from "../../domain/entities/session.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface ListActiveSessionsCommand {
  /** The id of the user making the request. */
  readonly requestingUserId: string;
  /** The id of the user whose sessions are being listed. Usually equal to `requestingUserId`. */
  readonly targetUserId: string;
  /** Whether the requester holds an admin scope entitled to read another user's sessions. Defaults to `false`. */
  readonly asAdmin?: boolean;
}

/**
 * A session shaped for display, not persistence: everything a "manage your
 * devices" screen needs and nothing a token thief could replay. There is no
 * field here that names a token, hashed or otherwise — see
 * `docs/security/token-storage.md` and `Session`'s own doc comment on why it
 * holds no token material to begin with.
 */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
}

export type ListActiveSessionsError = ValidationError | AuthorizationError;

/**
 * Returns a user's active sessions, so a self-service "manage your devices"
 * experience (Phase 12) can be built on top without inventing its own
 * scoping or redaction rules.
 *
 * Two rules the acceptance criteria call out explicitly, both enforced here
 * rather than left to callers:
 *
 * 1. **Scoping.** A caller only sees their own sessions unless they are
 *    explicitly acting with admin scope (`asAdmin: true`) — the interface
 *    layer (Phase 12) is responsible for setting that flag only when the
 *    caller's authenticated identity actually carries an admin role; this
 *    use case trusts the flag it's given, the same division of
 *    responsibility `SuspendUser`/`ReactivateUser` draw around *why* an
 *    action is allowed vs. *what* is structurally possible.
 * 2. **Redaction at the boundary.** The read model ({@link SessionSummary})
 *    has no field capable of carrying token material, so there is no way
 *    for a future caller to accidentally serialize a hash into an API
 *    response — the shape itself enforces the rule rather than relying on
 *    every consumer remembering to leave a field out. See
 *    `docs/guides/use-cases.md`.
 *
 * Only *active* sessions are returned — see `Session.isActive` — since a
 * revoked or expired session is not a device the user can still do anything
 * with, and showing it as if it were "logged in" would be misleading rather
 * than merely stale.
 */
export class ListActiveSessions {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly expiryPolicy: SessionExpiryPolicy,
  ) {}

  async execute(
    command: ListActiveSessionsCommand,
  ): Promise<Result<readonly SessionSummary[], ListActiveSessionsError>> {
    const fieldErrors: Record<string, string[]> = {};
    if (command.requestingUserId.trim() === "") {
      fieldErrors["requestingUserId"] = ["is required"];
    }
    if (command.targetUserId.trim() === "") {
      fieldErrors["targetUserId"] = ["is required"];
    }
    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Invalid session listing request.", fieldErrors));
    }

    const isOwnSessions = command.requestingUserId === command.targetUserId;
    if (!isOwnSessions && command.asAdmin !== true) {
      return Result.err(new AuthorizationError("You may not list another user's sessions."));
    }

    const targetUserId = asId<"UserId">(command.targetUserId) as SessionUserId;
    const now = new Date();
    const sessions = await this.sessionRepository.findActiveByUserId(targetUserId);

    const summaries = sessions
      .filter((session) => session.isActive(this.expiryPolicy, now))
      .map((session): SessionSummary => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      }));

    return Result.ok(summaries);
  }
}
