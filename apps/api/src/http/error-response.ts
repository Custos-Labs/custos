import { DomainError, RateLimitExceededError, ValidationError } from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";

/**
 * The single response shape every error uses.
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
    /** Present only for 429s: seconds until the client may retry. */
    readonly retryAfter?: number;
  };
}

/**
 * Sends a domain error as an HTTP response.
 *
 * The status comes from `httpStatusHint` on the error itself, so routes do
 * not each maintain a switch mapping error classes to status codes — the
 * classic place where two endpoints quietly disagree about what a conflict
 * is.
 *
 * Only `DomainError` subclasses reach here. Anything else is a bug or an
 * infrastructure failure, and is deliberately *not* translated: see
 * {@link sendUnexpectedError}.
 */
export function sendDomainError(reply: FastifyReply, error: DomainError): void {
  const retryAfter =
    error instanceof RateLimitExceededError
      ? Math.max(0, Math.ceil((error.resetAt - Date.now()) / 1000))
      : undefined;

  const body: ErrorResponseBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error instanceof ValidationError && Object.keys(error.fieldErrors).length > 0
        ? { fields: error.fieldErrors }
        : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  };

  if (retryAfter !== undefined) {
    void reply.header("Retry-After", String(retryAfter));
  }

  void reply.status(error.httpStatusHint).send(body);
}

/**
 * Sends a generic 500 for anything that is not a `DomainError`.
 *
 * The detail is logged, never returned. An unexpected failure is by
 * definition one nobody anticipated, so its message can contain anything — a
 * connection string, a SQL fragment naming a column, a stack trace exposing
 * paths. Returning it hands an attacker reconnaissance for free, and gives a
 * legitimate client nothing it can act on either.
 *
 * `DomainError` messages *are* returned, because those are written for
 * callers and say only what the caller already knows.
 */
export function sendUnexpectedError(reply: FastifyReply, error: unknown): void {
  reply.log.error({ err: error }, "unhandled error in request");

  const body: ErrorResponseBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    },
  };

  void reply.status(500).send(body);
}

/** Routes `error` to the right handler based on whether it is a domain error. */
export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DomainError) {
    sendDomainError(reply, error);
    return;
  }
  sendUnexpectedError(reply, error);
}
