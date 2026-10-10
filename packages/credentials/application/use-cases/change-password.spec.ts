import { Email, type User } from "@verixa/identity";
import { Result, asId } from "@verixa/shared-kernel";
import { NoopRateLimiter } from "@verixa/shared-kernel/testing";
import {
  AuthenticationError,
  NoopRateLimiter,
  Result,
  ValidationError,
  asId,
} from "@verixa/shared-kernel";
import { AlwaysAllowRateLimiter, Result, asId } from "@verixa/shared-kernel";
import {
  NoopRateLimiter,
  RateLimitExceededError,
  Result,
  asId,
  type RateLimitKey,
  type RateLimitResult,
  type RateLimiter,
} from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Argon2PasswordHasher } from "../../infrastructure/argon2-password-hasher.js";
import { InMemoryCredentialsUnitOfWork } from "../../infrastructure/testing/in-memory-credentials-unit-of-work.js";

import { ChangePassword } from "./change-password.js";
import { RegisterUserWithPassword } from "./register-user-with-password.js";

const FAST = { memoryCost: 64, timeCost: 1, parallelism: 1 };
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely different passphrase";
const ANOTHER_PASSWORD = "yet another password phrase";

describe("ChangePassword (Issue 071)", () => {
  let unitOfWork: InMemoryCredentialsUnitOfWork;
  let hasher: Argon2PasswordHasher;
  let rateLimiter: AlwaysAllowRateLimiter;
  let changePassword: ChangePassword;
  let user: User;

  beforeEach(async () => {
    unitOfWork = new InMemoryCredentialsUnitOfWork();
    hasher = new Argon2PasswordHasher(FAST);
    rateLimiter = new AlwaysAllowRateLimiter();
    changePassword = new ChangePassword(unitOfWork, hasher, rateLimiter);

    // Register a test user
    const registered = await new RegisterUserWithPassword(
      unitOfWork,
      hasher,
      new AlwaysAllowRateLimiter(),
    ).execute({
      email: EMAIL,
      displayName: "Alice",
      password: PASSWORD,
    });
    if (!Result.isOk(registered)) throw new Error("fixture setup failed");

    const email = Email.create(EMAIL);
    if (!Result.isOk(email)) throw new Error("fixture setup failed");
    const found = await unitOfWork.repositories.users.findByEmail(email.value);
    if (found === undefined) throw new Error("fixture setup failed");
    user = found;
  });

  describe("happy path", () => {
    it("changes the password with correct current password", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isOk(result)).toBe(true);
      if (!Result.isOk(result)) return;
      expect(result.value.user.id).toBe(user.id);
    });

    it("new password works for authentication afterward", async () => {
      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      expect(credential).toBeDefined();
      if (credential === undefined) return;

      const matches = await hasher.verify(NEW_PASSWORD, credential.passwordHash);
      expect(matches).toBe(true);
    });

    it("old password no longer works", async () => {
      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      expect(credential).toBeDefined();
      if (credential === undefined) return;

      const matches = await hasher.verify(PASSWORD, credential.passwordHash);
      expect(matches).toBe(false);
    });

    it("clears any account lockout", async () => {
      // Artificially lock the account
      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      if (credential === undefined) throw new Error("fixture setup failed");
      const locked = credential.recordFailedAttempt(
        { threshold: 1, baseDurationMs: 600_000, backoffFactor: 2, maxDurationMs: 600_000 },
        new Date(),
      );
      await unitOfWork.repositories.credentials.save(locked);

      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      const updated = await unitOfWork.repositories.credentials.findByUserId(user.id);
      expect(updated?.failedAttempts).toBe(0);
      expect(updated?.lockedUntil).toBeUndefined();
    });
  });

  describe("re-authentication (current password)", () => {
    it("rejects wrong current password", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong password",
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(AuthenticationError);
      expect(result.error.httpStatusHint).toBe(401);
    });

    it("wrong current password is indistinguishable by message from a failed login", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong password",
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.message).toBe(new AuthenticationError().message);
    });

    it("distinguishes wrong password (401) from malformed input (400) by status only", async () => {
      const wrongPassword = await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong password",
        newPassword: NEW_PASSWORD,
      });
      const malformed = await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong password",
        newPassword: "short", // fails the password policy
      });

      expect(Result.isErr(wrongPassword) && wrongPassword.error.httpStatusHint).toBe(401);
      expect(Result.isErr(malformed) && malformed.error.httpStatusHint).toBe(400);
      if (Result.isErr(malformed)) {
        // The 400 keeps its field errors (correctable input); the 401 carries
        // none — a 401 means re-prompt, not correct-and-retry.
        expect(malformed.error).toBeInstanceOf(ValidationError);
      }
      if (Result.isErr(wrongPassword)) {
        expect(wrongPassword.error).toBeInstanceOf(AuthenticationError);
        expect("fieldErrors" in wrongPassword.error).toBe(false);
      }
    });

    it("does not change password on wrong current", async () => {
      await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong password",
        newPassword: NEW_PASSWORD,
      });

      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      expect(credential).toBeDefined();
      if (credential === undefined) return;

      // Original password still works
      const matches = await hasher.verify(PASSWORD, credential.passwordHash);
      expect(matches).toBe(true);
    });
  });

  describe("password policy validation", () => {
    it("rejects a weak new password without changing the credential", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: "short", // too short
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      if (!(result.error instanceof ValidationError)) return;
      expect(result.error.fieldErrors["password"]).toContain("too_short");

      // Original password still works
      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      if (credential === undefined) return;
      const matches = await hasher.verify(PASSWORD, credential.passwordHash);
      expect(matches).toBe(true);
    });

    it("policy validation happens before current password verification", async () => {
      // Even with a wrong current password, weak password is rejected first
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: "wrong",
        newPassword: "short",
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      if (!(result.error instanceof ValidationError)) return;
      // Password error, not auth error
      expect(result.error.fieldErrors["password"]).toContain("too_short");
    });
  });

  describe("password history — reuse prevention (Issue 072)", () => {
    it("rejects reuse of current password", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: PASSWORD, // same as current
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      if (!(result.error instanceof ValidationError)) return;
      expect(result.error.fieldErrors["password"]).toContain("reused");
    });

    it("accepts a completely new password", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isOk(result)).toBe(true);
    });

    it("rejects reuse of a password from history on second change", async () => {
      // First change: PASSWORD -> NEW_PASSWORD
      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      // Second change: try to reuse the original PASSWORD
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: NEW_PASSWORD,
        newPassword: PASSWORD, // in history now
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      if (!(result.error instanceof ValidationError)) return;
      expect(result.error.fieldErrors["password"]).toContain("reused");
    });

    it("allows a password when history is exhausted (more than N changes)", async () => {
      const policy = { depth: 2 };
      changePassword = new ChangePassword(unitOfWork, hasher, rateLimiter, undefined, policy);

      let current = PASSWORD;
      // Make enough changes to exhaust history beyond depth
      for (let i = 1; i <= 4; i++) {
        const next = `NewPassword${i}`;
        const result = await changePassword.execute({
          userId: user.id,
          currentPassword: current,
          newPassword: next,
        });
        expect(Result.isOk(result)).toBe(true);
        current = next;
      }

      // Now the original password should be out of history and allowed
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: current,
        newPassword: PASSWORD, // very first password, now out of history
      });

      expect(Result.isOk(result)).toBe(true);
    });

    it("maintains password history after successful change", async () => {
      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      expect(credential?.passwordHistory.length).toBeGreaterThan(0);
    });

    it("error message includes history depth", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.message).toContain("5"); // default depth
    });

    it("reuse error includes guidance", async () => {
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error.message).toContain("recently used");
      expect(result.error.message).toContain("choose a password");
    });
  });

  describe("edge cases", () => {
    it("throws for unknown user (internal error)", async () => {
      await expect(
        changePassword.execute({
          userId: asId<"UserId">("00000000-0000-4000-8000-000000000099"),
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toThrow();
    });

    it("throws for user with no credential (internal error)", async () => {
      // Register another user
      const registered = await new RegisterUserWithPassword(
        unitOfWork,
        hasher,
        new AlwaysAllowRateLimiter(),
      ).execute({
        email: "bob@example.com",
        displayName: "Bob",
        password: "bob's password",
      });
      if (!Result.isOk(registered)) throw new Error("fixture setup failed");

      const email = Email.create("bob@example.com");
      if (!Result.isOk(email)) throw new Error("fixture setup failed");
      const bob = await unitOfWork.repositories.users.findByEmail(email.value);
      if (bob === undefined) throw new Error("fixture setup failed");

      // Delete the credential to simulate SSO-only account
      await unitOfWork.repositories.credentials.deleteByUserId(bob.id);

      await expect(
        changePassword.execute({
          userId: bob.id,
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toThrow();
    });

    it("multiple consecutive changes work correctly", async () => {
      let current = PASSWORD;

      for (let i = 1; i <= 3; i++) {
        const next = `NewPassword${i}`;
        const result = await changePassword.execute({
          userId: user.id,
          currentPassword: current,
          newPassword: next,
        });

        expect(Result.isOk(result)).toBe(true);
        current = next;
      }

      // Final state should have new password
      const credential = await unitOfWork.repositories.credentials.findByUserId(user.id);
      if (credential === undefined) return;
      const matches = await hasher.verify(current, credential.passwordHash);
      expect(matches).toBe(true);
    });

    it("original password rejected after change", async () => {
      await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      // Try to change again using old password
      const result = await changePassword.execute({
        userId: user.id,
        currentPassword: PASSWORD, // old password
        newPassword: ANOTHER_PASSWORD,
      });

      expect(Result.isErr(result)).toBe(true);
      if (!Result.isErr(result)) return;
      expect(result.error).toBeInstanceOf(AuthenticationError);
      expect(result.error.httpStatusHint).toBe(401);
    });
  });

  describe("rate limiting (Issue 061)", () => {
    class RecordingRateLimiter implements RateLimiter {
      failures: RateLimitKey[] = [];
      resets: RateLimitKey[] = [];
      checks: RateLimitKey[] = [];
      private failureCounts: Record<string, number> = {};

      constructor(private readonly limit: number = 3) {}

      check(key: RateLimitKey): Promise<RateLimitResult> {
        this.checks.push(key);
        const count = this.failureCounts[key.identifier] ?? 0;
        const allowed = count < this.limit;
        return Promise.resolve({
          allowed,
          remaining: Math.max(0, this.limit - count),
          resetAt: Date.now() + 60_000,
          limit: this.limit,
        });
      }

      recordFailure(key: RateLimitKey): Promise<void> {
        this.failures.push(key);
        this.failureCounts[key.identifier] = (this.failureCounts[key.identifier] ?? 0) + 1;
        return Promise.resolve();
      }

      reset(key: RateLimitKey): Promise<void> {
        this.resets.push(key);
        delete this.failureCounts[key.identifier];
        return Promise.resolve();
      }
    }

    it("limits repeated wrong-current-password attempts", async () => {
      const limiter = new RecordingRateLimiter(3);
      const change = new ChangePassword(unitOfWork, hasher, limiter);

      // Exhaust the budget with wrong current passwords
      for (let i = 0; i < 3; i++) {
        const r = await change.execute({
          userId: user.id,
          currentPassword: "wrong password attempt",
          newPassword: NEW_PASSWORD,
        });
        expect(Result.isErr(r)).toBe(true);
      }

      expect(limiter.failures).toHaveLength(3);
      expect(limiter.failures[0]?.action).toBe("password-change");
      expect(limiter.failures[0]?.identifier).toBe(user.id);

      // The 4th attempt is blocked by rate limiting before password verification
      await expect(
        change.execute({
          userId: user.id,
          currentPassword: "wrong password attempt",
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toThrow(RateLimitExceededError);

      // A correct current password after reset succeeds
      await limiter.reset({ action: "password-change", identifier: user.id });
      const ok = await change.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(Result.isOk(ok)).toBe(true);
    });

    it("resets rate limit on successful password change", async () => {
      const limiter = new RecordingRateLimiter(3);
      const change = new ChangePassword(unitOfWork, hasher, limiter);

      const ok = await change.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(Result.isOk(ok)).toBe(true);
      expect(limiter.resets).toHaveLength(1);
      expect(limiter.resets[0]?.action).toBe("password-change");
      expect(limiter.resets[0]?.identifier).toBe(user.id);
    });

    it("does not record rate limit failure when new password policy validation fails", async () => {
      const limiter = new RecordingRateLimiter(3);
      const change = new ChangePassword(unitOfWork, hasher, limiter, {
        minLength: 10,
        maxLength: 128,
      });

      const result = await change.execute({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: "short",
      });

      expect(Result.isErr(result)).toBe(true);
      expect(limiter.failures).toHaveLength(0);
    });
  });
});
