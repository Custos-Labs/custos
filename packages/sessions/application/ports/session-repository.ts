import type { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { Session, SessionId, SessionUserId } from "../../domain/entities/session.js";

/**
 * The persistence contract the application layer needs for `Session` and its
 * `RefreshToken` rotation chain — the **port** half of ports & adapters. See
 * `packages/identity/application/ports/user-repository.ts` for the pattern
 * this follows, and `docs/guides/domain-modeling.md` for the rationale.
 *
 * Method contracts:
 * - `findById`/`findRefreshTokenByHash` return `undefined` when nothing
 *   matches — a missing session or token is an expected outcome (an expired
 *   or already-logged-out session, a bogus refresh token), not an error
 *   condition.
 * - `save`/`saveRefreshToken` are idempotent upserts, same convention as
 *   `UserRepository.save`.
 * - `findActiveByUserId` returns sessions that are not (yet) revoked,
 *   ordered oldest-`lastSeenAt`-first — that ordering is load-bearing:
 *   `IssueSession`'s concurrent-session-limit enforcement (Issue 094) evicts
 *   from the front of this list, and a repository that returned an
 *   unspecified order would make eviction pick an arbitrary session instead
 *   of the least-recently-active one. Callers still apply idle/absolute
 *   expiry via `Session.isActive`; this does not filter on `expiresAt`.
 * - `findRefreshTokenByHash` takes the *hash*, not the raw token — callers
 *   hash before looking up, the same lookup-key convention as
 *   `docs/security/token-storage.md`.
 * - `revokeAllForUser` revokes every one of a user's sessions in a single
 *   call rather than requiring the caller to `findActiveByUserId` and then
 *   `save` each one, so a real adapter can do it as one `UPDATE ... WHERE`
 *   statement instead of N round-trips.
 */
export interface SessionRepository {
  save(session: Session): Promise<void>;
  findById(id: SessionId): Promise<Session | undefined>;
  findActiveByUserId(userId: SessionUserId): Promise<readonly Session[]>;
  /** Revokes every one of `userId`'s sessions. Idempotent. */
  revokeAllForUser(userId: SessionUserId, now?: Date): Promise<void>;

  saveRefreshToken(refreshToken: RefreshToken): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined>;
}
