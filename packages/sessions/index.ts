// Curated public surface of @verixa/sessions. Nothing outside this package
// should import from a deep path (`@verixa/sessions/domain/...`,
// `@verixa/sessions/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.

// Domain: entities
export type { SessionId, SessionMetadata, SessionUserId } from "./domain/entities/session.js";
export { Session } from "./domain/entities/session.js";
export type { IssuedRefreshToken, RefreshTokenId } from "./domain/entities/refresh-token.js";
export { RefreshToken } from "./domain/entities/refresh-token.js";

// Domain: value objects
export { SessionExpiryPolicy } from "./domain/value-objects/session-expiry-policy.js";

// Domain: events
export { RefreshTokenReuseDetected } from "./domain/events/refresh-token-reuse-detected.js";

// Application: ports (for infrastructure adapters to implement)
export type { SessionRepository } from "./application/ports/session-repository.js";
export type { AccessTokenPayload, TokenSigner } from "./application/ports/token-signer.js";
export type { RevocationList } from "./application/ports/revocation-list.js";

// Application: use cases
export type { IssueSessionCommand, IssuedSession, IssueSessionError } from "./application/use-cases/issue-session.js";
export { IssueSession } from "./application/use-cases/issue-session.js";
export type {
  RefreshAccessTokenCommand,
  RefreshedAccessToken,
  RefreshAccessTokenError,
} from "./application/use-cases/refresh-access-token.js";
export { RefreshAccessToken } from "./application/use-cases/refresh-access-token.js";
export type { LogoutCommand, LogoutError } from "./application/use-cases/logout.js";
export { Logout } from "./application/use-cases/logout.js";
export type {
  LogoutEverywhereCommand,
  LogoutEverywhereError,
} from "./application/use-cases/logout-everywhere.js";
export { LogoutEverywhere } from "./application/use-cases/logout-everywhere.js";
export type {
  ListActiveSessionsCommand,
  ListActiveSessionsError,
  SessionSummary,
} from "./application/use-cases/list-active-sessions.js";
export { ListActiveSessions } from "./application/use-cases/list-active-sessions.js";

// Infrastructure: adapters (Exported so the composition root can construct them)
export { PrismaSessionRepository } from "./infrastructure/persistence/prisma-session-repository.js";
export { JwtTokenSigner } from "./infrastructure/jwt-token-signer.js";
export { SigningKeyProvider } from "./infrastructure/signing-key-provider.js";
export { RedisRevocationList } from "./infrastructure/redis-revocation-list.js";
export { SessionsPackageRevoker } from "./infrastructure/session-revoker-adapter.js";

// Testing fakes
export { InMemorySessionRepository } from "./infrastructure/testing/in-memory-session-repository.js";
export { InMemoryRevocationList } from "./infrastructure/testing/in-memory-revocation-list.js";
