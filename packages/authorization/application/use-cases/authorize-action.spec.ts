import { describe, expect, it } from "vitest";

import type { PolicyDecisionPoint, PolicyEvaluation } from "../ports/policy-decision-point.js";
import type { RoleDecision, RolePermissionGate } from "../ports/role-permission-gate.js";
import { AuthorizationService } from "../services/authorization-service.js";
import { ResourceAttributeResolverRegistry } from "../services/resource-attribute-resolver-registry.js";

import { AuthorizeAction } from "./authorize-action.js";

/**
 * A role layer with a fixed answer.
 *
 * `AuthorizationService` takes a `RolePermissionGate` — Phase 07's port, which
 * is tenant-aware and reports `grant`/`deny`/`no-match`.
 */
function stubGate(kind: RoleDecision["kind"]): RolePermissionGate {
  return {
    check: () =>
      Promise.resolve({
        kind,
        reason: `stubbed ${kind}`,
        roles: [],
        permissions: [],
      }),
  };
}

/** A role layer that holds no grants, so every decision falls to the policies. */
function noGrants(): RolePermissionGate {
  return stubGate("no-match");
}

/** A policy layer with a fixed outcome. */
function stubPdp(
  effect: PolicyEvaluation["effect"],
  matchedPolicyIds: readonly string[] = [],
): PolicyDecisionPoint {
  return {
    evaluate: () => Promise.resolve({ effect, reason: `stubbed ${effect}`, matchedPolicyIds }),
  };
}

/** A policy layer with nothing to say, so the role layer settles the question. */
function noPolicies(): PolicyDecisionPoint {
  return stubPdp("NOT_APPLICABLE");
}

describe("AuthorizeAction", () => {
  describe("grant path", () => {
    it("grants and reports the matching policy when a policy permits", async () => {
      const pdp = stubPdp("PERMIT", ["policy-owners-may-read"]);
      const useCase = new AuthorizeAction(new AuthorizationService(noGrants(), pdp));

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
        resourceAttributes: { ownerId: "user-1" },
      });

      expect(decision.granted).toBe(true);
      expect(decision.reason).toContain("policy permits");
      expect(decision.matchedPolicyIds).toHaveLength(1);
      expect(decision.evaluatedAt).toBeInstanceOf(Date);
    });

    it("grants via RBAC and says so in the reason, with no matched policies", async () => {
      const useCase = new AuthorizeAction(
        new AuthorizationService(stubGate("grant"), noPolicies()),
      );

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(true);
      expect(decision.reason).toContain("role/permission grant permits");
      expect(decision.matchedPolicyIds).toEqual([]);
    });
  });

  describe("deny path", () => {
    it("denies and names the matching policy when a policy denies", async () => {
      // A policy denial outranks a role grant: the gate says grant, the policy
      // layer says deny, and the result must be a denial. Which layer wins is
      // `AuthorizationService`'s precedence contract, asserted here through the
      // use case because that is what a caller observes.
      const pdp = stubPdp("DENY", ["policy-deny-locked"]);

      const useCase = new AuthorizeAction(new AuthorizationService(stubGate("grant"), pdp));
      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(false);
      expect(decision.reason).toContain("policy denies");
      expect(decision.matchedPolicyIds).toHaveLength(1);
    });

    it("denies via RBAC when RBAC denies and no policy applies", async () => {
      const useCase = new AuthorizeAction(new AuthorizationService(stubGate("deny"), noPolicies()));

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(false);
      expect(decision.reason).toContain("role/permission grant denies");
    });

    it("denies with the fail-closed default reason when neither RBAC nor ABAC has an opinion", async () => {
      const useCase = new AuthorizeAction(new AuthorizationService(noGrants(), noPolicies()));

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(false);
      expect(decision.reason).toContain("fail-closed default");
      expect(decision.matchedPolicyIds).toEqual([]);
    });
  });

  describe("policy-error path", () => {
    it("denies and names the failure when resource-attribute resolution throws", async () => {
      const registry = new ResourceAttributeResolverRegistry();
      registry.register("document", {
        resolve: () => Promise.reject(new Error("upstream lookup failed")),
      });

      const useCase = new AuthorizeAction(
        new AuthorizationService(stubGate("grant"), noPolicies()),
        registry,
      );

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(false);
      expect(decision.reason).toContain("could not resolve");
      expect(decision.reason).toContain("upstream lookup failed");
      expect(decision.matchedPolicyIds).toEqual([]);
    });

    it("resolves resource attributes automatically when a resolver is registered", async () => {
      const pdp = stubPdp("PERMIT", ["policy-owners-may-read"]);
      const registry = new ResourceAttributeResolverRegistry();
      registry.register("document", { resolve: () => Promise.resolve({ ownerId: "user-1" }) });

      const useCase = new AuthorizeAction(new AuthorizationService(noGrants(), pdp), registry);

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(true);
    });

    it("proceeds with no resource attributes when no resolver is registered for the resource type", async () => {
      const registry = new ResourceAttributeResolverRegistry();
      const useCase = new AuthorizeAction(
        new AuthorizationService(stubGate("grant"), noPolicies()),
        registry,
      );

      const decision = await useCase.execute({
        subjectId: "user-1",
        tenantId: "org-1",
        action: "read",
        resourceType: "document",
        resourceId: "doc-1",
      });

      expect(decision.granted).toBe(true);
    });
  });
});
