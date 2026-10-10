import {
  AuthenticationError,
  ConflictError,
  DomainError,
  NotFoundError,
} from "@verixa/shared-kernel";

export type MfaMethodAction = "activate" | "disable" | "verify";

/**
 * Thrown when an invalid state transition is attempted on an MfaMethod
 * (e.g. activating an already-active method, disabling an already-disabled method,
 * or attempting to verify with an inactive method).
 */
export class MfaMethodStateTransitionError extends DomainError {
  override readonly code = "MFA_METHOD_INVALID_STATE_TRANSITION";
  override readonly httpStatusHint = 409;
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
  override readonly code = "MFA_REPLAY_DETECTED";
  override readonly httpStatusHint = 409;
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
export class MfaMethodNotFoundError extends NotFoundError {
  override readonly code = "MFA_METHOD_NOT_FOUND";
  override readonly httpStatusHint = 404;
  constructor(message = "MFA method not found.") {
    super(message);
    this.name = "MfaMethodNotFoundError";
  }
}

/** The MFA method is missing its secret. */
export class MfaMethodMissingSecretError extends ConflictError {
  override readonly code = "MFA_METHOD_MISSING_SECRET";
  override readonly httpStatusHint = 409;
  constructor(message = "MFA method is missing its secret.") {
    super(message);
    this.name = "MfaMethodMissingSecretError";
  }
}

/** An invalid or expired TOTP code was submitted. */
export class InvalidTotpCodeError extends AuthenticationError {
  override readonly code = "INVALID_TOTP_CODE";
  override readonly httpStatusHint = 401;
  constructor(message = "Invalid TOTP code.") {
    super(message);
    this.name = "InvalidTotpCodeError";
  }
}

/** The submitted code was already consumed (replay detected). */
export class MfaCodeAlreadyUsedError extends ConflictError {
  override readonly code = "MFA_CODE_ALREADY_USED";
  override readonly httpStatusHint = 409;
  constructor(message = "Code has already been used.") {
    super(message);
    this.name = "MfaCodeAlreadyUsedError";
  }
}

/** The MFA method is not in active status. */
export class MfaMethodNotActiveError extends ConflictError {
  override readonly code = "MFA_METHOD_NOT_ACTIVE";
  override readonly httpStatusHint = 409;
  constructor(message = "Method is not active.") {
    super(message);
    this.name = "MfaMethodNotActiveError";
  }
}
