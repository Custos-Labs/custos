import {
  AccountLockedError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  Result,
  ValidationError,
  asId,
} from "@verixa/shared-kernel";

import {
  InvalidTotpCodeError,
  MfaCodeAlreadyUsedError,
  MfaMethodMissingSecretError,
  MfaMethodNotFoundError,
  MfaMethodStateTransitionError,
  MfaReplayDetectedError,
} from "../../domain/errors.js";
import type { TotpAlgorithm } from "../../domain/services/totp-algorithm.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";

export interface VerifyTotpChallengeCommand {
  readonly methodId: string;
  readonly code: string;
}

export type VerifyTotpChallengeError =
  NotFoundError | ConflictError | AuthenticationError | AccountLockedError | ValidationError;
  | AccountLockedError
  | ValidationError
  | MfaMethodNotFoundError
  | MfaMethodStateTransitionError
  | MfaMethodMissingSecretError
  | InvalidTotpCodeError
  | MfaCodeAlreadyUsedError;

/**
 * Verifies a submitted TOTP code against an active method during login or step-up.
 *
 * Allows a minor configurable clock drift (e.g. ±1 step) but strictly rejects
 * code reuse within the same step. On success, updates the method's lastUsedAt
 * and lastUsedStep to prevent replay.
 */
export class VerifyTotpChallenge {
  constructor(
    private readonly mfaMethodRepository: MfaMethodRepository,
    private readonly totpAlgorithm: TotpAlgorithm,
  ) {}

  async execute(
    command: VerifyTotpChallengeCommand,
  ): Promise<Result<void, VerifyTotpChallengeError>> {
    if (!command.code || command.code.length !== 6) {
      return Result.err(new ValidationError("TOTP code must be 6 digits."));
    }

    const methodId = asId<"MfaMethodId">(command.methodId);
    const method = await this.mfaMethodRepository.findById(methodId);

    if (!method) {
      return Result.err(new NotFoundError("MFA method not found."));
    }

    if (method.status !== "active") {
      return Result.err(new ConflictError("Method is not active."));
      return Result.err(new MfaMethodNotFoundError("MFA method not found."));
    }

    if (method.status !== "active") {
      return Result.err(
        new MfaMethodStateTransitionError(
          method.id,
          method.status,
          "verify",
          "Method is not active.",
        ),
      );
    }

    const now = new Date();
    if (method.isLockedAt(now)) {
      return Result.err(new AccountLockedError("Authentication attempts are rate-limited."));
    }

    if (!method.secret) {
      return Result.err(new ConflictError("MFA method is missing its secret."));
      return Result.err(new MfaMethodMissingSecretError("MFA method is missing its secret."));
    }

    // Verify code, allowing ±1 drift window (30s past or future)
    const matchedStep = await this.totpAlgorithm.verify(method.secret, command.code, 1);

    if (matchedStep === null) {
      const updatedMethod = method.recordFailedAttempt(now);
      await this.mfaMethodRepository.save(updatedMethod);
      return Result.err(new AuthenticationError("Invalid TOTP code."));
      return Result.err(new InvalidTotpCodeError("Invalid TOTP code."));
    }

    try {
      // Record use updates lastUsedAt and enforces replay protection against the matchedStep
      const verifiedMethod = method.recordTotpUse(matchedStep, now);
      await this.mfaMethodRepository.save(verifiedMethod);
      return Result.ok(undefined);
    } catch {
      // Replay detected
      const updatedMethod = method.recordFailedAttempt(now);
      await this.mfaMethodRepository.save(updatedMethod);
      return Result.err(new ConflictError("Code has already been used."));
    } catch (error) {
      if (error instanceof MfaReplayDetectedError) {
        // Replay detected
        const updatedMethod = method.recordFailedAttempt(now);
        await this.mfaMethodRepository.save(updatedMethod);
        return Result.err(new MfaCodeAlreadyUsedError("Code has already been used."));
      }
      throw error;
    }
  }
}
