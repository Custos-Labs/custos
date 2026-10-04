import type { Result, ValidationError } from "@verixa/shared-kernel";

/** The claims an access token carries. Deliberately minimal — see `JwtTokenSigner`. */
export interface AccessTokenPayload {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Signs and verifies access tokens. A **port**: the application layer knows
 * it needs *a* signer, not that it is backed by a JWT — see
 * `docs/guides/domain-modeling.md`.
 *
 * `verify` is not called by any use case in this package yet (Issue 095's
 * dependency chain has no route layer to guard); it exists now, alongside a
 * real adapter and its own tests, because Phase 12's route guard is the
 * consumer and should not have to invent the interface it needs — the same
 * "domain skeleton ahead of its delivery mechanism" pattern as
 * `packages/identity`'s `Invitation`.
 */
export interface TokenSigner {
  /** Signs `payload`, expiring `ttlSeconds` after signing. */
  sign(payload: AccessTokenPayload, ttlSeconds: number): Promise<string>;
  /**
   * Verifies `token`'s signature and expiry, returning its payload.
   * Returns a `ValidationError` (never throws) for a malformed, expired, or
   * badly-signed token — an invalid token presented by a client is an
   * expected outcome, not a bug.
   */
  verify(token: string): Promise<Result<AccessTokenPayload, ValidationError>>;
import type { Result } from "@verixa/shared-kernel";

import type { TokenVerificationError } from "../../domain/errors/token-verification-error.js";
import type { SessionId } from "../../domain/value-objects/session-id.js";

/**
 * The claims a caller asks to embed in a freshly minted access token.
 *
 * This is the *input* shape, not the wire shape: it names things in domain
 * terms (`subject`, `sessionId`) and leaves the registered JWT claim names
 * (`sub`, `sid`, `iat`, `exp`) and the `kid` header to the adapter. Keeping the
 * mapping on the infrastructure side of this port is what lets the token format
 * change — different claim names, a switch away from JWT entirely — without any
 * use case that issues tokens having to change with it.
 */
export interface AccessTokenInput {
  /** The authenticated principal — a user id. Becomes the `sub` claim. */
  readonly subject: string;
  /** The session this token belongs to. Becomes the `sid` claim. */
  readonly sessionId: SessionId;
  /** Active tenant/organization, when the caller is scoped to one. `orgId`. */
  readonly organizationId?: string;
  /**
   * Coarse role hints, present so a downstream service can make a cheap
   * first-pass authorization decision without a database round trip. They are
   * a *hint*, never the source of truth — the authoritative check still runs
   * against the RBAC/ABAC engines in later phases. Kept minimal on purpose: an
   * access token is a bearer credential that travels widely and is only as
   * fresh as its `exp`, so stuffing a full permission set into it both bloats
   * every request and makes a revoked grant linger until the token expires.
   */
  readonly roles?: readonly string[];
}

/**
 * The verified, decoded contents of an access token the adapter has already
 * checked: correctly signed by a key it trusts, and not expired.
 */
export interface VerifiedAccessToken {
  readonly subject: string;
  readonly sessionId: SessionId;
  readonly organizationId?: string;
  readonly roles: readonly string[];
  /** The `kid` the token was actually verified under — useful for audit. */
  readonly keyId: string;
  readonly issuedAt: Date;
import type { SessionUserId } from "../../domain/entities/session.js";

/** An access token as produced by a `TokenSigner`. */
export interface IssuedAccessToken {
  /** The signed, encoded token (a JWT, for the real adapter) a client presents on subsequent requests. */
  readonly token: string;
  /** Unique per issuance (a JWT `jti`) — what a `RevocationList` denylists. Never reused across tokens. */
  readonly tokenId: string;
  readonly expiresAt: Date;
}

/**
 * Mints and verifies stateless access tokens.
 *
 * "Stateless" is the whole point: {@link verify} answers "is this a genuine,
 * unexpired token this system issued?" from the token and the verifier's keys
 * alone, with no store lookup. That is what makes access-token verification
 * cheap enough to run on every request in every service. The price is that a
 * token stays valid until it expires even if the session behind it should die
 * sooner — which is exactly the gap the revocation deny-list (Issue 088) and
 * short token lifetimes close, not this port.
 *
 * Verification errors come back as a {@link Result}, not a thrown exception:
 * an invalid or expired token is an ordinary, expected outcome on an auth
 * boundary (every unauthenticated request produces one), not an exceptional
 * condition. See `docs/guides/use-cases.md` on Result-vs-throw.
 */
export interface TokenSigner {
  /** Signs `input` into a compact JWS string using the current signing key. */
  sign(input: AccessTokenInput): Promise<string>;

  /**
   * Verifies and decodes `token`. Returns the decoded claims on success, or a
   * {@link TokenVerificationError} explaining the rejection (unknown key,
   * bad signature, expiry, malformed input).
   */
  verify(token: string): Promise<Result<VerifiedAccessToken, TokenVerificationError>>;
 * Signs access tokens on behalf of a user.
 *
 * Kept to exactly the one operation these use cases need. Verifying a
 * presented token is a separate concern (an HTTP-layer authentication guard,
 * outside Phase 05's session-lifecycle scope) and does not belong on this
 * port just because the same JWT library would implement both.
 *
 * Takes `userId` alone, not `sessionId`: the access token this issues is a
 * self-contained, stateless JWT, and binding it to a session id it could not
 * yet have (issuance signs the token *before* the session exists — see
 * `IssueSession`) would need either a two-step issue-then-patch dance or a
 * pre-allocated id threaded in for no behavioural benefit. "Log out this
 * specific device" is enforced at the refresh-token/session level instead
 * (`Logout`, `LogoutEverywhere`), which is where the codebase's session
 * revocation already lives.
 */
export interface TokenSigner {
  issueAccessToken(params: { userId: SessionUserId; now: Date }): Promise<IssuedAccessToken>;
}
