import { buildContainer } from "@verixa/api/composition-root";
import { toHttpError } from "@verixa/shared-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseAvailability } from "./helpers/database.js";
import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

process.env["SESSION_ACCESS_TOKEN_SECRET"] ??= "test-only-secret-value-at-least-32-chars";

const available = await databaseAvailability();

/** The contract every route group must satisfy. */
function expectErrorShape(body: unknown): void {
  const err = (body as { error: Record<string, unknown> }).error;
  expect(typeof err.code).toBe("string");
  expect(typeof err.message).toBe("string");
  expect(Object.keys(err).sort()).toEqual(
    err.fields === undefined ? ["code", "message"] : ["code", "fields", "message"],
  );
}

describe.skipIf(!available)("shared error response shape", () => {
  let client: HttpTestClient;

  beforeAll(async () => {
    client = await createHttpTestClient(buildContainer());
  });

  afterAll(async () => {
    await client.close();
  });

  it("auth: failed login returns the shared shape", async () => {
    const res = await client.request
      .post("/auth/login")
      .send({ email: "nobody@example.com", password: "wrong-password-1" });
    expect(res.status).toBe(401);
    expectErrorShape(res.body);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("admin: missing permission returns the shared shape", async () => {
    const res = await client.request.get("/admin/roles"); // no x-user-id
    expect(res.status).toBe(403);
    expectErrorShape(res.body);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTHORIZATION_FAILED");
  });

  it("verification: non-reviewer returns the shared shape", async () => {
    const res = await client.request.get("/verification/review-queue");
    expect(res.status).toBe(403);
    expectErrorShape(res.body);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTHORIZATION_FAILED");
  });

  it("unexpected failures never leak the message", () => {
    const mapped = toHttpError(new Error("postgres://user:secret@localhost/db"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(mapped.body)).not.toContain("postgres://");
  });
});
