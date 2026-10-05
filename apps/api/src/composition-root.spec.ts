import {
  IssueSession,
  ListActiveSessions,
  Logout,
  LogoutEverywhere,
  RefreshAccessToken,
} from "@verixa/sessions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@verixa/database";
import { describe, expect, it } from "vitest";

import { buildContainer } from "./composition-root.js";

/**
 * Exercises the sessions wiring added to the composition root (Issue 096)
 * without a real Postgres or Redis: `PrismaClient` and the `ioredis` client
 * are both lazy by construction (see `buildContainer`'s comments), so
 * building the container and inspecting its shape never opens either
 * connection. `tests/integration/composition-root.spec.ts` is the
 * complementary end-to-end proof against a real database for the
 * identity/credentials wiring; this is the boot smoke test the sessions
 * acceptance criteria ask for — "resolves all sessions-package use cases
 * with real (non-fake) adapters" — for the part that doesn't need live
 * infrastructure to demonstrate.
 */
describe("composition root: sessions", () => {
  const originalSecret = process.env["SESSION_ACCESS_TOKEN_SECRET"];

  beforeEach(() => {
    process.env["SESSION_ACCESS_TOKEN_SECRET"] = "test-only-secret-value-at-least-32-chars";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env["SESSION_ACCESS_TOKEN_SECRET"];
    } else {
      process.env["SESSION_ACCESS_TOKEN_SECRET"] = originalSecret;
    }
  });

  it("resolves every sessions use case with real (Prisma/Redis-backed) adapters", async () => {
    const container = buildContainer();
    try {
      expect(container.sessions.issueSession).toBeInstanceOf(IssueSession);
      expect(container.sessions.refreshAccessToken).toBeInstanceOf(RefreshAccessToken);
      expect(container.sessions.logout).toBeInstanceOf(Logout);
      expect(container.sessions.logoutEverywhere).toBeInstanceOf(LogoutEverywhere);
      expect(container.sessions.listActiveSessions).toBeInstanceOf(ListActiveSessions);
    } finally {
      await container.dispose();
    }
  });

  it("fails fast at startup when no signing secret is configured", () => {
    delete process.env["SESSION_ACCESS_TOKEN_SECRET"];

    expect(() => buildContainer()).toThrow(/SESSION_ACCESS_TOKEN_SECRET/);
 * Unit-level boot smoke test for the parts of the composition root that
 * don't touch a database — specifically the Phase 08 authorization services
 * (Issue 157). The full end-to-end wiring (identity, credentials, audit) is
 * already covered against a real Postgres by
 * `tests/integration/composition-root.spec.ts`; this file exists so the
 * authorization wiring has coverage that runs even on a machine with no
 * database available at all, since none of it needs one.
 *
 * The `PrismaClient` passed in is never queried — every `Prisma*` adapter
 * constructor here only stores the reference, so a minimal stand-in is
 * enough to prove the object graph assembles without throwing.
 */
function fakePrismaClient(): PrismaClient {
  return {} as unknown as PrismaClient;
}

describe("buildContainer — authorization services", () => {
  it("resolves with the documented default combining algorithm", () => {
    const container = buildContainer(fakePrismaClient());
    expect(container.authorization.combiningAlgorithm).toBe("deny-overrides");
  });

  it("evaluates a request through the wired evaluateRequest function", () => {
    const container = buildContainer(fakePrismaClient());
    const rules = [
      {
        id: "permit-admin",
        effect: "PERMIT" as const,
        condition: {
          type: "attribute" as const,
          attribute: "role",
          operator: "equals" as const,
          value: "admin",
        },
      },
    ];

    expect(container.authorization.evaluateRequest(rules, { role: "admin" })).toBe("PERMIT");
    expect(container.authorization.evaluateRequest(rules, { role: "member" })).toBe(
      "NOT_APPLICABLE",
    );
  });

  it("lints a policy set through the wired lintPolicySet function", () => {
    const container = buildContainer(fakePrismaClient());
    const result = container.authorization.lintPolicySet({
      id: "test-set",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "deny-admin",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ type: "conflict", ruleIds: ["permit-admin", "deny-admin"] }),
    );
describe("Composition Root boot smoke test", () => {
  it("resolves all domain contexts and use cases including MFA", async () => {
    const container = buildContainer();

    // Identity context
    expect(container.identity).toBeDefined();
    expect(container.identity.registerUser).toBeDefined();
    expect(container.identity.updateUserProfile).toBeDefined();

    // Credentials context
    expect(container.credentials).toBeDefined();
    expect(container.credentials.authenticateWithPassword).toBeDefined();
    expect(container.credentials.registerUserWithPassword).toBeDefined();

    // Audit context
    expect(container.audit).toBeDefined();
    expect(container.audit.recordEvent).toBeDefined();

    // MFA context (Issue 119)
    expect(container.mfa).toBeDefined();
    expect(container.mfa.registerWebAuthnCredential).toBeDefined();
    expect(container.mfa.verifyWebAuthnAssertion).toBeDefined();

    await container.dispose();
  });
});
