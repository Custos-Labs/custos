import { createId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { VerificationRequest } from "../../domain/entities/verification-request.js";
import { VerificationType } from "../../domain/value-objects/verification-type.js";
import { InMemoryVerificationRequestRepository } from "../../infrastructure/testing/in-memory-verification-request-repository.js";
import { ProviderCheckResult } from "../dtos/provider-check-result.js";
import type { VerificationProvider } from "../ports/verification-provider.js";

import { RunAutomatedCheck } from "./run-automated-check.js";

class FakeVerificationProvider implements VerificationProvider {
  constructor(public resultToReturn: ProviderCheckResult | Error) {}

  checkDocument(): Promise<ProviderCheckResult> {
    if (this.resultToReturn instanceof Error) {
      return Promise.reject(this.resultToReturn);
    }
    return Promise.resolve(this.resultToReturn);
  }

  checkLiveness(): Promise<ProviderCheckResult> {
    if (this.resultToReturn instanceof Error) {
      return Promise.reject(this.resultToReturn);
    }
    return Promise.resolve(this.resultToReturn);
  }

  check(): Promise<ProviderCheckResult> {
    if (this.resultToReturn instanceof Error) {
      return Promise.reject(this.resultToReturn);
    }
    return Promise.resolve(this.resultToReturn);
  }
}

describe("RunAutomatedCheck", () => {
  let repository: InMemoryVerificationRequestRepository;
  let request: VerificationRequest;

  beforeEach(async () => {
    repository = new InMemoryVerificationRequestRepository();
    const initial = VerificationRequest.request({
      subjectUserId: createId<"VerificationSubjectId">(),
      organizationId: createId<"VerificationOrganizationId">(),
      type: VerificationType.reconstitute("identity-document"),
    });
    const submitResult = initial.submit();
    if (!Result.isOk(submitResult)) throw new Error("fixture setup failed");
    request = submitResult.value;
    await repository.save(request);
  });

  it("records a passing provider result and transitions to in_review", async () => {
    const providerResult = ProviderCheckResult.passed("ref-123", 0.95);
    const provider = new FakeVerificationProvider(providerResult);
    const useCase = new RunAutomatedCheck(repository, provider);

    const result = await useCase.execute({ requestId: request.id });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.providerResult).toEqual(providerResult);
  });

  it("records a failing provider result and transitions to in_review", async () => {
    const providerResult = ProviderCheckResult.failed("ref-123", 0.9);
    const provider = new FakeVerificationProvider(providerResult);
    const useCase = new RunAutomatedCheck(repository, provider);

    const result = await useCase.execute({ requestId: request.id });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.providerResult).toEqual(providerResult);
  });

  it("records an inconclusive provider result and transitions to in_review", async () => {
    const providerResult = ProviderCheckResult.inconclusive("ref-123");
    const provider = new FakeVerificationProvider(providerResult);
    const useCase = new RunAutomatedCheck(repository, provider);

    const result = await useCase.execute({ requestId: request.id });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.providerResult).toEqual(providerResult);
  });

  it("catches provider errors/timeouts, records error annotation, and routes to in_review", async () => {
    const provider = new FakeVerificationProvider(new Error("Provider timeout"));
    const useCase = new RunAutomatedCheck(repository, provider);

    const result = await useCase.execute({ requestId: request.id });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value.request.status.value).toBe("in_review");
    expect(result.value.providerResult.outcome).toBe("inconclusive");
  });
});
