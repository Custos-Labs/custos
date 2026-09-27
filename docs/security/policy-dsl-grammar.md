# Policy DSL Grammar

`@verixa/authorization` implements an attribute-based access control (ABAC)
engine. This document describes the condition grammar rules are written in,
the semantics of evaluating a single rule against a request, and the
semantics of combining several rules' decisions into one.

This document covers the deterministic core built so far (Issues 146 and
148: the evaluation engine and the combining algorithms). It does not cover
attribute providers, resource-attribute resolution, or the
`AuthorizeAction`/`SimulatePolicy` use cases — those depend on work later in
Phase 08 that has not landed yet, and this document will grow to cover them
when it does.

## Data model

```ts
export type AttributeContext = Readonly<Record<string, unknown>>;

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

export interface AttributeCondition {
  readonly type: "attribute";
  readonly attribute: string; // dot-separated path, e.g. "subject.role"
  readonly operator: ComparisonOperator;
  readonly value?: unknown; // omitted for exists/notExists
}

export interface AndCondition {
  readonly type: "and";
  readonly conditions: readonly Condition[];
}

export interface OrCondition {
  readonly type: "or";
  readonly conditions: readonly Condition[];
}

export interface NotCondition {
  readonly type: "not";
  readonly condition: Condition;
}

export type Condition = AttributeCondition | AndCondition | OrCondition | NotCondition;

export interface Rule {
  readonly id: string;
  readonly effect: "PERMIT" | "DENY";
  readonly condition: Condition;
}
```

### Why a data structure, not a predicate function

A `Condition` is a plain, JSON-shaped tree — no closures, no functions — even
though a `(context) => boolean` predicate would have been a simpler way to
express "when does this rule apply." The tree pays for itself the moment
anything other than the evaluator needs to look at a condition without
running it: the policy linter (Issue 156, `packages/authorization/application/services/policy-linter.ts`)
inspects a rule's condition structurally to detect conflicts and shadowing,
and a future policy-authoring UI or `SimulatePolicy` use case will want to
render or explain a condition, not just execute it. None of that is possible
against an opaque closure.

### Attribute paths

An attribute is addressed by a dot-separated string path (`"subject.role"`,
`"resource.ownerId"`, `"environment.ipAllowlisted"`), looked up against an
`AttributeContext` — a flat map from string keys to `unknown` values.
`readAttribute` (`packages/authorization/domain/value-objects/attribute-context.ts`)
accepts a context built either as a flat map (`{ "subject.role": "admin" }`)
or as nested objects (`{ subject: { role: "admin" } }`); the former is what
attribute providers are expected to produce, the latter is what's convenient
to write by hand in a test fixture. Both resolve identically.

Missing segments resolve to `undefined` rather than throwing — see
"Evaluation semantics" below for why that matters for every operator except
`exists`/`notExists`.

## Evaluation semantics

`evaluate(rule, context): boolean` (`packages/authorization/domain/services/policy-evaluation-engine.ts`)
is a pure function: no I/O, no repository calls, and its result depends only
on its two arguments. That's a deliberate design constraint, not an
accident — it's what makes the 100% branch-coverage bar this module carries
achievable with plain object-literal test fixtures.

### AND/OR/NOT

- `AND` is true iff every child condition is true. An **empty** `AND` is
  vacuously true — the same convention XACML's `AllOf` and classical logic
  both use for an empty conjunction. This is also how a rule that matches
  every request is expressed in this DSL: `{ type: "and", conditions: [] }`.
  The policy linter treats such a rule as the broadest possible condition
  when checking for shadowing.
- `OR` is true iff at least one child condition is true. An **empty** `OR` is
  vacuously false, symmetrically.
- `NOT` inverts its single child condition.

`AND` and `OR` **short-circuit** left-to-right, using the host language's own
`&&`/`||` under the hood: a `false` branch partway through an `AND` (or a
`true` branch partway through an `OR`) stops evaluation of the remaining
children. This isn't only a performance optimization — it means a later
branch can safely assume an earlier branch's precondition already held (e.g.
`resource.ownerId exists AND resource.ownerId equals subject.id`) without the
condition tree needing its own null-guards.

