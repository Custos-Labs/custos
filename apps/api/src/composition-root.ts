import { randomUUID } from "node:crypto";

import {
  AnchorAuditLog,
  PrismaAnchorRecordRepository,
  PrismaAuditLogRepository,
  RecordAuditEvent,
} from "@verixa/audit";
import { loadConfig } from "@verixa/config";
import {
  Argon2PasswordHasher,
  AuthenticateWithPassword,
  ConfirmEmailVerification,
  ConfirmPasswordReset,
  NullCredentialNotifier,
  PrismaCredentialsUnitOfWork,
  RegisterUserWithPassword,
  RequestEmailVerification,
  RequestPasswordReset,
} from "@verixa/credentials";
import { PrismaClient } from "@verixa/database";
import {
  CreateOrganization,
  InviteUserToOrganization,
  PrismaInvitationRepository,
  PrismaUnitOfWork,
  PrismaUserRepository,
  ReactivateUser,
  RegisterUser,
  SuspendUser,
  UpdateUserProfile,
} from "@verixa/identity";
import {
  IssueSession,
  JwtTokenSigner,
  ListActiveSessions,
  Logout,
  LogoutEverywhere,
  PrismaSessionRepository,
  RedisRevocationList,
  RefreshAccessToken,
  SessionExpiryPolicy,
  SessionsPackageRevoker,
  SigningKeyProvider,
} from "@verixa/sessions";
import { StellarHashAnchor } from "@verixa/stellar-anchor";
import { Redis } from "ioredis";

/**
 * The composition root: the one place in the system allowed to know which
 * concrete implementations exist.
 *
 * Everything else depends on interfaces. `RegisterUser` knows it needs *a*
 * `UserRepository`; it has no idea one is backed by Prisma. That's what makes
 * the whole application layer testable without a database — and it only holds
 * because the knowledge of "which implementation" is concentrated here rather
 * than scattered across the modules that use them.
 *
 * The rule to preserve: **nothing outside this file imports a `Prisma*`
 * class.** The moment a route handler constructs its own repository, the
 * dependency inversion is gone and that handler can no longer be tested
 * without a database. Wiring is deliberately boring and explicit for the same
 * reason — a DI container would hide these edges behind runtime resolution,
 * where a missing dependency becomes a runtime failure instead of a compile
 * error. At this size, explicit construction costs a few lines and buys
 * complete type safety.
 */

/**
 * Applies pool settings to the connection string (Issue 053).
 *
 * Prisma has no constructor option for pool size — it reads
 * `connection_limit` and `pool_timeout` from the URL query string. Building
 * that here keeps the tuning knobs as ordinary validated config
 * (`DATABASE_POOL_SIZE`, `DATABASE_POOL_TIMEOUT_SECONDS`) instead of
 * requiring operators to hand-append query parameters to a URL and get the
 * spelling right.
 *
 * Existing query parameters are preserved; explicit ones in `DATABASE_URL`
 * win, so a deployment can still override per-environment without changing
 * code.
 */
function pooledDatabaseUrl(): string {
  const config = loadConfig();
  const url = new URL(config.DATABASE_URL);

  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(config.DATABASE_POOL_SIZE));
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(config.DATABASE_POOL_TIMEOUT_SECONDS));
  }

  return url.toString();
}

/** Every use case the application exposes, fully wired. */
export interface IdentityUseCases {
  readonly registerUser: RegisterUser;
  readonly updateUserProfile: UpdateUserProfile;
  readonly suspendUser: SuspendUser;
  readonly reactivateUser: ReactivateUser;
  readonly createOrganization: CreateOrganization;
  readonly inviteUserToOrganization: InviteUserToOrganization;
}

/** Use cases spanning identity and credentials. */
export interface CredentialUseCases {
  readonly registerUserWithPassword: RegisterUserWithPassword;
  readonly authenticateWithPassword: AuthenticateWithPassword;
  readonly requestEmailVerification: RequestEmailVerification;
  readonly confirmEmailVerification: ConfirmEmailVerification;
  readonly requestPasswordReset: RequestPasswordReset;
  readonly confirmPasswordReset: ConfirmPasswordReset;
}

