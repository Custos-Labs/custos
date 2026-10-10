import { InMemoryMfaMethodRepository, MfaMethod } from "@verixa/mfa";
import { asId } from "@verixa/shared-kernel";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { buildContainer } from "../composition-root.js";

interface RegisterResponseBody {
  id: string;
}

interface MfaChallengeResponseBody {
  status: string;
  userId: string;
  methods: readonly { id: string; type: string }[];
  id?: string;
}

interface EnrollmentRequiredResponseBody {
  status: string;
  userId: string;
}

interface LoginResponseBody {
  email: string;
}

const asRegisterResponse = (body: unknown): RegisterResponseBody => body as RegisterResponseBody;
const asMfaChallengeResponse = (body: unknown): MfaChallengeResponseBody =>
  body as MfaChallengeResponseBody;
const asEnrollmentRequiredResponse = (body: unknown): EnrollmentRequiredResponseBody =>
  body as EnrollmentRequiredResponseBody;
const asLoginResponse = (body: unknown): LoginResponseBody => body as LoginResponseBody;

describe("POST /auth/login with MFA_ENFORCEMENT_LEVEL=required", () => {
  process.env["SESSION_ACCESS_TOKEN_SECRET"] ??= "test-only-secret-value-at-least-32-chars";
  process.env["MFA_ENFORCEMENT_LEVEL"] = "required";
  const mfaMethodRepo = new InMemoryMfaMethodRepository();
  const container = buildContainer(undefined, { mfaMethodRepository: mfaMethodRepo });
  const app = buildApp({ container });

  beforeEach(async () => {
    await container.prisma.credential.deleteMany({});
    await container.prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await container.prisma.credential.deleteMany({});
    await container.prisma.user.deleteMany({});
    await app.close();
    await container.dispose();
    delete process.env["MFA_ENFORCEMENT_LEVEL"];
  });

  const register = async (email: string) => {
    await app.ready();
    const res = await supertest(app.server)
      .post("/auth/register")
      .send({ email, displayName: "MFA User", password: "correct-horse-battery-staple-1" });
    expect(res.status).toBe(201);
    return asRegisterResponse(res.body).id;
  };

  const login = (email: string) =>
    supertest(app.server)
      .post("/auth/login")
      .send({ email, password: "correct-horse-battery-staple-1" });

  it("returns 202 mfa_challenge (not a completed login) when methods exist", async () => {
    const email = "challenged@example.com";
    const userId = await register(email);
    const method = MfaMethod.createPendingTotp(asId<"UserId">(userId), {
      value: "JBSWY3DPEHPK3PXP",
    }).activate();
    await mfaMethodRepo.save(method);

    const res = await login(email);
    expect(res.status).toBe(202);
    const body = asMfaChallengeResponse(res.body);
    expect(body.status).toBe("mfa_challenge");
    expect(body.userId).toBe(userId);
    expect(body.methods).toEqual([{ id: method.id, type: "totp" }]);
    expect(body.id).toBeUndefined(); // no completed login, no user object
  });

  it("returns 202 enrollment_required when no methods are enrolled", async () => {
    const email = "unenrolled@example.com";
    const userId = await register(email);

    const res = await login(email);
    expect(res.status).toBe(202);
    const body = asEnrollmentRequiredResponse(res.body);
    expect(body).toEqual({ status: "enrollment_required", userId });
  });

  it("still completes a plain login when policy is optional and no methods exist", async () => {
    delete process.env["MFA_ENFORCEMENT_LEVEL"]; // back to default "optional"
    const email = "plain@example.com";
    await register(email);

    const res = await login(email);
    expect(res.status).toBe(200);
    expect(asLoginResponse(res.body).email).toBe(email);
  });
});
