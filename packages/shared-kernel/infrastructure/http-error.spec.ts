import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../domain/errors.js";

import { toHttpError } from "./http-error.js";

describe("toHttpError", () => {
  it("translates NotFoundError to 404 with standard error body", () => {
    const error = new NotFoundError("User not found");
    const result = toHttpError(error);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "User not found",
      },
    });
  });

  it("translates AuthorizationError to 403 with standard error body", () => {
    const error = new AuthorizationError("Access denied");
    const result = toHttpError(error);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: {
        code: "AUTHORIZATION_FAILED",
        message: "Access denied",
      },
    });
  });

  it("translates AuthenticationError to 401 with standard error body", () => {
    const error = new AuthenticationError("Invalid credentials");
    const result = toHttpError(error);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Invalid credentials",
      },
    });
  });

  it("translates ConflictError to 409 with standard error body", () => {
    const error = new ConflictError("Email already in use");
    const result = toHttpError(error);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: {
        code: "CONFLICT",
        message: "Email already in use",
      },
    });
  });

  it("translates ValidationError without field errors to 400 omitting fields", () => {
    const error = new ValidationError("Invalid format");
    const result = toHttpError(error);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid format",
      },
    });
    expect(result.body.error.fields).toBeUndefined();
  });

  it("translates ValidationError with field errors to 400 including fields", () => {
    const error = new ValidationError("Invalid input", {
      email: ["must be valid email"],
    });
    const result = toHttpError(error);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid input",
        fields: {
          email: ["must be valid email"],
        },
      },
    });
  });

  it("translates unexpected non-domain error to 500 without leaking error message", () => {
    const secretError = new Error("postgres://user:secret@localhost/db");
    const result = toHttpError(secretError);

    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("postgres://");
  });
});
