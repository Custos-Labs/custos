import { DomainError, ValidationError } from "../domain/errors.js";

/**
 * The single error response shape every route uses.
 *
 * Fixed deliberately. Clients that have to branch on the *shape* of an error
 * before they can read it end up with per-endpoint parsing, and the endpoint
 * that drifts is the one nobody notices until a client crashes on it.
 */
export interface ErrorResponseBody {
  readonly error: {
    /** Stable, machine-readable. Safe to branch on; `message` is not. */
    readonly code: string;
    /** Human-readable. May be reworded at any time without it being a breaking change. */
    readonly message: string;
    /** Present only for validation failures: which field failed, and why. */
    readonly fields?: Readonly<Record<string, readonly string[]>>;
  };
}

export interface HttpErrorMapping {
  readonly status: number;
  readonly body: ErrorResponseBody;
}

/**
 * Maps any thrown error to an HTTP status and the single response body shape.
 *
 * Framework-agnostic on purpose: `@verixa/authorization`'s routes and
 * `apps/api`'s routes both build their error responses through this mapping,
 * while Fastify reply handling stays in the adapter layer.
 *
 * Only `DomainError` subclasses are translated with detail. Anything else is
 * a bug or an infrastructure failure and is deliberately *not* translated:
 * its message can contain anything, so returning it hands an attacker
 * reconnaissance for free.
 */
export function toHttpError(error: unknown): HttpErrorMapping {
  if (error instanceof DomainError) {
    return {
      status: error.httpStatusHint,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error instanceof ValidationError && Object.keys(error.fieldErrors).length > 0
            ? { fields: error.fieldErrors }
            : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    },
  };
}
