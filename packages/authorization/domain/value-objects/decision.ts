/** The effect a matching rule applies: grant or deny the request. */
export type Effect = "PERMIT" | "DENY";

/**
 * The outcome of evaluating a single rule (or a whole policy set) against a
 * request: its effect if the rule matched, or `NOT_APPLICABLE` if it didn't.
 *
 * A third state distinct from "denied" matters here — XACML's vocabulary,
 * which this type mirrors (see Issue 148's "why this is interesting"). A rule
 * that simply doesn't apply to a request is not the same fact as a rule that
 * applies and says no; collapsing them would make `first-applicable`
 * combining impossible to express (it needs to keep looking past
 * `NOT_APPLICABLE` rules, but must stop at the first `PERMIT`/`DENY`).
 */
export type Decision = Effect | "NOT_APPLICABLE";
