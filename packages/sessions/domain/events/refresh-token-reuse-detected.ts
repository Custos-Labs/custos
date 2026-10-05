import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { RefreshTokenId } from "../entities/refresh-token.js";
import type { SessionId, SessionUserId } from "../entities/session.js";

/**
 * Recorded when a refresh token that was already rotated out (consumed by an
 * earlier `RefreshAccessToken` call) is presented again.
 *
 * This is the strongest signal available that a refresh token has been
 * stolen: a legitimate client only ever holds the *latest* token in a
 * session's rotation chain, because it discards the old one the moment
 * rotation hands it a new one. Anyone presenting an already-consumed token is
 * therefore holding a copy taken before, or during, a rotation that already
 * happened — either an attacker with a stale copy of the token, or (far less
 * likely) a client bug that reused a value it should have discarded.
 *
 * The response has to assume the worse case: the whole session is revoked,
 * not just the presented token, on the theory that if this token leaked the
 * others plausibly did too. See `docs/security/threat-model-sessions.md`.
 */
export class RefreshTokenReuseDetected extends BaseDomainEvent {
  readonly eventName = "sessions.refresh_token.reuse_detected";
  readonly userId: SessionUserId;
  readonly refreshTokenId: RefreshTokenId;

  constructor(sessionId: SessionId, userId: SessionUserId, refreshTokenId: RefreshTokenId) {
    super(sessionId);
    this.userId = userId;
    this.refreshTokenId = refreshTokenId;
  }
}
