import type { Condition } from "../value-objects/condition.js";
import type { Effect } from "../value-objects/decision.js";

/**
 * A single policy rule: "if `condition` holds, apply `effect`."
 *
 * Not a class with behaviour of its own deliberately — a `Rule` is a plain
 * data record because both the evaluation engine (Issue 146) and the linter
 * (Issue 156) need to treat it as inert data they inspect and combine, never
 * as an object that evaluates itself. Keeping the evaluation logic in
 * `policy-evaluation-engine.ts` as a free function (rather than a
 * `rule.evaluate(context)` method) is what lets the combining algorithms
 * (Issue 148) and the linter share one interpretation of what a rule means
 * without depending on each other.
 */
export interface Rule {
  readonly id: string;
  readonly effect: Effect;
  readonly condition: Condition;
}

/** An ordered set of rules combined by a single {@link CombiningAlgorithm}. */
export interface PolicySet {
  readonly id: string;
  readonly rules: readonly Rule[];
}
