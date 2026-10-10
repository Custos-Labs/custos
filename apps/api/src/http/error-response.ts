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
import { DomainError, toHttpError, type ErrorResponseBody } from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";

export type { ErrorResponseBody };

/** Sends a domain error as an HTTP response. */
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
  const { status, body } = toHttpError(error);
  void reply.status(status).send(body);
}

/** Sends a generic 500 for anything that is not a `DomainError`. The detail is logged, never returned. */
export function sendUnexpectedError(reply: FastifyReply, error: unknown): void {
  reply.log.error({ err: error }, "unhandled error in request");
  const { status, body } = toHttpError(error);
  void reply.status(status).send(body);
}

/** Routes `error` to the right handler based on whether it is a domain error. */
export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DomainError) {
    sendDomainError(reply, error);
    return;
  }
  sendUnexpectedError(reply, error);
}
