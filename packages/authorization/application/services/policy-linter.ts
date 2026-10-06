import type { Rule, PolicySet } from "../../domain/entities/rule.js";
import type { ComparisonCondition, Condition } from "../../domain/value-objects/condition.js";

/**
 * One flattened equality/inequality constraint pulled out of a rule's
 * condition tree, e.g. `subject.role equals "admin"`.
 *
 * Only `equals`/`notEquals` are represented — see {@link extractConstraints}
 * for why the other operators, and non-conjunctive conditions, are excluded
 * rather than approximated.
 */
interface Constraint {
  readonly attribute: string;
  readonly operator: "equals" | "notEquals";
  readonly value: unknown;
}

/**
 * Flattens a condition into its equivalent set of {@link Constraint}s if
 * (and only if) it is a conjunction (top-level `AND`, or a single leaf) of
 * `equals`/`notEquals` attribute comparisons. Returns `null` for anything
 * else: `OR`, `NOT`, nested `AND`s under an `OR`, or any comparison operator
 * other than `equals`/`notEquals` (`in`, ordering operators, `exists`).
 *
 * This is the linter's one real judgement call, and the reason its
 * false-positive/false-negative tradeoff is what it is (see the module
 * docstring on {@link lintPolicySet}): reasoning about overlap between two
 * arbitrary boolean condition trees is a satisfiability problem, not a
 * flattening problem, and a hand-rolled SAT solver is a lot of surface area
 * for a linter whose job is to catch the common cases cheaply and stay quiet
 * rather than guess on the rest. A pure conjunction of equality checks is the
 * shape the overwhelming majority of real ABAC rules take ("this role AND
 * this resource type AND this environment flag"), and it happens to be
 * exactly the shape for which "do these two conditions overlap" reduces to a
 * simple per-attribute comparison instead of a general boolean satisfiability
 * question. Anything wider is skipped rather than approximated, so the
 * linter never asserts a conflict or a shadow it cannot actually prove.
 */
function extractConstraints(condition: Condition): readonly Constraint[] | null {
  if (condition.kind === "comparison") {
    return extractLeafConstraint(condition);
  }

  if (condition.kind === "and") {
    const constraints: Constraint[] = [];
    for (const child of condition.operands) {
      const childConstraints = extractConstraints(child);
      if (childConstraints === null) return null;
      constraints.push(...childConstraints);
    }
    return constraints;
  }

  // `always`, `or`, and `not` conditions are not conjunctions of equality
  // comparisons and are deliberately left unanalyzed. `always` in particular
  // is not a missing case: a rule that always matches is exactly as broad as
  // a conjunction of zero constraints would be, but representing that as
  // `[]` here would make it compatible with (and implied by) everything,
  // which is correct for `implies` but wrong for `overlaps` -- an `always`
  // DENY and *any* PERMIT rule do overlap, which is worth a finding, not a
  // silent pass. Treating it as unanalyzed is the conservative choice this
  // linter makes everywhere else it cannot prove something cheaply.
  return null;
}

/**
 * The comparison operators this linter understands as equality or its
 * negation. `Condition`'s `ComparisonOperator` has others (`lt`, `in`,
 * `contains`, ...); a leaf using any of those is left unanalyzed for the same
 * reason `OR` and `NOT` are -- `implies`/`overlaps` below only know how to
 * reason about equals/not-equals.
 */
function extractLeafConstraint(condition: ComparisonCondition): readonly Constraint[] | null {
  if (condition.operator !== "eq" && condition.operator !== "neq") return null;
  const operator = condition.operator === "eq" ? "equals" : "notEquals";
  return [{ attribute: condition.attribute, operator, value: condition.value }];
}

/**
 * Whether every context that satisfies `narrower`'s constraints also
 * satisfies `broader`'s — i.e. `broader` is at least as permissive as
 * `narrower`, attribute by attribute.
 *
 * This holds when every constraint `broader` imposes also appears in
 * `narrower` (same attribute, same operator, same value) — `narrower` can add
 * constraints `broader` doesn't have, but cannot contradict or omit one
 * `broader` requires.
 */
function implies(broader: readonly Constraint[], narrower: readonly Constraint[]): boolean {
  return broader.every((requirement) =>
    narrower.some(
      (other) =>
        other.attribute === requirement.attribute &&
        other.operator === requirement.operator &&
        other.value === requirement.value,
    ),
  );
}

/**
 * Whether two constraint sets can be simultaneously satisfied by some
 * context — i.e. whether they contradict each other on any shared attribute.
 *
 * Two constraints on the same attribute are incompatible when one requires
 * `equals X` and the other requires `notEquals X` (or `equals Y` for
 * `X !== Y`), or symmetrically two different `equals` values for the same
 * attribute. Anything else (different attributes, or the same constraint
 * repeated) is compatible.
 */
