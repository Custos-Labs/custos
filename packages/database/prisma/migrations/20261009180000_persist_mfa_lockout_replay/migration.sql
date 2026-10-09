-- Persist MFA lockout and replay state (Issue 100).
--
-- MfaMethod carries failedAttempts, lockedUntil and lastUsedStep, and the
-- TOTP use cases depend on all three across requests: VerifyTotpChallenge
-- locks out after repeated failures (isLockedAt / recordFailedAttempt) and
-- rejects replayed steps (recordTotpUse). Until now the mfa_methods table
-- had no columns for them, so MfaMethodMapper reset them on every
-- rehydration — the lockout never survived a request and the replay
-- rejection never survived a restart, while docs/security/mfa-design.md
-- states both guarantees in absolute terms.
--
-- Backfill is safe: existing rows get the same zero state the mapper used to
-- synthesize (0 attempts, no lock, no used step).
ALTER TABLE "mfa_methods"
  ADD COLUMN "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(3),
  ADD COLUMN "last_used_step" INTEGER;
