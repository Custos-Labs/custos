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
