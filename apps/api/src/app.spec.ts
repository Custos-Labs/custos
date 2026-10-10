import { ValidationError } from "@verixa/shared-kernel";
import supertest from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

describe("GET /health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("responds with 200 and status ok", async () => {
    await app.ready();
    const response = await supertest(app.server).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("global error handler", () => {
  const app = buildApp();

  app.get("/boom", () => {
    throw new Error("postgres://verixa:real-secret@localhost:5432/verixa");
  });

  app.get("/domain-boom", () => {
    throw new ValidationError("Name is required.", { name: ["required"] });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a detail-free 500 for a throw outside any route try/catch", async () => {
    await app.ready();
    const response = await supertest(app.server).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
    expect(JSON.stringify(response.body)).not.toContain("real-secret");
  });

  it("preserves DomainError status and code end to end", async () => {
    await app.ready();
    const response = await supertest(app.server).get("/domain-boom");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Name is required.",
        fields: { name: ["required"] },
      },
    });
  });
});
