import { NotFoundError, ValidationError } from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  type ErrorResponseBody,
  sendDomainError,
  sendError,
  sendUnexpectedError,
} from "./error-response.js";

function makeReply() {
  const sent: { statusCode?: number; body?: ErrorResponseBody } = {};
  const reply = {
    status(code: number) {
      sent.statusCode = code;
      return reply;
    },
    send(payload: ErrorResponseBody) {
      sent.body = payload;
      return reply;
    },
    log: {
      error: vi.fn(),
    },
  };
  return { reply: reply as unknown as FastifyReply, sent, log: reply.log };
}

describe("HTTP error response helpers", () => {
  describe("sendError", () => {
    it("produces 400 with fields object for ValidationError with field errors", () => {
      const { reply, sent } = makeReply();
      const err = new ValidationError("Invalid payload", {
        email: ["Must be a valid email"],
      });

      sendError(reply, err);

      expect(sent.statusCode).toBe(400);
      expect(sent.body?.error.code).toBe("VALIDATION_ERROR");
      expect(sent.body?.error.message).toBe("Invalid payload");
      expect(sent.body?.error.fields).toEqual({
        email: ["Must be a valid email"],
      });
    });

    it("omits fields object for DomainError without field errors", () => {
      const { reply, sent } = makeReply();
      const err = new NotFoundError("User not found");

      sendError(reply, err);

      expect(sent.statusCode).toBe(404);
      expect(sent.body?.error.code).toBe("NOT_FOUND");
      expect(sent.body?.error.message).toBe("User not found");
      expect(sent.body?.error.fields).toBeUndefined();
    });

    it("omits fields object for ValidationError with empty field errors", () => {
      const { reply, sent } = makeReply();
      const err = new ValidationError("Invalid payload", {});

      sendError(reply, err);

      expect(sent.statusCode).toBe(400);
      expect(sent.body?.error.code).toBe("VALIDATION_ERROR");
      expect(sent.body?.error.fields).toBeUndefined();
    });

    it("produces 500 with INTERNAL_ERROR and never echoes non-DomainError message", () => {
      const { reply, sent, log } = makeReply();
      const secretMessage = "DATABASE_URL=postgres://user:supersecret@db/prod";
      const err = new Error(secretMessage);

      sendError(reply, err);

      expect(sent.statusCode).toBe(500);
      expect(sent.body?.error.code).toBe("INTERNAL_ERROR");
      expect(sent.body?.error.message).toBe("An unexpected error occurred.");
      expect(JSON.stringify(sent.body)).not.toContain(secretMessage);
      expect(log.error).toHaveBeenCalledWith({ err }, "unhandled error in request");
    });
  });

  describe("sendDomainError", () => {
    it("routes directly to status and body for domain errors", () => {
      const { reply, sent } = makeReply();
      const err = new NotFoundError("Session expired");

      sendDomainError(reply, err);

      expect(sent.statusCode).toBe(404);
      expect(sent.body?.error.code).toBe("NOT_FOUND");
      expect(sent.body?.error.message).toBe("Session expired");
    });
  });

  describe("sendUnexpectedError", () => {
    it("handles non-Error objects safely and masks details", () => {
      const { reply, sent, log } = makeReply();
      const rawStringError = "raw string failure";

      sendUnexpectedError(reply, rawStringError);

      expect(sent.statusCode).toBe(500);
      expect(sent.body?.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(sent.body)).not.toContain(rawStringError);
      expect(log.error).toHaveBeenCalledWith({ err: rawStringError }, "unhandled error in request");
    });
  });
});
import {
  NotFoundError,
  RateLimitExceededError,
  ValidationError,
  type RateLimitKey,
} from "@verixa/shared-kernel";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  type ErrorResponseBody,
  sendDomainError,
  sendError,
  sendUnexpectedError,
} from "./error-response.js";

