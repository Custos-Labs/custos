import {
  DomainError,
  RateLimitExceededError,
  toHttpError,
  type ErrorResponseBody as SharedErrorResponseBody,
} from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";

export interface ErrorResponseBody {
  readonly error: SharedErrorResponseBody["error"] & {
    readonly retryAfter?: number;
  };
}

/** Sends a domain error as an HTTP response. */
export function sendDomainError(reply: FastifyReply, error: DomainError): void {
  const retryAfter =
    error instanceof RateLimitExceededError
      ? Math.max(0, Math.ceil((error.resetAt - Date.now()) / 1000))
      : undefined;

  const { status, body } = toHttpError(error);
  const responseBody: ErrorResponseBody = {
    error: {
      ...body.error,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  };

  if (retryAfter !== undefined) {
    void reply.header("Retry-After", String(retryAfter));
  }

  void reply.status(status).send(responseBody);
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
