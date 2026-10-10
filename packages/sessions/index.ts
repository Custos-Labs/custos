// Curated public surface of @verixa/sessions. Nothing outside this package
// should import from a deep path (`@verixa/sessions/domain/...`,
// `@verixa/sessions/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.

// Domain: entities
export {
  Session,
  type SessionId,
  type SessionMetadata,
  type SessionUserId,
} from "./domain/entities/session.js";
export {
  RefreshToken,
  type IssuedRefreshToken,
  type RefreshTokenId,
} from "./domain/entities/refresh-token.js";

// Domain: value objects
export { SessionExpiryPolicy } from "./domain/value-objects/session-expiry-policy.js";
export {
  generateToken,
  hashToken,
  tokenMatchesDigest,
} from "./domain/value-objects/token-digest.js";

// Domain: events
export { RefreshTokenReuseDetected } from "./domain/events/refresh-token-reuse-detected.js";

// Application: ports (for infrastructure adapters to implement)
export type { SessionRepository } from "./application/ports/session-repository.js";
export type { AccessTokenPayload, TokenSigner } from "./application/ports/token-signer.js";
export type { RevocationList } from "./application/ports/revocation-list.js";
export type { SessionAuditLogger } from "./application/ports/session-audit-logger.js";

// Application: use cases
export {
  IssueSession,
  type IssueSessionCommand,
  type IssueSessionError,
  type IssuedSession,
} from "./application/use-cases/issue-session.js";
export {
  RefreshAccessToken,
  type RefreshAccessTokenCommand,
  type RefreshAccessTokenError,
  type RefreshedAccessToken,
} from "./application/use-cases/refresh-access-token.js";
export {
  Logout,
  type LogoutCommand,
  type LogoutError,
} from "./application/use-cases/logout.js";
export {
  LogoutEverywhere,
  type LogoutEverywhereCommand,
  type LogoutEverywhereError,
} from "./application/use-cases/logout-everywhere.js";
export {
  ListActiveSessions,
  type ListActiveSessionsCommand,
  type ListActiveSessionsError,
  type SessionSummary,
} from "./application/use-cases/list-active-sessions.js";

// Infrastructure: adapters (Exported so the composition root can construct them)
export { PrismaSessionRepository } from "./infrastructure/persistence/prisma-session-repository.js";
export { JwtTokenSigner } from "./infrastructure/jwt-token-signer.js";
export { SigningKeyProvider } from "./infrastructure/signing-key-provider.js";
export { RedisRevocationList } from "./infrastructure/redis-revocation-list.js";
export { SessionsPackageRevoker } from "./infrastructure/session-revoker-adapter.js";

// Testing fakes
export { InMemorySessionRepository } from "./infrastructure/testing/in-memory-session-repository.js";
export { InMemoryRevocationList } from "./infrastructure/testing/in-memory-revocation-list.js";
export { InMemoryTokenSigner } from "./infrastructure/testing/in-memory-token-signer.js";
export {
  InMemorySessionAuditLogger,
  type RecordedSessionAuditEntry,
} from "./infrastructure/testing/in-memory-session-audit-logger.js";
