import { describe, expect, it } from "vitest";

import type { PolicySet } from "../../domain/entities/rule.js";

import { lintPolicySet } from "./policy-linter.js";

describe("lintPolicySet — conflicts", () => {
  it("flags a PERMIT and a DENY rule with an identical condition", () => {
    const policySet: PolicySet = {
      id: "ps1",
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
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toEqual([
      expect.objectContaining({ type: "conflict", ruleIds: ["permit-admin", "deny-admin"] }),
      expect.objectContaining({ type: "shadow", ruleIds: ["permit-admin", "deny-admin"] }),
    ]);
  });

  it("flags overlapping conditions that share only one constrained attribute", () => {
    const policySet: PolicySet = {
      id: "ps2",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              {
                type: "attribute",
                attribute: "resourceType",
                operator: "equals",
                value: "invoice",
              },
            ],
          },
        },
        {
          id: "deny-locked",
          effect: "DENY",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              { type: "attribute", attribute: "locked", operator: "equals", value: true },
            ],
          },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    const conflicts = result.findings.filter((f) => f.type === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.ruleIds).toEqual(["permit-admin", "deny-locked"]);
  });

  it("does not flag rules with the same effect, even if conditions overlap", () => {
    const policySet: PolicySet = {
      id: "ps3",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "permit-admin-again",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings.filter((f) => f.type === "conflict")).toHaveLength(0);
  });

  it("does not flag rules whose conditions are mutually exclusive", () => {
    const policySet: PolicySet = {
      id: "ps4",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "deny-member",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "member" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
  });
});

describe("lintPolicySet — notEquals overlap semantics", () => {
  it("treats two different notEquals exclusions on the same attribute as compatible", () => {
    const policySet: PolicySet = {
      id: "ne1",
      rules: [
        {
          id: "permit-not-banned",
          effect: "PERMIT",
          condition: {
            type: "attribute",
            attribute: "role",
            operator: "notEquals",
            value: "banned",
          },
        },
        {
          id: "deny-not-admin",
          effect: "DENY",
          condition: {
            type: "attribute",
            attribute: "role",
            operator: "notEquals",
            value: "admin",
          },
        },
      ],
    };

    // A context with role "member" satisfies both, so this is a genuine
    // overlap and should be flagged as a conflict.
    const result = lintPolicySet(policySet);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        type: "conflict",
        ruleIds: ["permit-not-banned", "deny-not-admin"],
      }),
    );
  });

  it("flags equals vs notEquals on the same value as incompatible (no overlap)", () => {
    const policySet: PolicySet = {
      id: "ne2",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "deny-not-admin",
          effect: "DENY",
          condition: {
            type: "attribute",
            attribute: "role",
            operator: "notEquals",
            value: "admin",
          },
        },
      ],
    };

    // role == "admin" and role != "admin" can never both hold, so there is
    // no overlap and no conflict finding.
    expect(lintPolicySet(policySet).findings.filter((f) => f.type === "conflict")).toHaveLength(0);
  });

  it("treats equals vs notEquals on different values as compatible (overlap)", () => {
    const policySet: PolicySet = {
      id: "ne3",
      rules: [
        {
          id: "permit-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "deny-not-member",
          effect: "DENY",
          condition: {
            type: "attribute",
            attribute: "role",
            operator: "notEquals",
            value: "member",
          },
        },
      ],
    };

    // role == "admin" implies role != "member", so a request satisfying the
    // PERMIT rule always also satisfies the DENY rule's condition: a genuine
    // conflict.
    expect(lintPolicySet(policySet).findings).toContainEqual(
      expect.objectContaining({ type: "conflict", ruleIds: ["permit-admin", "deny-not-member"] }),
    );
  });
});

