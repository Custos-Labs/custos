import { Result } from "@verixa/shared-kernel";

import type { MfaChallenge, MfaChallengeId } from "../../domain/entities/mfa-challenge.js";

export interface MfaChallengeRepository {
  findById(id: MfaChallengeId): Promise<MfaChallenge | null>;
  save(challenge: MfaChallenge): Promise<void>;
}

/**
 * What this use case needs from session issuance, declared as a port rather
 * than importing `@verixa/sessions` directly.
 *
 * Two reasons, not one. First, `packages/mfa` must not depend on another
 * bounded context's concrete implementation — see
 * `docs/guides/domain-modeling.md` ("Package encapsulation"); the real
 * `IssueSession` use case is wired in by the composition root, which is the
 * only place allowed to know both contexts exist. Second, `packages/sessions`
 * is currently quarantined (see `docs/QUARANTINE.md`) and does not build, so
 * importing its types directly would make this package's build depend on
 * sessions' build succeeding — which it does not, independent of anything
 * this file does.
 *
 * The shape mirrors `IssueSessionCommand`/`IssueSessionResult` closely enough
 * that wiring the real `IssueSession` instance to this port in the
 * composition root is a direct pass-through, once sessions is unquarantined.
 */
export interface SessionIssuer {
  execute(command: SessionIssuerCommand): Promise<Result<unknown, unknown>>;
}

export interface SessionIssuerCommand {
  readonly userId: string;
  readonly metadata: {
    readonly ipAddress: string;
    readonly userAgent: string;
  };
  readonly now?: Date;
}

export type ConsumeMfaChallengeError =
  "CHALLENGE_NOT_FOUND" | "CHALLENGE_EXPIRED" | "CHALLENGE_ALREADY_CONSUMED";

export interface ConsumeMfaChallengeCommand {
  readonly challengeId: MfaChallengeId;
  readonly issueSessionCommand: SessionIssuerCommand;
  readonly now?: Date;
}

/**
 * Exchanges a successfully-verified MFA challenge for a session.
 *
 * The challenge is single-use and time-bounded: `findById` -> validate ->
 * `consume` -> `save` happens before session issuance is even attempted, so
 * a second attempt against the same challenge (replay, or a retried request
 * racing a first one) is rejected before it can mint a second session. This
 * ordering is the enforcement; there is no separate lock.
 */
export class ConsumeMfaChallenge {
  constructor(
    private readonly challengeRepository: MfaChallengeRepository,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(
    command: ConsumeMfaChallengeCommand,
  ): Promise<Result<unknown, unknown> | Result<never, ConsumeMfaChallengeError>> {
    const now = command.now ?? new Date();
    const challenge = await this.challengeRepository.findById(command.challengeId);
    if (!challenge) {
      return Result.err("CHALLENGE_NOT_FOUND");
    }
    if (challenge.isExpired(now)) {
      return Result.err("CHALLENGE_EXPIRED");
    }
    if (challenge.isConsumed) {
      return Result.err("CHALLENGE_ALREADY_CONSUMED");
    }

    const consumed = challenge.consume(now);
    await this.challengeRepository.save(consumed);

    return this.sessionIssuer.execute(command.issueSessionCommand);
  }
}