### Comparison operators and missing attributes

Every operator except `exists`/`notExists` resolves to `false` when the
attribute it reads is missing (`undefined`) — **including `notEquals` and
`notIn`.**

This is worth calling out explicitly because the alternative reading is
tempting and wrong: "the attribute isn't equal to X because it isn't present
at all" would make `notEquals`/`notIn` resolve to `true` for a missing
attribute, which means an absent attribute would silently satisfy a `DENY`
rule guarded by `notEquals`. For an authorization engine, that's the more
dangerous of the two possible defaults. The rule adopted instead: a condition
that depends on an attribute the request doesn't supply cannot be positively
evaluated in either direction, so it doesn't match, full stop. An attribute
provider that fails to populate an attribute a policy depends on fails
closed, not open.

`exists`/`notExists` are the exception by design — they exist specifically so
a policy can express "this attribute must (not) be present" without needing
an arbitrary sentinel value to stand in for "missing."

Ordering operators (`greaterThan` and friends) additionally resolve to
`false` — rather than throwing — when the two operands aren't both numbers or
both strings. A policy misconfiguration (comparing a string attribute against
a numeric literal, say) should fail closed, not crash the request it's
guarding.

## Combining algorithms

A single request is rarely governed by one rule. `combine(algorithm, rules,
context)` (`packages/authorization/domain/services/combining-algorithms.ts`)
reduces every rule's individual `Decision` (`"PERMIT" | "DENY" |
"NOT_APPLICABLE"`) into one final decision for the policy set, using one of
three named strategies lifted directly from XACML's combining-algorithm
vocabulary:

| Algorithm          | Semantics                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `deny-overrides`   | `DENY` if any rule denies; else `PERMIT` if any rule permits; else `NOT_APPLICABLE`.               |
| `permit-overrides` | `PERMIT` if any rule permits; else `DENY` if any rule denies; else `NOT_APPLICABLE`.               |
| `first-applicable` | The effect of the first rule (in list order) whose condition matches; `NOT_APPLICABLE` if none do. |

Reusing XACML's names, rather than inventing new ones, means a contributor
who already knows XACML — or any ABAC system modelled on it — can bring that
knowledge here unchanged; see the "Why this is interesting" section of Issue
148 for the fuller argument.

### Order sensitivity

`deny-overrides` and `permit-overrides` evaluate every rule and never depend
on rule order — a policy author can reorder the rule list freely without
changing the outcome. `first-applicable` is the odd one out: it evaluates
rules in order and returns as soon as one matches, so _rule order is part of
the policy's meaning_ under this algorithm. That's also what makes rule
shadowing possible under `first-applicable` and not under the other two — see
`docs/guides/tools/policy-linting.md`.

### Default: `deny-overrides`

**`deny-overrides` is the system default** when a policy set doesn't specify
its own algorithm (`DEFAULT_COMBINING_ALGORITHM`).

The alternative seriously considered was `first-applicable`, since it's the
most expressive of the three (it can express "these rules act as an ordered
list of exceptions"). It was rejected as the _default_ specifically because
it makes rule order load-bearing for every policy set, including ones whose
author never intended order to matter — a rule list that happens to get
resorted (alphabetically, say, by a future tooling change) would silently
change authorization outcomes under `first-applicable` in a way it never
would under `deny-overrides` or `permit-overrides`. `first-applicable` stays
available for policy sets that deliberately want ordered, exception-style
rules; it simply isn't what a policy set gets by omitting a choice.

Between the two order-independent algorithms, `deny-overrides` was chosen
over `permit-overrides` because an authorization engine's failure mode should
favor safety: when two rules disagree about the same request and nothing in
the policy set says which should win, the request should be denied rather
than permitted.

## Combining-algorithm fixtures

The test suite (`combining-algorithms.spec.ts`) exercises all three
algorithms against the three canonical conflicting-rule shapes the
acceptance criteria call for:

- **permit + deny** (contradictory rules, both applicable to the same
  request) — `deny-overrides` denies, `permit-overrides` permits,
  `first-applicable` follows list order.
- **permit + permit** — every algorithm permits.
- **all not-applicable** — every algorithm returns `NOT_APPLICABLE`.
