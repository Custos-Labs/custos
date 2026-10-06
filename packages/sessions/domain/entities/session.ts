import { createId, type DomainEvent, type Id } from "@verixa/shared-kernel";

import { RefreshTokenReuseDetected } from "../events/refresh-token-reuse-detected.js";
import type { SessionExpiryPolicy } from "../value-objects/session-expiry-policy.js";

import type { RefreshTokenId } from "./refresh-token.js";

export type SessionId = Id<"SessionId">;

/**
 * A `UserId` from the identity context, referenced by value.
 *
 * Declared locally rather than imported so the *domain* layer of sessions
 * depends on nothing outside itself — the same reasoning as
 * `CredentialUserId` in `packages/credentials`. See
 * `docs/guides/domain-modeling.md`.
 */
export type SessionUserId = Id<"UserId">;

/** Where a session was opened from, for the "manage your devices" view (Issue 095). */
export interface SessionMetadata {
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
}

interface SessionProps {
  readonly id: SessionId;
  readonly userId: SessionUserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly revokedAt: Date | undefined;
  readonly domainEvents?: readonly DomainEvent[];
}

/**
 * A single logged-in session for a user: one browser, device or client that
 * authenticated and hasn't logged out. Holds no token material itself — the
 * bearer secret lives on {@link RefreshToken}, rotated independently — so
 * that listing or displaying a `Session` (Issue 095) can never leak
 * something a token thief could replay. See `docs/security/token-storage.md`.
 *
 * Revocation here only stops the *refresh* token from working; its current
 * access token is a self-contained JWT that stays valid until its own
 * `exp`. Closing that window is `RevocationList`'s job, keyed by this
 * session's own `id` — not something tracked on the entity, since the JWT
 * payload (`AccessTokenPayload`) already carries `sessionId` for exactly
 * this check. See `Logout`/`LogoutEverywhere`/`IssueSession`'s eviction.
 *
 * ## No setters
 *
 * Same discipline as `AuditLogEntry` and `User`: every state change returns
 * a new `Session`, and there is no way to mutate `revokedAt` from outside
 * this class.
 */
export class Session {
  readonly id: SessionId;
  readonly userId: SessionUserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly revokedAt: Date | undefined;
  private readonly domainEvents: readonly DomainEvent[];

  private constructor(props: SessionProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.createdAt = props.createdAt;
    this.lastSeenAt = props.lastSeenAt;
    this.expiresAt = props.expiresAt;
    this.ipAddress = props.ipAddress;
    this.userAgent = props.userAgent;
    this.revokedAt = props.revokedAt;
    this.domainEvents = props.domainEvents ?? [];
  }

  /** Opens a brand-new session for `userId`, expiring per `policy`'s absolute lifetime. */
  static open(params: {
    userId: SessionUserId;
    policy: SessionExpiryPolicy;
    metadata?: SessionMetadata;
    now?: Date;
  }): Session {
    const now = params.now ?? new Date();
    return new Session({
      id: createId<"SessionId">(),
      userId: params.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: params.policy.absoluteExpiryFrom(now),
      ipAddress: params.metadata?.ipAddress,
      userAgent: params.metadata?.userAgent,
      revokedAt: undefined,
    });
  }

  /** Rebuilds a `Session` from already-trusted data (e.g. a database row). Never carries pending domain events — see `User.reconstitute`. */
  static reconstitute(props: SessionProps): Session {
    return new Session({ ...props, domainEvents: [] });
  }

  /**
   * Whether this session may still be used at `now`: not explicitly revoked,
   * not past its absolute expiry, and not idle for longer than `policy`
   * allows.
   */
  isActive(policy: SessionExpiryPolicy, now: Date = new Date()): boolean {
    if (this.isRevoked) {
      return false;
    }
    if (now.getTime() >= this.expiresAt.getTime()) {
      return false;
    }
    return !policy.isIdleExpired(this.lastSeenAt, now);
  }

  get isRevoked(): boolean {
    return this.revokedAt !== undefined;
  }

  /** Records activity — called on every successful token refresh. */
  touch(now: Date = new Date()): Session {
    return new Session({ ...this, lastSeenAt: now, domainEvents: this.domainEvents });
  }

  /**
   * Revokes the session. Idempotent: revoking an already-revoked session
   * keeps the original `revokedAt`, so the timestamp always reflects when
   * revocation first happened rather than the most recent redundant call.
   */
  revoke(now: Date = new Date()): Session {
    if (this.isRevoked) {
      return this;
    }
    return new Session({ ...this, revokedAt: now, domainEvents: [] });
  }

  /**
   * Revokes the session because a refresh token belonging to it was reused
   * after already being rotated out — see `RefreshTokenReuseDetected`.
   * Distinct from the plain {@link revoke} because *why* the session was
   * killed is itself security-relevant information worth recording as an
   * event, the same reasoning `User.suspend`'s optional `reason` follows.
   */
  revokeDueToRefreshTokenReuse(refreshTokenId: RefreshTokenId, now: Date = new Date()): Session {
    if (this.isRevoked) {
      return this;
    }
    return new Session({
      ...this,
      revokedAt: now,
      domainEvents: [new RefreshTokenReuseDetected(this.id, this.userId, refreshTokenId)],
    });
  }

  /** Returns the domain event(s) produced by the action that created this specific `Session` instance. See `User.pullDomainEvents`. */
  pullDomainEvents(): readonly DomainEvent[] {
    return this.domainEvents;
  }
}
