// Curated public surface of @verixa/authorization. Nothing outside this
// package should import from a deep path — see
// docs/guides/domain-modeling.md ("Package encapsulation") and
// eslint.config.mjs's `no-restricted-imports` rule.

// Domain: value objects
export type { AttributeContext } from "./domain/value-objects/attribute-context.js";
export { readAttribute } from "./domain/value-objects/attribute-context.js";
export type {
  AndCondition,
  AttributeCondition,
  ComparisonOperator,
  Condition,
  NotCondition,
  OrCondition,
} from "./domain/value-objects/condition.js";
export type { Decision, Effect } from "./domain/value-objects/decision.js";

// Domain: entities
export type { PolicySet, Rule } from "./domain/entities/rule.js";

// Domain: services
export { evaluate, evaluateRule } from "./domain/services/policy-evaluation-engine.js";
export {
  combine,
  denyOverrides,
  DEFAULT_COMBINING_ALGORITHM,
  firstApplicable,
  permitOverrides,
} from "./domain/services/combining-algorithms.js";
export type { CombiningAlgorithm } from "./domain/services/combining-algorithms.js";

// Application: services
export { lintPolicySet } from "./application/services/policy-linter.js";
export type {
  LinterFinding,
  LinterFindingType,
  LintResult,
} from "./application/services/policy-linter.js";
