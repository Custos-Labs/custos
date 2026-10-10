import { DomainError } from "@verixa/shared-kernel";

export type MfaMethodAction = "activate" | "disable" | "verify";

/**
 * Thrown when an invalid state transition is attempted on an MfaMethod
 * (e.g. activating an already-active method, disabling an already-disabled method,
 * or attempting to verify with an inactive method).
 */
export class MfaMethodStateTransitionError extends DomainError {
  readonly code = "MFA_METHOD_INVALID_STATE_TRANSITION";
  readonly httpStatusHint = 409;
  readonly methodId: string;
  readonly currentStatus: string;
  readonly attemptedAction: MfaMethodAction;

  constructor(
    methodId: string,
    currentStatus: string,
    attemptedAction: MfaMethodAction,
    message?: string,
  ) {
    super(
      message ??
        `Cannot ${attemptedAction} MFA method "${methodId}": method is currently ${currentStatus}.`,
    );
    this.methodId = methodId;
    this.currentStatus = currentStatus;
    this.attemptedAction = attemptedAction;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & {
    methodId: string;
    currentStatus: string;
    attemptedAction: MfaMethodAction;
  } {
    return {
      ...super.toJSON(),
      methodId: this.methodId,
      currentStatus: this.currentStatus,
      attemptedAction: this.attemptedAction,
    };
  }
}

/**
 * Thrown when a replayed TOTP step is detected.
 */
export class MfaReplayDetectedError extends DomainError {
  readonly code = "MFA_REPLAY_DETECTED";
  readonly httpStatusHint = 409;
  readonly methodId: string;
  readonly attemptedStep: number;
  readonly lastUsedStep: number;

  constructor(methodId: string, attemptedStep: number, lastUsedStep: number, message?: string) {
    super(
      message ??
        `Replay detected: step ${attemptedStep} has already been consumed (last used step: ${lastUsedStep}).`,
    );
    this.methodId = methodId;
    this.attemptedStep = attemptedStep;
    this.lastUsedStep = lastUsedStep;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & {
    methodId: string;
    attemptedStep: number;
    lastUsedStep: number;
  } {
    return {
      ...super.toJSON(),
      methodId: this.methodId,
      attemptedStep: this.attemptedStep,
      lastUsedStep: this.lastUsedStep,
    };
  }
}

/** The requested MFA method does not exist. */
export class MfaMethodNotFoundError extends DomainError {
  readonly code = "MFA_METHOD_NOT_FOUND";
  readonly httpStatusHint = 404;
}

/** The MFA method is missing its secret. */
export class MfaMethodMissingSecretError extends DomainError {
  readonly code = "MFA_METHOD_MISSING_SECRET";
  readonly httpStatusHint = 409;
}

/** An invalid or expired TOTP code was submitted. */
export class InvalidTotpCodeError extends DomainError {
  readonly code = "INVALID_TOTP_CODE";
  readonly httpStatusHint = 401;
}

/** The submitted code was already consumed (replay detected). */
export class MfaCodeAlreadyUsedError extends DomainError {
  readonly code = "MFA_CODE_ALREADY_USED";
  readonly httpStatusHint = 409;
}
import { DomainError } from "@verixa/shared-kernel";

/** The requested MFA method does not exist. */
export class MfaMethodNotFoundError extends DomainError {
  readonly code = "MFA_METHOD_NOT_FOUND";
  readonly httpStatusHint = 404;
}

/** The MFA method is not in active status. */
export class MfaMethodNotActiveError extends DomainError {
  readonly code = "MFA_METHOD_NOT_ACTIVE";
  readonly httpStatusHint = 409;
}

/** The MFA method is missing its secret. */
export class MfaMethodMissingSecretError extends DomainError {
  readonly code = "MFA_METHOD_MISSING_SECRET";
  readonly httpStatusHint = 409;
}

/** An invalid or expired TOTP code was submitted. */
export class InvalidTotpCodeError extends DomainError {
  readonly code = "INVALID_TOTP_CODE";
  readonly httpStatusHint = 401;
}
