/**
 * Comparison operators a leaf {@link AttributeCondition} can apply between an
 * attribute's runtime value and the condition's literal `value`.
 *
 * `exists`/`notExists` are the only operators that don't compare against a
 * value — they exist so a policy can express "this attribute must (not) be
 * present" without an arbitrary sentinel value standing in for "missing".
 */
export type ComparisonOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "exists"
  | "notExists";

/** A leaf condition: compare one attribute against a literal. */
export interface AttributeCondition {
  readonly type: "attribute";
  readonly attribute: string;
  readonly operator: ComparisonOperator;
  /** Omitted for `exists`/`notExists`, which take no comparison value. */
  readonly value?: unknown;
}

/** Vacuously true when `conditions` is empty — see {@link evaluate}. */
export interface AndCondition {
  readonly type: "and";
  readonly conditions: readonly Condition[];
}

/** Vacuously false when `conditions` is empty — see {@link evaluate}. */
export interface OrCondition {
  readonly type: "or";
  readonly conditions: readonly Condition[];
}

export interface NotCondition {
  readonly type: "not";
  readonly condition: Condition;
}

/**
 * The condition tree a {@link Rule} evaluates against an
 * {@link AttributeContext}. Deliberately a closed, serializable data
 * structure (JSON-shaped, no functions) rather than a predicate closure —
 * see `docs/security/policy-dsl-grammar.md` for why: it is what lets the
 * policy linter (Issue 156) inspect a condition's structure instead of only
 * being able to execute it.
 */
export type Condition = AttributeCondition | AndCondition | OrCondition | NotCondition;
