import { DomainError } from "@verixa/shared-kernel";

/**
 * Base class for authorization domain failures. Carries an HTTP status hint so
 * interface adapters can translate without guessing.
 */
export class AuthorizationError extends DomainError {
  readonly code: string;
  readonly httpStatusHint: number;

  constructor(code: string, message?: string, httpStatusHint?: number) {
    super(message ?? code);
    this.code = code;
    this.httpStatusHint =
      httpStatusHint ??
      (code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : 403);
  }
}
