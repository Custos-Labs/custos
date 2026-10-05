import { describe, expect, it } from "vitest";

import type { Rule } from "../entities/rule.js";
import type { Condition } from "../value-objects/condition.js";

import { evaluate, evaluateRule } from "./policy-evaluation-engine.js";

function rule(condition: Condition): Rule {
  return { id: "r1", effect: "PERMIT", condition };
}

describe("evaluate — attribute conditions", () => {
  it("equals matches when the attribute equals the value", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "equals", value: "admin" }),
      { "subject.role": "admin" },
    );
    expect(result).toBe(true);
  });

  it("equals does not match a different value", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "equals", value: "admin" }),
      { "subject.role": "member" },
    );
    expect(result).toBe(false);
  });

  it("equals resolves to false, not true, when the attribute is missing", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "equals", value: "admin" }),
      {},
    );
    expect(result).toBe(false);
  });

  it("notEquals resolves to false when the attribute is missing (fails closed)", () => {
    // The conservative choice: an absent attribute must not silently satisfy
    // a `notEquals` guard on a DENY rule.
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "notEquals", value: "admin" }),
      {},
    );
    expect(result).toBe(false);
  });

  it("notEquals matches a present, different value", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "notEquals", value: "admin" }),
      { "subject.role": "member" },
    );
    expect(result).toBe(true);
  });

  it("in matches when the attribute is a member of the list", () => {
    const result = evaluate(
      rule({
        type: "attribute",
        attribute: "subject.role",
        operator: "in",
        value: ["admin", "owner"],
      }),
      { "subject.role": "owner" },
    );
    expect(result).toBe(true);
  });

  it("in resolves to false when the attribute is missing", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "in", value: ["admin"] }),
      {},
    );
    expect(result).toBe(false);
  });

  it("notIn matches when the attribute is absent from the list", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "notIn", value: ["banned"] }),
      { "subject.role": "member" },
    );
    expect(result).toBe(true);
  });

  it("notIn resolves to false when the attribute is missing", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "subject.role", operator: "notIn", value: ["banned"] }),
      {},
    );
    expect(result).toBe(false);
  });

  it("exists matches a present attribute", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "resource.ownerId", operator: "exists" }),
      { "resource.ownerId": "u1" },
    );
    expect(result).toBe(true);
  });

  it("exists does not match a missing attribute", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "resource.ownerId", operator: "exists" }),
      {},
    );
    expect(result).toBe(false);
  });

  it("notExists matches a missing attribute", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "resource.ownerId", operator: "notExists" }),
      {},
    );
    expect(result).toBe(true);
  });

  it("notExists does not match a present attribute", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "resource.ownerId", operator: "notExists" }),
      { "resource.ownerId": "u1" },
    );
    expect(result).toBe(false);
  });

  it.each([
    ["greaterThan", 5, 3, true],
    ["greaterThan", 3, 5, false],
    ["greaterThanOrEqual", 5, 5, true],
    ["greaterThanOrEqual", 4, 5, false],
    ["lessThan", 3, 5, true],
    ["lessThan", 5, 3, false],
    ["lessThanOrEqual", 5, 5, true],
    ["lessThanOrEqual", 6, 5, false],
  ] as const)("%s(%p, %p) -> %p", (operator, actual, expected, want) => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "environment.riskScore", operator, value: expected }),
      { "environment.riskScore": actual },
    );
    expect(result).toBe(want);
  });

  it("ordering operators resolve to false when the attribute is missing", () => {
    const result = evaluate(
      rule({
        type: "attribute",
        attribute: "environment.riskScore",
        operator: "greaterThan",
        value: 3,
      }),
      {},
    );
    expect(result).toBe(false);
  });

  it("ordering operators resolve to false for mismatched operand types", () => {
    const result = evaluate(
      rule({
        type: "attribute",
        attribute: "environment.riskScore",
        operator: "greaterThan",
        value: "3",
      }),
      { "environment.riskScore": 5 },
    );
    expect(result).toBe(false);
  });

  it("compares strings lexicographically for ordering operators", () => {
    const result = evaluate(
      rule({ type: "attribute", attribute: "resource.tier", operator: "greaterThan", value: "a" }),
      { "resource.tier": "b" },
    );
    expect(result).toBe(true);
  });
});

