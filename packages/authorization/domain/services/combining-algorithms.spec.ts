import { describe, expect, it } from "vitest";

import type { Rule } from "../entities/rule.js";

import {
  combine,
  DEFAULT_COMBINING_ALGORITHM,
  denyOverrides,
  firstApplicable,
  permitOverrides,
} from "./combining-algorithms.js";

const permitAlways: Rule = {
  id: "permit-always",
  effect: "PERMIT",
  condition: { type: "and", conditions: [] },
};
const denyAlways: Rule = {
  id: "deny-always",
  effect: "DENY",
  condition: { type: "and", conditions: [] },
};
const neverApplies: Rule = {
  id: "never-applies",
  effect: "PERMIT",
  condition: { type: "or", conditions: [] },
};

describe("DEFAULT_COMBINING_ALGORITHM", () => {
  it("defaults to deny-overrides, favoring safety", () => {
    expect(DEFAULT_COMBINING_ALGORITHM).toBe("deny-overrides");
  });
});

describe("denyOverrides", () => {
  it("returns DENY when any rule denies, even alongside permits", () => {
    expect(denyOverrides([permitAlways, denyAlways], {})).toBe("DENY");
    expect(denyOverrides([denyAlways, permitAlways], {})).toBe("DENY");
  });

  it("returns PERMIT when at least one rule permits and none deny", () => {
    expect(denyOverrides([permitAlways, neverApplies], {})).toBe("PERMIT");
  });

  it("returns NOT_APPLICABLE when every rule is not applicable", () => {
    expect(denyOverrides([neverApplies], {})).toBe("NOT_APPLICABLE");
  });

  it("returns NOT_APPLICABLE for an empty rule set", () => {
    expect(denyOverrides([], {})).toBe("NOT_APPLICABLE");
  });
});

describe("permitOverrides", () => {
  it("returns PERMIT when any rule permits, even alongside denies", () => {
    expect(permitOverrides([permitAlways, denyAlways], {})).toBe("PERMIT");
    expect(permitOverrides([denyAlways, permitAlways], {})).toBe("PERMIT");
  });

  it("returns DENY when at least one rule denies and none permit", () => {
    expect(permitOverrides([denyAlways, neverApplies], {})).toBe("DENY");
  });

  it("returns NOT_APPLICABLE when every rule is not applicable", () => {
    expect(permitOverrides([neverApplies], {})).toBe("NOT_APPLICABLE");
  });

  it("returns NOT_APPLICABLE for an empty rule set", () => {
    expect(permitOverrides([], {})).toBe("NOT_APPLICABLE");
  });
});

describe("firstApplicable", () => {
  it("returns the first matching rule's effect", () => {
    expect(firstApplicable([denyAlways, permitAlways], {})).toBe("DENY");
    expect(firstApplicable([permitAlways, denyAlways], {})).toBe("PERMIT");
  });

  it("skips non-applicable rules to find the first that matches", () => {
    expect(firstApplicable([neverApplies, denyAlways, permitAlways], {})).toBe("DENY");
  });

  it("returns NOT_APPLICABLE when no rule matches", () => {
    expect(firstApplicable([neverApplies], {})).toBe("NOT_APPLICABLE");
  });

  it("returns NOT_APPLICABLE for an empty rule set", () => {
    expect(firstApplicable([], {})).toBe("NOT_APPLICABLE");
  });

  it("does not let a later rule's effect override an earlier match", () => {
    // Order-sensitivity is the whole point of this algorithm — a DENY placed
    // after a matching PERMIT must not change the outcome.
    const rules: Rule[] = [permitAlways, denyAlways];
    expect(firstApplicable(rules, {})).toBe("PERMIT");
  });
});

describe("combine", () => {
  it("dispatches to deny-overrides", () => {
    expect(combine("deny-overrides", [permitAlways, denyAlways], {})).toBe("DENY");
  });

  it("dispatches to permit-overrides", () => {
    expect(combine("permit-overrides", [permitAlways, denyAlways], {})).toBe("PERMIT");
  });

  it("dispatches to first-applicable", () => {
    expect(combine("first-applicable", [denyAlways, permitAlways], {})).toBe("DENY");
  });

  describe("conflicting-rule fixtures", () => {
    const permitAdmin: Rule = {
      id: "permit-admin",
      effect: "PERMIT",
      condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
    };
    const denyLocked: Rule = {
      id: "deny-locked",
      effect: "DENY",
      condition: { type: "attribute", attribute: "locked", operator: "equals", value: true },
    };

    it("permit+deny: deny-overrides denies when both apply", () => {
      const context = { role: "admin", locked: true };
      expect(combine("deny-overrides", [permitAdmin, denyLocked], context)).toBe("DENY");
      expect(combine("permit-overrides", [permitAdmin, denyLocked], context)).toBe("PERMIT");
      expect(combine("first-applicable", [permitAdmin, denyLocked], context)).toBe("PERMIT");
      expect(combine("first-applicable", [denyLocked, permitAdmin], context)).toBe("DENY");
    });

    it("permit+permit: every algorithm permits", () => {
      const secondPermit: Rule = {
        id: "permit-owner",
        effect: "PERMIT",
        condition: { type: "attribute", attribute: "role", operator: "equals", value: "owner" },
      };
      const context = { role: "admin" };
      expect(combine("deny-overrides", [permitAdmin, secondPermit], context)).toBe("PERMIT");
      expect(combine("permit-overrides", [permitAdmin, secondPermit], context)).toBe("PERMIT");
      expect(combine("first-applicable", [permitAdmin, secondPermit], context)).toBe("PERMIT");
    });

    it("all not-applicable: every algorithm is NOT_APPLICABLE", () => {
      const context = { role: "member", locked: false };
      expect(combine("deny-overrides", [permitAdmin, denyLocked], context)).toBe("NOT_APPLICABLE");
      expect(combine("permit-overrides", [permitAdmin, denyLocked], context)).toBe(
        "NOT_APPLICABLE",
      );
      expect(combine("first-applicable", [permitAdmin, denyLocked], context)).toBe(
        "NOT_APPLICABLE",
      );
    });
  });
});
