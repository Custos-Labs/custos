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

  static create(
    props: SessionExpiryPolicyProps,
  ): Result<SessionExpiryPolicy, ValidationError> {
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
      return Result.err(
        new ValidationError("Invalid session expiry policy.", fieldErrors),
      );
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
import { ValidationError } from "@verixa/shared-kernel";

export type ExpiryMode = "sliding" | "absolute";

interface SessionExpiryPolicyProps {
  readonly mode: ExpiryMode;
  readonly durationMs: number;
}

/**
 * A configurable session expiry policy supporting two modes:
 *
 * - **Sliding**: Each `touch()` extends `expiresAt` forward by the policy's
 *   configured duration from "now". Feels seamless to users but can persist
 *   indefinitely under continuous activity, potentially violating compliance
 *   requirements that bound maximum session lifetime.
 *
 * - **Absolute**: A hard cutoff set at session creation that `touch()` never
 *   moves. User activity is tracked (via `lastSeenAt`) but doesn't grant
 *   extra time. Guarantees a bounded maximum session lifetime at the cost of
 *   forced re-login even for active users once the cutoff passes.
 *
 * ## Design rationale
 *
 * This value object embeds the expiry behavior so that a `Session` entity's
 * `touch()` method can be genuinely pluggable and testable against either
 * mode, without hardcoding one strategy. The policy is immutable and
 * compared by value, which is the defining property of value objects.
 */
export class SessionExpiryPolicy {
  readonly mode: ExpiryMode;
  readonly durationMs: number;

  private constructor(props: SessionExpiryPolicyProps) {
    this.mode = props.mode;
    this.durationMs = props.durationMs;
  }

  /**
   * Creates a sliding-expiry policy: each `touch()` resets `expiresAt` to
   * now + `durationMs`.
   *
   * @param durationMs - Duration in milliseconds; must be positive.
   * @returns The created policy, or an error if validation fails.
   */
  static sliding(durationMs: number): SessionExpiryPolicy {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ValidationError(
        `Sliding policy duration must be a positive number, got ${durationMs}`,
        { durationMs: ["must_be_positive_number"] },
      );
    }

    return new SessionExpiryPolicy({ mode: "sliding", durationMs });
  }

  /**
   * Creates an absolute-expiry policy: `expiresAt` is set at session
   * creation and never changes, regardless of `touch()` calls.
   *
   * @param durationMs - Duration in milliseconds from session creation;
   *   must be positive.
   * @returns The created policy, or an error if validation fails.
   */
  static absolute(durationMs: number): SessionExpiryPolicy {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ValidationError(
        `Absolute policy duration must be a positive number, got ${durationMs}`,
        { durationMs: ["must_be_positive_number"] },
      );
    }

    return new SessionExpiryPolicy({ mode: "absolute", durationMs });
  }

  /**
   * Computes the new `expiresAt` for the given `previousExpiresAt` when
   * `touch()` is called at `touchedAt`.
   *
   * - **Sliding**: returns `touchedAt + durationMs` (activity extends expiry).
   * - **Absolute**: returns `previousExpiresAt` unchanged (activity ignored).
   */
  computeNewExpiresAt(previousExpiresAt: Date, touchedAt: Date): Date {
    if (this.mode === "sliding") {
      return new Date(touchedAt.getTime() + this.durationMs);
    }

    // Absolute mode: expiresAt never changes
    return previousExpiresAt;
  }

  /**
   * Whether this policy is equal to another, by value.
   * Two policies are equal if they have the same mode and duration.
   */
  equals(other: SessionExpiryPolicy): boolean {
    return this.mode === other.mode && this.durationMs === other.durationMs;
  }
}
