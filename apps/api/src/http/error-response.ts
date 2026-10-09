import { DomainError, toHttpError, type ErrorResponseBody } from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";

export type { ErrorResponseBody };

/** Sends a domain error as an HTTP response. */
export function sendDomainError(reply: FastifyReply, error: DomainError): void {
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
