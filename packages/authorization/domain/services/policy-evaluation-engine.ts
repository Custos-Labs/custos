import type { Rule } from "../entities/rule.js";
import { readAttribute, type AttributeContext } from "../value-objects/attribute-context.js";
import type {
  AttributeCondition,
  ComparisonOperator,
  Condition,
} from "../value-objects/condition.js";
import type { Decision } from "../value-objects/decision.js";

/**
 * Compares an attribute's runtime value against a leaf condition's literal
 * using `operator`.
 *
 * Two deliberate choices here, both driven by keeping {@link evaluate} total
 * (never throwing) so a malformed or partially-populated context degrades to
 * "doesn't match" rather than crashing the request it's guarding:
 *
 * - Every operator except `exists`/`notExists` resolves to `false` when the
 *   attribute is missing (`undefined`), including `notEquals` and `notIn`.
 *   `notEquals` might look like it should default to `true` for a missing
 *   attribute ("it's not equal to X because it isn't there at all"), but that
 *   reading makes an absent attribute silently satisfy a `DENY` rule guarded
 *   by `notEquals` — the more dangerous default for an authorization engine.
 *   Requiring the attribute to be present is the conservative choice: a
 *   condition that depends on an attribute the request doesn't supply cannot
 *   be positively evaluated either way, so it doesn't match.
 * - Ordering operators (`greaterThan` and friends) resolve to `false` for
 *   operand types that don't have a meaningful order (e.g. one side is an
 *   object) rather than throwing on an invalid comparison — a policy
 *   misconfiguration should fail closed, not crash the caller.
 */
function compare(actual: unknown, operator: ComparisonOperator, expected: unknown): boolean {
  switch (operator) {
    case "exists":
      return actual !== undefined;
    case "notExists":
      return actual === undefined;
    case "equals":
      return actual !== undefined && actual === expected;
    case "notEquals":
      return actual !== undefined && actual !== expected;
    case "in":
      return actual !== undefined && Array.isArray(expected) && expected.includes(actual);
    case "notIn":
      return actual !== undefined && Array.isArray(expected) && !expected.includes(actual);
    case "greaterThan":
    case "greaterThanOrEqual":
    case "lessThan":
    case "lessThanOrEqual":
      return compareOrdered(actual, operator, expected);
    default: {
      const exhaustive: never = operator;
      throw new Error(`Unknown comparison operator: ${String(exhaustive)}`);
    }
  }
}

function compareOrdered(
  actual: unknown,
  operator: "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual",
  expected: unknown,
): boolean {
  if (
    actual === undefined ||
    (typeof actual !== "number" && typeof actual !== "string") ||
    (typeof expected !== "number" && typeof expected !== "string") ||
    typeof actual !== typeof expected
  ) {
    return false;
  }

  switch (operator) {
    case "greaterThan":
      return actual > expected;
    case "greaterThanOrEqual":
      return actual >= expected;
    case "lessThan":
      return actual < expected;
    case "lessThanOrEqual":
      return actual <= expected;
  }
}

function evaluateAttribute(condition: AttributeCondition, context: AttributeContext): boolean {
  const actual = readAttribute(context, condition.attribute);
  return compare(actual, condition.operator, condition.value);
}

/**
 * Walks a {@link Condition} tree against an {@link AttributeContext} and
 * returns whether it holds.
 *
 * Pure and side-effect-free by construction: it only reads from `context` and
 * `condition`, calls no I/O, and its result depends solely on its arguments.
 * That is what makes 100% branch coverage a realistic bar (Issue 146's
 * acceptance criteria) — every path through the tree is reachable from a
 * plain object literal, with no database or clock to fake.
 *
 * `AND`/`OR` short-circuit left-to-right using the language's own `&&`/`||`,
 * so a `false` branch partway through an `AND` (or a `true` branch partway
 * through an `OR`) stops evaluation of the remaining conditions rather than
 * evaluating them for a result that can no longer change the outcome. This
 * matters beyond performance: it means later branches may reference
 * attributes that are only guaranteed present once an earlier branch has
 * already confirmed some precondition (e.g. `resource.ownerId exists AND
 * resource.ownerId equals subject.id`) without needing null-guards baked into
 * the condition tree itself.
 */
export function evaluate(rule: Rule, context: AttributeContext): boolean {
  return evaluateCondition(rule.condition, context);
}

function evaluateCondition(condition: Condition, context: AttributeContext): boolean {
  switch (condition.type) {
    case "attribute":
      return evaluateAttribute(condition, context);
    case "and":
      // `Array#every` on an empty array is `true` — an AND of zero
      // conditions is vacuously satisfied, which is the same convention
      // classical logic and every mainstream policy language (including
      // XACML's AllOf) use for an empty conjunction. This is also how a
      // "matches everything" rule is expressed in this DSL (see the linter's
      // shadowing detection, which treats it as the broadest possible rule).
      return condition.conditions.every((child) => evaluateCondition(child, context));
    case "or":
      // Symmetrically, an OR of zero conditions is vacuously false.
      return condition.conditions.some((child) => evaluateCondition(child, context));
    case "not":
      return !evaluateCondition(condition.condition, context);
  }
}

/**
 * Evaluates a single rule to a {@link Decision}: its effect if the condition
 * holds, `NOT_APPLICABLE` otherwise.
 *
 * This is the bridge between {@link evaluate}'s boolean world and the
 * combining algorithms' three-valued one (Issue 148) — kept here rather than
 * duplicated in `combining-algorithms.ts` so both the engine and every
 * combining algorithm agree on exactly one place where "does this rule apply"
 * turns into "what does the policy set decide."
 */
export function evaluateRule(rule: Rule, context: AttributeContext): Decision {
  return evaluate(rule, context) ? rule.effect : "NOT_APPLICABLE";
}
