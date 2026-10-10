import type {
  RateLimiter,
  RateLimitKey,
  RateLimitResult,
} from "../../application/ports/rate-limiter.js";

/**
 * An unconditionally-permissive RateLimiter adapter.
 *
 * This is NOT a rate limiter — it is the absence of one, given a name that
 * says so. It exists for two purposes only:
 *
 * 1. Tests, where rate limiting would make assertions about use-case behavior
 *    flaky or slow.
 * 2. The Phase-15 placeholder wired as the default adapter in
 *    `apps/api/src/composition-root.ts`, so use cases work before the real
 *    limiter exists.
 *
 * Do not reach for this in production code to "skip" rate limiting. When
 * Phase 15 lands, the composition root swaps this for the real adapter and
 * every use case is protected without changing a line of domain code — that
 * is the point of depending on the `RateLimiter` port instead of this class.
 */
export class AlwaysAllowRateLimiter implements RateLimiter {
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async check(key: RateLimitKey): Promise<RateLimitResult> {
    return {
      allowed: true,
      remaining: 999,
      resetAt: Date.now() + 60_000,
      limit: 1000,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async recordFailure(key: RateLimitKey): Promise<void> {
    // no-op
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async reset(key: RateLimitKey): Promise<void> {
    // no-op
  }
}
