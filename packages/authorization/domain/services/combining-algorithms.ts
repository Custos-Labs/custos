import type { Rule } from "../entities/rule.js";
import type { AttributeContext } from "../value-objects/attribute-context.js";
import type { Decision } from "../value-objects/decision.js";

import { evaluateRule } from "./policy-evaluation-engine.js";

/**
 * Named strategies for reducing several rules' individual decisions into one
 * final decision for a policy set, lifted directly from XACML's
 * combining-algorithm vocabulary (see `docs/security/policy-dsl-grammar.md`
 * for the full rationale). Reusing those names rather than inventing new ones
 * means a contributor who already knows XACML, or any ABAC system modelled on
 * it, can bring that knowledge here unchanged.
 *
 * - `deny-overrides` — any `DENY` wins, regardless of how many rules
 *   `PERMIT`. The default for the system (see {@link DEFAULT_COMBINING_ALGORITHM}).
 * - `permit-overrides` — any `PERMIT` wins, regardless of how many rules
 *   `DENY`. The inverse of the above; useful for policy sets composed
 *   entirely of narrow, deliberately-ordered exceptions.
 * - `first-applicable` — the first rule (in list order) whose condition
 *   matches wins outright; every rule after it is not evaluated for its
 *   effect on the outcome. This is the only order-sensitive algorithm of the
 *   three, which is exactly what makes rule shadowing (Issue 156) possible
 *   under it and not under the other two.
 */
export type CombiningAlgorithm = "deny-overrides" | "permit-overrides" | "first-applicable";

/**
 * The system default when a policy set does not specify its own algorithm.
 *
 * `deny-overrides` was chosen over `permit-overrides` or `first-applicable`
 * because an authorization engine's failure mode should favor safety: when
 * two rules disagree about the same request and nothing in the policy set
 * says which should win, the request should be denied rather than permitted.
 * `first-applicable` was rejected as the default for a different reason —
 * it makes the *order rules happen to be listed in* load-bearing for every
 * policy set, including ones whose author never intended rule order to
 * matter. `first-applicable` remains available for the policy sets that
 * genuinely want ordered, exception-style rules; it just isn't what a policy
 * set silently gets by omitting a choice.
 */
export const DEFAULT_COMBINING_ALGORITHM: CombiningAlgorithm = "deny-overrides";

/**
 * `DENY` if any rule evaluates to `DENY`; else `PERMIT` if any rule evaluates
 * to `PERMIT`; else `NOT_APPLICABLE` if every rule was `NOT_APPLICABLE`.
 *
 * Evaluates every rule rather than stopping at the first `DENY` — unlike
 * `first-applicable`, this algorithm's result never depends on rule order, so
 * short-circuiting would only be a performance micro-optimization, and a
 * questionable one: it would make the number of rules actually evaluated
 * (and hence any side effects a future obligation/audit hook attaches to
 * evaluation) depend on where the first `DENY` happens to sit in the list.
 */
export function denyOverrides(rules: readonly Rule[], context: AttributeContext): Decision {
  let sawPermit = false;

  for (const rule of rules) {
    const decision = evaluateRule(rule, context);
    if (decision === "DENY") return "DENY";
    if (decision === "PERMIT") sawPermit = true;
  }

  return sawPermit ? "PERMIT" : "NOT_APPLICABLE";
}

/**
 * `PERMIT` if any rule evaluates to `PERMIT`; else `DENY` if any rule
 * evaluates to `DENY`; else `NOT_APPLICABLE`.
 *
 * The mirror image of {@link denyOverrides}; see its docstring for why every
 * rule is evaluated regardless of order.
 */
export function permitOverrides(rules: readonly Rule[], context: AttributeContext): Decision {
  let sawDeny = false;

  for (const rule of rules) {
    const decision = evaluateRule(rule, context);
    if (decision === "PERMIT") return "PERMIT";
    if (decision === "DENY") sawDeny = true;
  }

  return sawDeny ? "DENY" : "NOT_APPLICABLE";
}

/**
 * The effect of the first rule (in list order) whose condition matches, or
 * `NOT_APPLICABLE` if none do.
 *
 * Unlike the other two algorithms, this one *must* short-circuit — stopping
 * at the first match is the algorithm, not an optimization of it. Evaluating
 * further rules after a match would not change the returned decision, but it
 * would change which rules the linter's shadowing analysis (Issue 156) can
 * observe as "reached," so the short-circuit here and the linter's static
 * reasoning about the same semantics need to agree.
 */
export function firstApplicable(rules: readonly Rule[], context: AttributeContext): Decision {
  for (const rule of rules) {
    const decision = evaluateRule(rule, context);
    if (decision !== "NOT_APPLICABLE") return decision;
  }

  return "NOT_APPLICABLE";
}

/** Dispatches to the named algorithm. See each function's docstring for its semantics. */
export function combine(
  algorithm: CombiningAlgorithm,
  rules: readonly Rule[],
  context: AttributeContext,
): Decision {
  switch (algorithm) {
    case "deny-overrides":
      return denyOverrides(rules, context);
    case "permit-overrides":
      return permitOverrides(rules, context);
    case "first-applicable":
      return firstApplicable(rules, context);
  }
}
