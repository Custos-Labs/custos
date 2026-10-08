import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { DomainError, ValidationError } from "@verixa/shared-kernel";
import { sendDomainError, sendUnexpectedError, sendError } from "./error-response.js";

function createMockReply(): {
  reply: FastifyReply;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ send });
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const reply = {
    status,
    send,
    log,
  } as unknown as FastifyReply;

  return { reply, status, send };
}

describe("error-response helpers", () => {
  it("produces 400 and a fields object for a ValidationError with field errors", () => {
    const { reply, status, send } = createMockReply();
    const validationError = new ValidationError({
      message: "Validation failed",
      fieldErrors: { email: ["Invalid email format"] },
    });

    sendDomainError(reply, validationError);

    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      error: {
        code: validationError.code,
        message: validationError.message,
        fields: { email: ["Invalid email format"] },
      },
    });
  });

  it("omits fields for a DomainError without field errors", () => {
    const { reply, status, send } = createMockReply();
    const domainError = new DomainError({
      code: "NOT_FOUND",
      message: "Resource not found",
      httpStatusHint: 404,
    });

    sendDomainError(reply, domainError);

    expect(status).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
      },
    });
  });

  it("produces 500 with INTERNAL_ERROR and never echoes the message for a non-DomainError", () => {
    const { reply, status, send } = createMockReply();
    const secretMessage = "Database connection string postgres://admin:secret@localhost:5432/db failed";
    const unexpectedError = new Error(secretMessage);

    sendUnexpectedError(reply, unexpectedError);

    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });

    const sentBody = send.mock.calls[0][0];
    expect(JSON.stringify(sentBody)).not.toContain(secretMessage);
  });

  it("routes through sendError correctly for DomainError", () => {
    const { reply, status, send } = createMockReply();
    const domainError = new DomainError({
      code: "CONFLICT",
      message: "Conflict occurred",
      httpStatusHint: 409,
    });

    sendError(reply, domainError);

    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      error: {
        code: "CONFLICT",
        message: "Conflict occurred",
      },
    });
  });

  it("routes through sendError correctly for non-DomainError", () => {
    const { reply, status, send } = createMockReply();
    const unexpectedError = new TypeError("Cannot read properties of undefined");

    sendError(reply, unexpectedError);

    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  });
});