/** Audit recording and its external anchoring. */
export interface AuditUseCases {
  readonly recordEvent: RecordAuditEvent;
  /**
   * Present only when an anchoring ledger is configured.
   *
   * Absent rather than a no-op, so a deployment that has not set up anchoring
   * cannot believe it has. A silent stub here would be the worst outcome
   * available: an operator who thinks their audit log is externally verifiable
   * when nothing has ever been committed anywhere.
   */
  readonly anchor: AnchorAuditLog | undefined;
}

/** Session lifecycle, token issuance/rotation, and revocation (Phase 05). */
export interface SessionUseCases {
  readonly issueSession: IssueSession;
  readonly refreshAccessToken: RefreshAccessToken;
  readonly logout: Logout;
  readonly logoutEverywhere: LogoutEverywhere;
  readonly listActiveSessions: ListActiveSessions;
}

export interface Container {
  readonly prisma: PrismaClient;
  readonly identity: IdentityUseCases;
  readonly credentials: CredentialUseCases;
  readonly sessions: SessionUseCases;
  readonly audit: AuditUseCases;
  /** Releases the database connection (and the Redis connection, if one was opened). Call on shutdown. */
  readonly dispose: () => Promise<void>;
}

/**
 * Builds the object graph.
 *
 * Takes an optional `PrismaClient` so tests can inject one pointed at a
 * throwaway database. Production passes nothing and gets a client configured
 * from `DATABASE_URL`.
 */
