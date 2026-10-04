import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from "./errors.js";

describe("ValidationError", () => {
  it("carries a stable code and http status hint", () => {
    const error = new ValidationError("email is invalid");

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.httpStatusHint).toBe(400);
    expect(error.message).toBe("email is invalid");
  });

  it("defaults fieldErrors to an empty object and accepts field-level detail", () => {
    const bare = new ValidationError("invalid");
    expect(bare.fieldErrors).toEqual({});

    const detailed = new ValidationError("invalid", { email: ["is required"] });
    expect(detailed.fieldErrors).toEqual({ email: ["is required"] });
  });

  it("serializes to a predictable JSON shape including fieldErrors", () => {
    const error = new ValidationError("invalid", { email: ["is required"] });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "VALIDATION_ERROR",
      message: "invalid",
      httpStatusHint: 400,
      fieldErrors: { email: ["is required"] },
    });
  });
});

describe("NotFoundError", () => {
  it("carries a stable code and http status hint", () => {
    const error = new NotFoundError("user not found");

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatusHint).toBe(404);
  });

  it("serializes to a predictable JSON shape", () => {
    const error = new NotFoundError("user not found");

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "NOT_FOUND",
      message: "user not found",
      httpStatusHint: 404,
    });
  });
});

describe("ConflictError", () => {
  it("carries a stable code and http status hint", () => {
    const error = new ConflictError("email already taken");

    expect(error.code).toBe("CONFLICT");
    expect(error.httpStatusHint).toBe(409);
  });
});

describe("AuthorizationError", () => {
  it("carries a stable code and http status hint", () => {
    const error = new AuthorizationError("not your session");

    expect(error.code).toBe("AUTHORIZATION_FAILED");
    expect(error.httpStatusHint).toBe(403);
  });

  it("serializes to a predictable JSON shape", () => {
    const error = new AuthorizationError("not your session");

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "AUTHORIZATION_FAILED",
      message: "not your session",
      httpStatusHint: 403,
    });
  });
});

describe("instanceof narrowing", () => {
  it("every subclass is a DomainError and a native Error", () => {
    const errors: DomainError[] = [
      new ValidationError("x"),
      new NotFoundError("x"),
      new ConflictError("x"),
      new AuthorizationError("x"),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("does not cross-match unrelated subclasses", () => {
    const error: DomainError = new NotFoundError("x");

    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(ConflictError);
  });

  it("sets name to the concrete subclass name, not 'Error'", () => {
    expect(new ValidationError("x").name).toBe("ValidationError");
    expect(new NotFoundError("x").name).toBe("NotFoundError");
    expect(new ConflictError("x").name).toBe("ConflictError");
  });
});