function makeReply() {
  const sent: {
    statusCode?: number;
    body?: ErrorResponseBody;
    headers: Record<string, string>;
  } = { headers: {} };
  const reply = {
    status(code: number) {
      sent.statusCode = code;
      return reply;
    },
    send(payload: ErrorResponseBody) {
      sent.body = payload;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    log: {
      error: vi.fn(),
    },
  };
  return { reply: reply as unknown as FastifyReply, sent, log: reply.log };
}

describe("HTTP error response helpers", () => {
  describe("sendError", () => {
    it("produces 400 with fields object for ValidationError with field errors", () => {
      const { reply, sent } = makeReply();
      const err = new ValidationError("Invalid payload", {
        email: ["Must be a valid email"],
      });

      sendError(reply, err);

      expect(sent.statusCode).toBe(400);
      expect(sent.body?.error.code).toBe("VALIDATION_ERROR");
      expect(sent.body?.error.message).toBe("Invalid payload");
      expect(sent.body?.error.fields).toEqual({
        email: ["Must be a valid email"],
      });
    });

    it("omits fields object for DomainError without field errors", () => {
      const { reply, sent } = makeReply();
      const err = new NotFoundError("User not found");

      sendError(reply, err);

      expect(sent.statusCode).toBe(404);
      expect(sent.body?.error.code).toBe("NOT_FOUND");
      expect(sent.body?.error.message).toBe("User not found");
      expect(sent.body?.error.fields).toBeUndefined();
    });

    it("omits fields object for ValidationError with empty field errors", () => {
      const { reply, sent } = makeReply();
      const err = new ValidationError("Invalid payload", {});

      sendError(reply, err);

      expect(sent.statusCode).toBe(400);
      expect(sent.body?.error.code).toBe("VALIDATION_ERROR");
      expect(sent.body?.error.fields).toBeUndefined();
    });

    it("produces 500 with INTERNAL_ERROR and never echoes non-DomainError message", () => {
      const { reply, sent, log } = makeReply();
      const secretMessage = "DATABASE_URL=postgres://user:supersecret@db/prod";
      const err = new Error(secretMessage);

      sendError(reply, err);

      expect(sent.statusCode).toBe(500);
      expect(sent.body?.error.code).toBe("INTERNAL_ERROR");
      expect(sent.body?.error.message).toBe("An unexpected error occurred.");
      expect(JSON.stringify(sent.body)).not.toContain(secretMessage);
      expect(log.error).toHaveBeenCalledWith({ err }, "unhandled error in request");
    });
  });

  describe("sendDomainError", () => {
    it("routes directly to status and body for domain errors", () => {
      const { reply, sent } = makeReply();
      const err = new NotFoundError("Session expired");

      sendDomainError(reply, err);

      expect(sent.statusCode).toBe(404);
      expect(sent.body?.error.code).toBe("NOT_FOUND");
      expect(sent.body?.error.message).toBe("Session expired");
    });

    it("handles RateLimitExceededError with 429, retryAfter, and Retry-After header", () => {
      const { reply, sent } = makeReply();
      const key: RateLimitKey = { action: "login", identifier: "alice@example.com" };
      const resetAt = Date.now() + 30000;
      const err = new RateLimitExceededError(key, resetAt, 5);

      sendDomainError(reply, err);

      expect(sent.statusCode).toBe(429);
      expect(sent.body?.error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(sent.body?.error.message).toContain(
        "Rate limit exceeded for login on alice@example.com",
      );
      expect(sent.body?.error.retryAfter).toBeGreaterThanOrEqual(0);
      expect(sent.headers["Retry-After"]).toBeDefined();
      expect(Number(sent.headers["Retry-After"])).toBeGreaterThanOrEqual(0);
    });
  });

  describe("sendUnexpectedError", () => {
    it("handles non-Error objects safely and masks details", () => {
      const { reply, sent, log } = makeReply();
      const rawStringError = "raw string failure";

      sendUnexpectedError(reply, rawStringError);

      expect(sent.statusCode).toBe(500);
      expect(sent.body?.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(sent.body)).not.toContain(rawStringError);
      expect(log.error).toHaveBeenCalledWith({ err: rawStringError }, "unhandled error in request");
    });
  });
});
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