function overlaps(a: readonly Constraint[], b: readonly Constraint[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left.attribute !== right.attribute) continue;

      if (left.operator === "equals" && right.operator === "equals") {
        if (left.value !== right.value) return false;
      } else if (left.operator === "notEquals" && right.operator === "notEquals") {
        // Two different exclusions on the same attribute are compatible
        // (a context can satisfy both by avoiding both values); identical
        // ones are trivially compatible too.
        continue;
      } else {
        // One equals, one notEquals, on the same attribute: incompatible
        // only if they name the same value.
        const equalsConstraint = left.operator === "equals" ? left : right;
        const notEqualsConstraint = left.operator === "equals" ? right : left;
        if (equalsConstraint.value === notEqualsConstraint.value) return false;
      }
    }
  }

  return true;
}

export type LinterFindingType = "conflict" | "shadow";

export interface LinterFinding {
  readonly type: LinterFindingType;
  /** The rules involved, in policy-set order. */
  readonly ruleIds: readonly [string, string];
  readonly message: string;
}

export interface LintResult {
  readonly findings: readonly LinterFinding[];
  /**
   * How many rule pairs could not be analyzed because at least one side's
   * condition fell outside the conjunction-of-equalities shape
   * {@link extractConstraints} handles. Surfaced explicitly (rather than
   * silently treated as "no finding") so a consumer of this linter's output
   * can tell "checked and clean" apart from "not actually checked" — the
   * documented false-negative tradeoff from `docs/guides/tools/policy-linting.md`.
   */
  readonly unanalyzedPairs: number;
}

/**
 * Inspects a policy set's rules, evaluated under `first-applicable` order,
 * for two classes of authoring mistakes:
 *
 * - **conflict**: a `PERMIT` rule and a `DENY` rule whose conditions can be
 *   simultaneously true, i.e. some request could match both. Under
 *   `first-applicable` only one of them will ever actually fire for such a
 *   request (whichever sorts first), but the fact that a request satisfying
 *   both exists at all means the rule set expresses genuinely contradictory
 *   intent — worth surfacing regardless of which rule happens to win.
 * - **shadow**: an earlier rule whose condition is implied by (is broader
 *   than or equal to) a later rule's condition, making the later rule
 *   unreachable under `first-applicable` — the earlier rule matches every
 *   request the later one would have, so evaluation never reaches it.
 *
 * Both checks are restricted to rule conditions expressible as a conjunction
 * of `equals`/`notEquals` attribute comparisons (see
 * {@link extractConstraints}). Pairs where either rule's condition uses `OR`,
 * `NOT`, or a non-equality operator are counted in
 * {@link LintResult.unanalyzedPairs} and never produce a finding — this
 * linter has no false positives by construction (every reported finding is a
 * provable overlap or a provable implication) at the cost of false negatives
 * on the condition shapes it doesn't attempt to reason about. That tradeoff,
 * and why it was made rather than attempting general boolean satisfiability,
 * is documented in `docs/guides/tools/policy-linting.md`.
 */
interface AnalyzedRule {
  readonly rule: Rule;
  readonly constraints: readonly Constraint[] | null;
}

export function lintPolicySet(policySet: PolicySet): LintResult {
  const findings: LinterFinding[] = [];
  let unanalyzedPairs = 0;

  // Analyzed once per rule up front — walking the whole policy set is O(n)
  // and the result (each rule's flattened constraints, or `null`) is reused
  // for every pair that rule appears in, rather than re-extracted for every
  // pair. Iterating pairs via `.entries()`/`.slice()` below (instead of
  // indexing `rules[i]`) keeps the loop free of numeric array indexing.
  const analyzed: AnalyzedRule[] = policySet.rules.map((rule) => ({
    rule,
    constraints: extractConstraints(rule.condition),
  }));

  for (const [position, earlier] of analyzed.entries()) {
    for (const later of analyzed.slice(position + 1)) {
      if (earlier.constraints === null || later.constraints === null) {
        unanalyzedPairs += 1;
        continue;
      }

      if (
        earlier.rule.effect !== later.rule.effect &&
        overlaps(earlier.constraints, later.constraints)
      ) {
        findings.push({
          type: "conflict",
          ruleIds: [earlier.rule.id, later.rule.id],
          message:
            `Rule "${earlier.rule.id}" (${earlier.rule.effect}) and rule "${later.rule.id}" ` +
            `(${later.rule.effect}) have overlapping conditions: some request could satisfy both, ` +
            "but they disagree on the effect.",
        });
      }

      if (implies(earlier.constraints, later.constraints)) {
        findings.push({
          type: "shadow",
          ruleIds: [earlier.rule.id, later.rule.id],
          message:
            `Rule "${earlier.rule.id}" is broader than (or equal to) rule "${later.rule.id}" and ` +
            `comes first, so rule "${later.rule.id}" can never be reached under first-applicable.`,
        });
      }
    }
  }

  return { findings, unanalyzedPairs };
}