export function buildContainer(prismaClient?: PrismaClient): Container {
  const prisma =
    prismaClient ?? new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } } });

  const users = new PrismaUserRepository(prisma);
  const invitations = new PrismaInvitationRepository(prisma);
  const unitOfWork = new PrismaUnitOfWork(prisma);

  // One hasher for the process, not one per request. Its cost parameters are
  // fixed configuration; constructing it per call would allocate for nothing.
  const passwordHasher = new Argon2PasswordHasher();
  const credentialsUnitOfWork = new PrismaCredentialsUnitOfWork(prisma);

  // `NullCredentialNotifier` delivers nothing — mail is Phase 14. It is
  // deliberately silent rather than a stub that logs "would have sent:
  // <token>", which is the version that survives in production for a
  // fortnight while every reset token in the system lands in a log
  // aggregator.
  const credentialNotifier = new NullCredentialNotifier();

  // Sessions (Phase 05). One signer/key-provider/expiry-policy for the
  // process, same reasoning as the password hasher above: these are fixed
  // configuration, not per-request state.
  const config = loadConfig();
  const signingKeyProvider = new SigningKeyProvider({ secret: config.SESSION_ACCESS_TOKEN_SECRET });
  const tokenSigner = new JwtTokenSigner(signingKeyProvider);
  const sessionExpiryPolicy = SessionExpiryPolicy.default();

  // `lazyConnect: true`: the client is constructed here but does not open a
  // socket until the first command actually runs. That is what lets
  // `buildContainer()` succeed as a pure "wire the object graph" step even
  // when no Redis is reachable yet (a fresh checkout, a boot smoke test) —
  // the same property `new PrismaClient(...)` already has for Postgres.
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
  const revocationList = new RedisRevocationList(redis);
  const sessionRepository = new PrismaSessionRepository(prisma);

  const issueSession = new IssueSession(sessionRepository, tokenSigner, sessionExpiryPolicy);
  const refreshAccessToken = new RefreshAccessToken(
    sessionRepository,
    tokenSigner,
    revocationList,
    sessionExpiryPolicy,
  );
  const logout = new Logout(sessionRepository, revocationList);
  const logoutEverywhere = new LogoutEverywhere(sessionRepository, revocationList);
  const listActiveSessions = new ListActiveSessions(sessionRepository, sessionExpiryPolicy);

  // Replaces `NoSessionsRevoker`, exactly as that class's own doc comment
  // anticipated: a password reset now actually invalidates the sessions it
  // was always supposed to.
  const sessionRevoker = new SessionsPackageRevoker(logoutEverywhere);

  // Audit recording. Failures are logged and never propagated -- see
  // RecordAuditEvent on why a failed audit write must not fail the operation
  // it was recording.
  const auditLog = new PrismaAuditLogRepository(prisma.auditLogEntry);
  const anchorRecords = new PrismaAnchorRecordRepository(prisma.anchorRecord, () => randomUUID());

  // Anchoring is wired only when a signing key is configured. See AuditUseCases
  // on why this is `undefined` rather than a no-op.
  const anchorSecretKey = process.env["STELLAR_ANCHOR_SECRET_KEY"];
  const stellarNetwork = process.env["STELLAR_NETWORK"] === "public" ? "public" : "testnet";
  const hashAnchor =
    anchorSecretKey === undefined || anchorSecretKey === ""
      ? undefined
      : new StellarHashAnchor({ secretKey: anchorSecretKey, network: stellarNetwork });

  // PrismaOrganizationRepository and PrismaOrganizationMembershipRepository
  // aren't constructed here: the only use case that touches them
  // (CreateOrganization) reaches them through the unit of work, since its two
  // writes must commit together. Phase 12's read-only routes will need them
  // directly, and that's when they get wired — building them now would mean
  // an unused object graph pretending to be used.

  return {
    prisma,
    identity: {
      registerUser: new RegisterUser(users),
      updateUserProfile: new UpdateUserProfile(users),
      suspendUser: new SuspendUser(users),
      reactivateUser: new ReactivateUser(users),
      // Takes the unit of work rather than the two repositories: it writes an
      // organization and a membership, and those must commit together.
      createOrganization: new CreateOrganization(unitOfWork),
      inviteUserToOrganization: new InviteUserToOrganization(invitations),
    },
    credentials: {
      registerUserWithPassword: new RegisterUserWithPassword(credentialsUnitOfWork, passwordHasher),
      // Shares the hasher instance with registration deliberately. Beyond
      // avoiding a second allocation, the timing decoy that hides whether an
      // account exists is cached per hasher, so a second instance would build
      // its own on the first failed login.
      authenticateWithPassword: new AuthenticateWithPassword(credentialsUnitOfWork, passwordHasher),
      requestEmailVerification: new RequestEmailVerification(
        credentialsUnitOfWork,
        credentialNotifier,
      ),
      confirmEmailVerification: new ConfirmEmailVerification(credentialsUnitOfWork),
      requestPasswordReset: new RequestPasswordReset(credentialsUnitOfWork, credentialNotifier),
      confirmPasswordReset: new ConfirmPasswordReset(
        credentialsUnitOfWork,
        passwordHasher,
        sessionRevoker,
      ),
    },
    audit: {
      recordEvent: new RecordAuditEvent(auditLog, (error: unknown) => {
        // Written to stderr rather than swallowed entirely: a gap in the audit
        // log is itself a security-relevant event, and the sequence gap it
        // leaves is deliberately visible to `verifyChain`.
        process.stderr.write(
          `audit write failed: ${error instanceof Error ? error.message : String(error)}
`,
        );
      }),
      anchor:
        hashAnchor === undefined
          ? undefined
          : new AnchorAuditLog(auditLog, anchorRecords, hashAnchor),
    },
    sessions: {
      issueSession,
      refreshAccessToken,
      logout,
      logoutEverywhere,
      listActiveSessions,
    },
    dispose: async () => {
      await prisma.$disconnect();
      // `disconnect()`, not `quit()`: `quit()` sends a command, which would
      // force the lazy connection this container never used to actually open
      // one just to close it again immediately. A container built but never
      // used to touch a session (this file's own boot smoke test, most unit
      // tests) should be able to shut down without ever having reached Redis.
      redis.disconnect();
    },
  };
}
