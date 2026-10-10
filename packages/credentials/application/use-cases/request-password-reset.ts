import { Email } from "@verixa/identity";
import {
  RateLimitExceededError,
  type RateLimiter,
  type RateLimitKey,
  Result,
  Result,
  RateLimitExceededError,
  type RateLimiter,
  type RateLimitKey,
  type ValidationError,
} from "@verixa/shared-kernel";

import { PasswordResetToken } from "../../domain/entities/password-reset-token.js";
import type { CredentialNotifier } from "../ports/credential-notifier.js";
import type { CredentialsUnitOfWork } from "../ports/credentials-unit-of-work.js";

export interface RequestPasswordResetCommand {
  readonly email: string;
  /**
   * Caller identifier (e.g. client IP address, session ID, or user agent).
   * When provided, the rate-limit key partitions by both recipient and requester,
   * preventing an external caller from exhausting or clearing another requester's quota.
   */
  readonly requesterId?: string;
  readonly requester?: string;
}

export interface RequestPasswordResetResult {
  /**
   * Whether a token was actually issued.
   *
   * **Must not reach the client.** Issue 069's acceptance criterion asks that
   * token generation be "verified via internal event, not response", and this
   * is that: the HTTP response is identical either way, so a test has to
   * observe something the response does not carry.
   */
  readonly issued: boolean;
}

/**
 * Starts a password reset, and says the same thing whether or not the account
 * exists.
 *
 * This is the third place in the package applying one rule, and the clearest
 * illustration of why it is a rule rather than a login-form quirk: a reset
 * endpoint that reports "no account with that address" is a *better*
 * enumeration oracle than the login form, because it needs no password guess
 * at all. One request per address, read the response, done.
 *
 * So the caller always gets success. Whether anything happened is visible
 * only to the system: a token row, a delivered email, an audit entry.
 *
 * ## Rate limiting
 *
 * The rate limiter is consulted at the start via the {@link RateLimiter} port.
 * To prevent cross-caller denial of service (where an attacker exhausts the reset
 * budget for a victim's email address) and counter manipulation, the rate limit key
 * is bound to both the email address and the requester identifier (e.g. source IP
 * or session id) when supplied.
 *
 * Unlike authentication failure counters which reset upon a successful login, the
 * password reset request counter is NOT reset on success. Resetting on success would
 * allow an attacker or script targeting an existing account to send unlimited reset
 * emails (mail-bombing) by simply having each request succeed, or clear the accumulated
 * budget for other requesters.
 *
 * If not allowed, a {@link RateLimitExceededError} is thrown immediately.
 *
 * ## Abuse control and mail-bombing
 *
 * Binding the rate limit key to the requester prevents an external actor from
 * exhausting a legitimate user's reset quota. Per-recipient ceilings or global
 * IP throttling may additionally be layered by rate limiting middleware / gateways.
 */
export class RequestPasswordReset {
  constructor(
    private readonly unitOfWork: CredentialsUnitOfWork,
    private readonly notifier: CredentialNotifier,
    private readonly rateLimiter: RateLimiter,
    private readonly ttlMs?: number,
  ) {}

  async execute(
    command: RequestPasswordResetCommand,
  ): Promise<Result<RequestPasswordResetResult, ValidationError>> {
    // 1. Check rate limit BEFORE any other logic.
    // Bind key to both email and requester (if provided) to isolate budgets across callers.
    const requester = command.requesterId ?? command.requester;
    const rateLimitKey: RateLimitKey = {
      action: "password-reset",
      identifier: requester ? `${command.email}:${requester}` : command.email,
    };

    const limitResult = await this.rateLimiter.check(rateLimitKey);
    if (!limitResult.allowed) {
      throw new RateLimitExceededError(rateLimitKey, limitResult.resetAt, limitResult.limit);
    }

    const emailResult = Email.create(command.email);
    if (Result.isErr(emailResult)) {
      return Result.ok({ issued: false });
    }

    const now = new Date();

    const delivery = await this.unitOfWork.run(async (repositories) => {
      const user = await repositories.users.findByEmail(emailResult.value);
      if (user === undefined) {
        return undefined;
      }

      // No credential means no password to reset — an SSO-only or
      // passkey-only account. Issuing a token would let someone *create* a
      // password on an account deliberately configured not to have one,
      // which is a privilege escalation dressed as a convenience.
      const credential = await repositories.credentials.findByUserId(user.id);
      if (credential === undefined) {
        return undefined;
      }

      // Retiring outstanding tokens is a security requirement here rather
      // than housekeeping. Each of these is account takeover in a URL, and
      // several live ones at once multiply the surface for no benefit.
      await repositories.passwordResetTokens.invalidateOutstandingForUser(user.id, now);

      const issued = PasswordResetToken.issue({
        userId: user.id,
        ...(this.ttlMs === undefined ? {} : { ttlMs: this.ttlMs }),
        now,
      });
      await repositories.passwordResetTokens.save(issued.token);

      return { rawToken: issued.rawToken, expiresAt: issued.token.expiresAt };
    });

    if (delivery === undefined) {
      return Result.ok({ issued: false });
    }

    // After the commit, and its failure is swallowed — same reasoning as
    // `RequestEmailVerification`. A mail outage surfacing as an error would
    // tell the caller an account exists, since only a real account reaches
    // this line.
    try {
      await this.notifier.sendPasswordReset({
        email: emailResult.value.value,
        rawToken: delivery.rawToken,
        expiresAt: delivery.expiresAt,
      });
    } catch {
      // Intentionally ignored. See above.
    }

    // Note: We deliberately do NOT reset the rate limiter counter on success.
    // Resetting on success would allow unthrottled mail-bombing against existing accounts
    // and would allow one caller to clear accumulated abuse counters.

    return Result.ok({ issued: true });
  }
}
