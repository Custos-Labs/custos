import type { PrismaClient } from "@verixa/database";
import { describe, expect, it } from "vitest";

import { buildContainer } from "./composition-root.js";

/**
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
  });
});
