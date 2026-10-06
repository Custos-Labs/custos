import { Result, ValidationError } from "@verixa/shared-kernel";

interface SessionExpiryPolicyProps {
  /** How long a refresh token is valid for after it is issued. */
  readonly refreshTokenTtlMs: number;
  /** How long an access token is valid for after it is issued. */
  readonly accessTokenTtlMs: number;
  /**
   * Absolute cap on a session's lifetime, measured from when it was opened.
   * Unlike {@link idleTimeoutMs}, this cannot be extended by activity — it is
   * the backstop against a session (and its rotating refresh tokens) living
   * forever just because the user keeps using it.
   */
  readonly absoluteLifetimeMs: number;
  /**
   * How long a session may go without activity before it is treated as
   * expired, independent of {@link absoluteLifetimeMs}. Checked against
   * `Session.lastSeenAt`, not `createdAt`.
   */
  readonly idleTimeoutMs: number;
}

/**
 * Configuration for how long sessions, access tokens and refresh tokens
 * live. Kept as a value object rather than constants sprinkled through the
 * use cases so a deployment can tune session lifetime without a code change,
 * the same reasoning as `LockoutPolicy` in `packages/credentials`.
 */
export class SessionExpiryPolicy {
  readonly refreshTokenTtlMs: number;
  readonly accessTokenTtlMs: number;
  readonly absoluteLifetimeMs: number;
  readonly idleTimeoutMs: number;

  private constructor(props: SessionExpiryPolicyProps) {
    this.refreshTokenTtlMs = props.refreshTokenTtlMs;
    this.accessTokenTtlMs = props.accessTokenTtlMs;
    this.absoluteLifetimeMs = props.absoluteLifetimeMs;
    this.idleTimeoutMs = props.idleTimeoutMs;
  }

  static create(props: SessionExpiryPolicyProps): Result<SessionExpiryPolicy, ValidationError> {
    const fieldErrors: Record<string, string[]> = {};

    for (const [field, value] of Object.entries(props)) {
      if (!Number.isFinite(value) || value <= 0) {
        fieldErrors[field] = ["must be a positive number of milliseconds"];
      }
    }

    if (
      Number.isFinite(props.accessTokenTtlMs) &&
      Number.isFinite(props.refreshTokenTtlMs) &&
      props.accessTokenTtlMs > props.refreshTokenTtlMs
    ) {
      fieldErrors["accessTokenTtlMs"] = [
        ...(fieldErrors["accessTokenTtlMs"] ?? []),
        "must not be longer than refreshTokenTtlMs",
      ];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Invalid session expiry policy.", fieldErrors));
    }

    return Result.ok(new SessionExpiryPolicy(props));
  }

  /**
   * Sensible defaults for a first deployment: short-lived access tokens (15
   * minutes) so a leaked one has a small blast radius, refresh tokens good
   * for 30 days so a user doesn't have to re-authenticate constantly, a
   * 7-day idle timeout, and a 30-day absolute cap matching the refresh
   * token's own lifetime (there is no point in one outliving the other).
   */
  static default(): SessionExpiryPolicy {
    const result = SessionExpiryPolicy.create({
      accessTokenTtlMs: 15 * 60 * 1000,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      absoluteLifetimeMs: 30 * 24 * 60 * 60 * 1000,
      idleTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    });

    if (Result.isErr(result)) {
      // Unreachable for the literal, known-good defaults above — guarded so
      // a future edit to the defaults that breaks validation fails loudly at
      // the call site instead of silently returning an invalid policy.
      throw new Error(`Default SessionExpiryPolicy is invalid: ${result.error.message}`);
    }

    return result.value;
  }

  /** The absolute expiry timestamp for a session opened at `openedAt`. */
  absoluteExpiryFrom(openedAt: Date): Date {
    return new Date(openedAt.getTime() + this.absoluteLifetimeMs);
  }

  /** The expiry timestamp for a refresh token issued at `issuedAt`. */
  refreshTokenExpiryFrom(issuedAt: Date): Date {
    return new Date(issuedAt.getTime() + this.refreshTokenTtlMs);
  }

  /** Whether a session last seen at `lastSeenAt` has gone idle as of `now`. */
  isIdleExpired(lastSeenAt: Date, now: Date): boolean {
    return now.getTime() - lastSeenAt.getTime() >= this.idleTimeoutMs;
  }
}