describe("evaluate — AND/OR/NOT and short-circuiting", () => {
  it("AND is true only when every branch is true", () => {
    const condition: Condition = {
      type: "and",
      conditions: [
        { type: "attribute", attribute: "a", operator: "equals", value: 1 },
        { type: "attribute", attribute: "b", operator: "equals", value: 2 },
      ],
    };
    expect(evaluate(rule(condition), { a: 1, b: 2 })).toBe(true);
    expect(evaluate(rule(condition), { a: 1, b: 3 })).toBe(false);
  });

  it("an empty AND is vacuously true", () => {
    expect(evaluate(rule({ type: "and", conditions: [] }), {})).toBe(true);
  });

  it("OR is true when at least one branch is true", () => {
    const condition: Condition = {
      type: "or",
      conditions: [
        { type: "attribute", attribute: "a", operator: "equals", value: 1 },
        { type: "attribute", attribute: "b", operator: "equals", value: 2 },
      ],
    };
    expect(evaluate(rule(condition), { a: 0, b: 2 })).toBe(true);
    expect(evaluate(rule(condition), { a: 0, b: 0 })).toBe(false);
  });

  it("an empty OR is vacuously false", () => {
    expect(evaluate(rule({ type: "or", conditions: [] }), {})).toBe(false);
  });

  it("NOT inverts its inner condition", () => {
    const condition: Condition = {
      type: "not",
      condition: { type: "attribute", attribute: "a", operator: "equals", value: 1 },
    };
    expect(evaluate(rule(condition), { a: 1 })).toBe(false);
    expect(evaluate(rule(condition), { a: 2 })).toBe(true);
  });

  it("AND short-circuits: a false first branch means later branches are never evaluated", () => {
    // A getter that throws proves whether "b" was ever read: a false first
    // branch that skipped evaluating the second would never trigger it.
    const context = {
      a: 0,
      get b(): boolean {
        throw new Error("attribute 'b' should not have been read");
      },
    };
    const condition: Condition = {
      type: "and",
      conditions: [
        { type: "attribute", attribute: "a", operator: "equals", value: 1 },
        { type: "attribute", attribute: "b", operator: "exists" },
      ],
    };

    expect(evaluate(rule(condition), context)).toBe(false);
  });

  it("OR short-circuits: a true first branch means later branches are never evaluated", () => {
    const context = {
      a: 1,
      get b(): boolean {
        throw new Error("attribute 'b' should not have been read");
      },
    };
    const condition: Condition = {
      type: "or",
      conditions: [
        { type: "attribute", attribute: "a", operator: "equals", value: 1 },
        { type: "attribute", attribute: "b", operator: "exists" },
      ],
    };

    expect(evaluate(rule(condition), context)).toBe(true);
  });

  it("evaluates deeply nested trees correctly", () => {
    const condition: Condition = {
      type: "and",
      conditions: [
        {
          type: "or",
          conditions: [
            { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
            {
              type: "and",
              conditions: [
                { type: "attribute", attribute: "role", operator: "equals", value: "editor" },
                {
                  type: "not",
                  condition: {
                    type: "attribute",
                    attribute: "locked",
                    operator: "equals",
                    value: true,
                  },
                },
              ],
            },
          ],
        },
        { type: "attribute", attribute: "orgId", operator: "equals", value: "org-1" },
      ],
    };

    expect(evaluate(rule(condition), { role: "editor", locked: false, orgId: "org-1" })).toBe(true);
    expect(evaluate(rule(condition), { role: "editor", locked: true, orgId: "org-1" })).toBe(false);
    expect(evaluate(rule(condition), { role: "admin", locked: true, orgId: "org-2" })).toBe(false);
    expect(evaluate(rule(condition), { role: "admin", locked: true, orgId: "org-1" })).toBe(true);
import { describe, expect, it, vi } from "vitest";

import { AttributeContext } from "../value-objects/attribute-context.js";
import { Condition, type Condition as ConditionType } from "../value-objects/condition.js";
import { Rule } from "../value-objects/rule.js";

import { evaluateCondition, evaluateRule } from "./policy-evaluation-engine.js";

describe("evaluateCondition", () => {
  it("matches 'always' unconditionally", () => {
    expect(evaluateCondition(Condition.always(), AttributeContext.create({}))).toBe(true);
  });

  describe("comparison operators", () => {
    const context = AttributeContext.create({
      subject: { role: "admin", clearance: 3 },
      resource: {
        ownerId: "user-1",
        tags: ["a", "b"],
        availableFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });

    it("eq matches equal primitives", () => {
      expect(
        evaluateCondition(Condition.comparison("resource.ownerId", "eq", "user-1"), context),
      ).toBe(true);
      expect(
        evaluateCondition(Condition.comparison("resource.ownerId", "eq", "user-2"), context),
      ).toBe(false);
    });

    it("neq is the negation of eq", () => {
      expect(
        evaluateCondition(Condition.comparison("resource.ownerId", "neq", "user-2"), context),
      ).toBe(true);
    });

    it("lt/lte/gt/gte compare numbers", () => {
      expect(evaluateCondition(Condition.comparison("subject.clearance", "gte", 3), context)).toBe(
        true,
      );
      expect(evaluateCondition(Condition.comparison("subject.clearance", "gt", 3), context)).toBe(
        false,
      );
      expect(evaluateCondition(Condition.comparison("subject.clearance", "lt", 3), context)).toBe(
        false,
      );
      expect(evaluateCondition(Condition.comparison("subject.clearance", "lte", 3), context)).toBe(
        true,
      );
    });

    it("lt/lte/gt/gte compare Date attributes against a numeric timestamp", () => {
      const before = new Date("2025-12-31T00:00:00Z").getTime();
      expect(
        evaluateCondition(Condition.comparison("resource.availableFrom", "gt", before), context),
      ).toBe(true);
    });

    it("in checks membership of the attribute in the literal array", () => {
      expect(
        evaluateCondition(Condition.comparison("subject.role", "in", ["admin", "owner"]), context),
      ).toBe(true);
      expect(
        evaluateCondition(Condition.comparison("subject.role", "in", ["owner"]), context),
      ).toBe(false);
    });

    it("contains checks membership of the literal in the attribute array", () => {
      expect(
        evaluateCondition(Condition.comparison("resource.tags", "contains", "a"), context),
      ).toBe(true);
      expect(
        evaluateCondition(Condition.comparison("resource.tags", "contains", "c"), context),
      ).toBe(false);
    });

    it("type mismatches evaluate to false rather than coercing", () => {
      expect(evaluateCondition(Condition.comparison("subject.role", "gt", 1), context)).toBe(false);
      expect(
        evaluateCondition(Condition.comparison("subject.clearance", "in", ["3"]), context),
      ).toBe(false);
      expect(
        evaluateCondition(Condition.comparison("resource.tags", "eq", ["a", "b"]), context),
      ).toBe(false);
    });

    it("evaluates to false against an attribute that is not present in the context", () => {
      expect(evaluateCondition(Condition.comparison("resource.missing", "eq", "x"), context)).toBe(
        false,
      );
    });
  });

  describe("short-circuiting", () => {
    it("AND does not evaluate later operands once an earlier one is false", () => {
      const secondOperand = vi.fn(() => false);
      const spyCondition: ConditionType = {
        kind: "comparison",
        get attribute() {
          secondOperand();
          return "subject.role";
        },
        operator: "eq",
        value: "admin",
      };

      const tree = Condition.and([
        Condition.comparison("subject.role", "eq", "guest"),
        spyCondition,
      ]);
      const context = AttributeContext.create({ subject: { role: "admin" } });

      expect(evaluateCondition(tree, context)).toBe(false);
      expect(secondOperand).not.toHaveBeenCalled();
    });

    it("OR does not evaluate later operands once an earlier one is true", () => {
      const secondOperand = vi.fn(() => false);
      const spyCondition: ConditionType = {
        kind: "comparison",
        get attribute() {
          secondOperand();
          return "subject.role";
        },
        operator: "eq",
        value: "admin",
      };

      const tree = Condition.or([
        Condition.comparison("subject.role", "eq", "admin"),
        spyCondition,
      ]);
      const context = AttributeContext.create({ subject: { role: "admin" } });

      expect(evaluateCondition(tree, context)).toBe(true);
      expect(secondOperand).not.toHaveBeenCalled();
    });
  });

  describe("deep nesting", () => {
    it("evaluates arbitrarily nested AND/OR/NOT correctly", () => {
      const context = AttributeContext.create({
        subject: { role: "guest" },
        resource: { ownerId: "user-1", locked: true },
      });

      const tree = Condition.and([
        Condition.or([
          Condition.comparison("subject.role", "eq", "admin"),
          Condition.comparison("resource.ownerId", "eq", "user-1"),
        ]),
        Condition.not(Condition.comparison("resource.locked", "eq", true)),
      ]);

      expect(evaluateCondition(tree, context)).toBe(false);
    });
  });
});

describe("evaluateRule", () => {
  it("returns the rule's effect when the condition matches", () => {
    const r: Rule = {
      id: "allow-admin",
      effect: "PERMIT",
      condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
    };
    expect(evaluateRule(r, { role: "admin" })).toBe("PERMIT");
  });

  it("returns NOT_APPLICABLE when the condition does not match", () => {
    const r: Rule = {
      id: "allow-admin",
      effect: "PERMIT",
      condition: { type: "attribute", attribute: "role", operator: "equals", value: "admin" },
    };
    expect(evaluateRule(r, { role: "member" })).toBe("NOT_APPLICABLE");
  });

  it("returns DENY when a DENY rule's condition matches", () => {
    const r: Rule = {
      id: "deny-locked",
      effect: "DENY",
      condition: { type: "attribute", attribute: "locked", operator: "equals", value: true },
    };
    expect(evaluateRule(r, { locked: true })).toBe("DENY");
  it("delegates to evaluateCondition without consulting the rule's effect", () => {
    const context = AttributeContext.create({ subject: { role: "admin" } });
    const rule = Rule.create({
      effect: "DENY",
      condition: Condition.comparison("subject.role", "eq", "admin"),
    });

    expect(evaluateRule(rule, context)).toBe(true);
  });
});