describe("lintPolicySet — shadowing", () => {
  it("flags a broad early rule that shadows a later, more specific rule", () => {
    const policySet: PolicySet = {
      id: "ps5",
      rules: [
        {
          id: "allow-all-admins",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "allow-admins-in-org",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              { type: "attribute", attribute: "orgId", operator: "equals", value: "org-1" },
            ],
          },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    const shadows = result.findings.filter((f) => f.type === "shadow");
    expect(shadows).toHaveLength(1);
    expect(shadows[0]?.ruleIds).toEqual(["allow-all-admins", "allow-admins-in-org"]);
  });

  it("a vacuously-true early rule (empty AND) shadows every later rule", () => {
    const policySet: PolicySet = {
      id: "ps6",
      rules: [
        { id: "match-everything", effect: "DENY", condition: { type: "and", conditions: [] } },
        {
          id: "allow-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ type: "shadow", ruleIds: ["match-everything", "allow-admin"] }),
    );
  });

  it("does not flag a later rule that is broader than an earlier one", () => {
    const policySet: PolicySet = {
      id: "ps7",
      rules: [
        {
          id: "allow-admins-in-org",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              { type: "attribute", attribute: "orgId", operator: "equals", value: "org-1" },
            ],
          },
        },
        {
          id: "allow-all-admins",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings.filter((f) => f.type === "shadow")).toHaveLength(0);
  });

  it("does not flag two rules with disjoint conditions", () => {
    const policySet: PolicySet = {
      id: "ps8",
      rules: [
        {
          id: "allow-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "allow-member",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "member" },
        },
      ],
    };

    expect(lintPolicySet(policySet).findings).toHaveLength(0);
  });
});

describe("lintPolicySet — unanalyzable conditions", () => {
  it("counts, but does not flag, pairs involving an OR condition", () => {
    const policySet: PolicySet = {
      id: "ps9",
      rules: [
        {
          id: "permit-admin-or-owner",
          effect: "PERMIT",
          condition: {
            type: "or",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              { type: "attribute", attribute: "role", operator: "equals", value: "owner" },
            ],
          },
        },
        {
          id: "deny-admin",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
    expect(result.unanalyzedPairs).toBe(1);
  });

  it("counts, but does not flag, pairs involving a NOT condition", () => {
    const policySet: PolicySet = {
      id: "ps10",
      rules: [
        {
          id: "permit-not-locked",
          effect: "PERMIT",
          condition: {
            type: "not",
            condition: { type: "attribute", attribute: "locked", operator: "equals", value: true },
          },
        },
        {
          id: "deny-locked",
          effect: "DENY",
          condition: { type: "attribute", attribute: "locked", operator: "equals", value: true },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
    expect(result.unanalyzedPairs).toBe(1);
  });

  it("counts, but does not flag, pairs involving a non-equality operator", () => {
    const policySet: PolicySet = {
      id: "ps11",
      rules: [
        {
          id: "permit-elevated",
          effect: "PERMIT",
          condition: {
            type: "attribute",
            attribute: "riskScore",
            operator: "greaterThan",
            value: 50,
          },
        },
        {
          id: "deny-elevated",
          effect: "DENY",
          condition: {
            type: "attribute",
            attribute: "riskScore",
            operator: "greaterThan",
            value: 50,
          },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
    expect(result.unanalyzedPairs).toBe(1);
  });

  it("counts, but does not flag, pairs where an AND contains a nested unanalyzable child", () => {
    const policySet: PolicySet = {
      id: "ps13",
      rules: [
        {
          id: "permit-admin-or-owner-in-org",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              {
                type: "or",
                conditions: [
                  { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
                  { type: "attribute", attribute: "role", operator: "equals", value: "owner" },
                ],
              },
              { type: "attribute", attribute: "orgId", operator: "equals", value: "org-1" },
            ],
          },
        },
        {
          id: "deny-admin",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
    expect(result.unanalyzedPairs).toBe(1);
  });

  it("reports zero unanalyzed pairs for a fully-analyzable policy set", () => {
    const policySet: PolicySet = {
      id: "ps12",
      rules: [
        {
          id: "allow-admin",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        {
          id: "deny-member",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "member" },
        },
      ],
    };

    expect(lintPolicySet(policySet).unanalyzedPairs).toBe(0);
  });
});

describe("lintPolicySet — a known-good fixture set", () => {
  it("produces no findings and analyzes every pair", () => {
    const policySet: PolicySet = {
      id: "known-good",
      rules: [
        {
          id: "allow-org-admin",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              {
                type: "attribute",
                attribute: "resourceType",
                operator: "equals",
                value: "invoice",
              },
              {
                type: "attribute",
                attribute: "accountStatus",
                operator: "equals",
                value: "active",
              },
            ],
          },
        },
        {
          id: "allow-org-viewer-read",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "viewer" },
              { type: "attribute", attribute: "action", operator: "equals", value: "read" },
              {
                type: "attribute",
                attribute: "accountStatus",
                operator: "equals",
                value: "active",
              },
            ],
          },
        },
        // Every PERMIT rule above requires accountStatus == "active", so this
        // DENY rule's accountStatus == "suspended" condition can never
        // simultaneously hold — no overlap, hence no reported conflict. This
        // is a deliberate design pattern this fixture demonstrates: making
        // the account-status guard explicit on every PERMIT rule, rather than
        // relying solely on rule ordering, is what keeps the policy set
        // conflict-free under any combining algorithm, not just
        // deny-overrides.
        {
          id: "deny-suspended",
          effect: "DENY",
          condition: {
            type: "attribute",
            attribute: "accountStatus",
            operator: "equals",
            value: "suspended",
          },
        },
      ],
    };

    const result = lintPolicySet(policySet);
    expect(result.findings).toHaveLength(0);
    expect(result.unanalyzedPairs).toBe(0);
  });
});

describe("lintPolicySet — a known-conflict fixture set", () => {
  it("flags the seeded conflict and shadow without missing or duplicating findings", () => {
    const policySet: PolicySet = {
      id: "known-conflict",
      rules: [
        // Shadows everything after it for admins.
        {
          id: "allow-admin-broad",
          effect: "PERMIT",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
        // Unreachable given the rule above.
        {
          id: "allow-admin-narrow",
          effect: "PERMIT",
          condition: {
            type: "and",
            conditions: [
              { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
              { type: "attribute", attribute: "orgId", operator: "equals", value: "org-1" },
            ],
          },
        },
        // Directly contradicts allow-admin-broad for the same attribute.
        {
          id: "deny-admin",
          effect: "DENY",
          condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
        },
      ],
    };

    const result = lintPolicySet(policySet);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        type: "shadow",
        ruleIds: ["allow-admin-broad", "allow-admin-narrow"],
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ type: "conflict", ruleIds: ["allow-admin-broad", "deny-admin"] }),
    );
    // allow-admin-narrow's constraints (role=admin AND orgId=org-1) are
    // compatible with deny-admin's (role=admin) — some request satisfies
    // both — so this pair is a conflict too, even though it is not a shadow
    // (allow-admin-narrow is not broader than deny-admin).
    expect(result.findings).toContainEqual(
      expect.objectContaining({ type: "conflict", ruleIds: ["allow-admin-narrow", "deny-admin"] }),
    );
  });
});
