import { Result, ValidationError } from "@verixa/shared-kernel";

import type { VerificationRequest, VerificationRequestId } from "../../domain/entities/verification-request.js";
import { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import { ProviderCheckResult } from "../dtos/provider-check-result.js";
import type { VerificationProvider } from "../ports/verification-provider.js";
import type { VerificationRequestRepository } from "../ports/verification-request-repository.js";

export interface RunAutomatedCheckCommand {
  readonly requestId: string;
}

export interface RunAutomatedCheckResult {
  readonly request: VerificationRequest;
  readonly providerResult: ProviderCheckResult;
}

export type RunAutomatedCheckError = ValidationError | InvalidStatusTransitionError;

/**
 * Invokes the configured VerificationProvider for a submitted request's evidence,
 * records the ProviderCheckResult, and transitions status from submitted to in_review
 * regardless of outcome (pass, fail, inconclusive, or error/timeout).
 */
export class RunAutomatedCheck {
  constructor(
    private readonly requestRepository: VerificationRequestRepository,
    private readonly verificationProvider: VerificationProvider,
  ) {}

  async execute(
    command: RunAutomatedCheckCommand,
  ): Promise<Result<RunAutomatedCheckResult, RunAutomatedCheckError>> {
    const request = await this.requestRepository.findById(
      command.requestId as VerificationRequestId,
    );
    if (!request) {
      return Result.err(
        new ValidationError(`Verification request with id "${command.requestId}" not found.`),
      );
    }

    let providerResult: ProviderCheckResult;
    try {
      providerResult = this.verificationProvider.check
        ? await this.verificationProvider.check(request)
        : ProviderCheckResult.inconclusive();
    } catch {
      providerResult = ProviderCheckResult.inconclusive();
    }

    const reviewResult = request.startReview();
    if (Result.isErr(reviewResult)) {
      return reviewResult;
    }

    await this.requestRepository.save(reviewResult.value);

    return Result.ok({ request: reviewResult.value, providerResult });
  }
}
