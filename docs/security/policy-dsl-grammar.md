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
# Policy DSL grammar

This document defines the small expression language used to describe ABAC
policies. It deliberately handles expressions rather than declarations,
variables, or arbitrary code: authorization rules need to be readable and
auditable, and a constrained grammar makes their meaning predictable.

## Grammar

The grammar is EBNF. Terminals in quotes are literal tokens; `#` starts a
comment through the end of a line. Keywords are case-sensitive.

```ebnf
policy       = effect, "if", expression ;
effect       = "permit" | "deny" ;
expression   = disjunction ;
disjunction  = conjunction, { "or", conjunction } ;
conjunction  = negation, { "and", negation } ;
negation     = [ "not" ], comparison ;
comparison  = primary, [ comparison-op, primary ] ;
comparison-op = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in"
              | "contains" | "matches" ;
primary      = literal | attribute | "(", expression, ")"
              | function-call ;
function-call = identifier, "(", [ arguments ], ")" ;
arguments    = expression, { ",", expression } ;
attribute    = bag, ".", identifier, { ".", identifier } ;
bag          = "subject" | "resource" | "action" | "environment" ;
literal      = string | number | "true" | "false" | "null"
             | date | array ;
array        = "[", [ literal, { ",", literal } ], "]" ;
string       = '"', { escaped-character | non-quote-character }, '"' ;
number       = [ "-" ], digit, { digit }, [ ".", digit, { digit } ] ;
date         = "date(", string, ")" ;
identifier   = letter, { letter | digit | "_" } ;
```

Attribute paths start with one of the four standard ABAC bags. Further path
segments are resolved as nested object properties by the attribute context;
missing segments evaluate as missing values. A date literal is an ISO-8601
string wrapped in `date(...)`, validated as a date when parsed. Arrays contain
literals only, which keeps membership checks deterministic and avoids hidden
evaluation in data literals.

## Operators and precedence

From highest to lowest precedence:

| Precedence | Operators                                                     | Associativity                                 |
| ---------- | ------------------------------------------------------------- | --------------------------------------------- |
| 1          | parentheses, function calls, attribute access                 | left to right                                 |
| 2          | `not`                                                         | right to left                                 |
| 3          | `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `matches` | non-associative; chain comparisons with `and` |
| 4          | `and`                                                         | left to right                                 |
| 5          | `or`                                                          | left to right                                 |

`and` binds more tightly than `or`, so `a or b and c` means `a or (b and c)`.
Comparisons do not chain: `a < b < c` is invalid. Use
`a < b and b < c` to make the intent explicit. `matches` takes a string on the
right and interprets it as a regular expression; invalid patterns are rejected
when a policy is parsed. Operators do not coerce types: equality between
different types is false (and inequality is true), while ordering, membership,
containment, and matching with incompatible types evaluate false.

## Attribute model

An attribute reference is `bag.name` or a nested path such as
`resource.owner.id`:

| Bag           | Meaning                       | Typical values                                |
| ------------- | ----------------------------- | --------------------------------------------- |
| `subject`     | Principal making the request  | `id`, `orgId`, `roles`, `emailVerified`       |
| `resource`    | Object being accessed         | `ownerId`, `orgId`, `status`, `availableFrom` |
| `action`      | Operation being requested     | `name`, `resource`, `method`                  |
| `environment` | Request and execution context | `now`, `ip`, `userAgent`, `requestId`         |

All bags are typed maps. Supported values are strings, finite numbers,
booleans, dates, arrays, and nested records made from those values. Looking up
a missing path produces an undefined value; it never throws. Evaluation of a
comparison involving a missing value is false, including `!=`, so missing
information cannot accidentally grant access. `not` applies to boolean
expressions and follows the same fail-closed rule when its operand cannot be
evaluated.

## Functions

Functions are deliberately allowlisted by the evaluator. The initial helper is
`between(value, start, end)`, an inclusive comparison (`start <= value <= end`)
for date or number values. It supports time-window policies without embedding
the system clock: policies compare an explicit `environment.now` attribute,
which request construction supplies from the application's clock port. Unknown
functions, wrong arity, invalid dates, and malformed regex patterns are
rejected during parsing.

## Attribute sourcing

The evaluation engine consumes an `AttributeContext`; it does not fetch data.
An application-layer `AttributeProvider` contributes context bags from one
source. Providers run in registration order and later values override earlier
values at the same path. Register trusted server-derived data after
request-supplied claims so callers cannot overwrite verified identity or
resource facts. A provider declares whether failure is `fail-open` or
`fail-closed`: optional enrichment can be skipped, while a source required for
an authorization invariant must fail the resolution. The pipeline preserves
that distinction and never silently treats a failed required source as an
empty bag.

## Examples

Each example is a complete policy expression after the `if` keyword.

1. **Resource ownership:** `permit if resource.ownerId == subject.id`
2. **Read-only access:** `permit if action.name == "read"`
3. **Organization boundary:** `permit if resource.orgId == subject.orgId`
4. **Verified account:** `permit if subject.emailVerified == true`
5. **Active resource:** `permit if resource.status == "active"`
6. **Organization admin:** `permit if subject.roles contains "org-admin" and resource.orgId == subject.orgId`
7. **Time window:** `permit if between(environment.now, resource.availableFrom, resource.availableUntil)`
8. **Business hours:** `permit if environment.hour >= 9 and environment.hour < 17`
9. **Network allowlist:** `permit if environment.ip in ["192.0.2.10", "192.0.2.11"]`
10. **Sensitive action requires MFA:** `permit if action.name != "delete" or subject.mfaSatisfied == true`
11. **Deny suspended subjects:** `deny if subject.status == "suspended"`
12. **Nested resource owner:** `permit if resource.owner.id == subject.id and action.name == "update"`

These examples use `environment.now` and other request facts as explicit
attributes. This keeps decisions reproducible in tests and audit replays: the
same context always produces the same result.

# Policy DSL Grammar

This document is the reference for `packages/authorization`'s ABAC policy
DSL — grammar, attribute sourcing, evaluation semantics, and operators. It
grows section by section as later Phase 08 issues land (the grammar itself
is Issue 142, the parser Issue 143, the attribute model Issues 144-145, the
evaluator Issue 146, operators Issue 147). Resource-attribute resolution
(Issue 151) is documented below since its implementation exists ahead of
the sections it depends on.

## Resource-attribute resolution

A policy condition can reference a resource's own attributes — `resource.ownerId`,
`resource.sensitivity`, `resource.status` — but `packages/authorization` has
no schema for a `document` or a `verificationCase`; those belong to
`packages/verification`, `packages/governance`, and every other bounded
context that owns a resource type policies might target.

`ResourceAttributeResolverRegistry`
(`packages/authorization/application/services/resource-attribute-resolver-registry.ts`)
is the seam that resolves this without creating a dependency in either
direction beyond the one port:

```ts
import type { ResourceAttributeResolver } from "@verixa/authorization";

// Implemented inside packages/verification, not packages/authorization.
const verificationCaseResolver: ResourceAttributeResolver = {
  async resolve(resourceId) {
    const verificationCase = await verificationCaseRepository.findById(asId(resourceId));
    return {
      ownerId: verificationCase.ownerId,
      status: verificationCase.status,
    };
  },
};

// Registered from composition-root wiring (Issue 157), once at startup.
registry.register("verificationCase", verificationCaseResolver);
```

At evaluation time, the engine (Issue 146) calls
`registry.resolve("verificationCase", resourceId)` and gets back a plain
`ResourceAttributes` map — it never imports anything from
`packages/verification` itself. This is the dependency direction
`ARCHITECTURE.md` §4 requires: contexts that own resources depend on and
register with `packages/authorization`; `packages/authorization` never
depends on them.

### Why a registry, not a lookup table of imports

The alternative — `packages/authorization` importing each context's
repository directly and switching on resource type — would work, but it
inverts the dependency graph specified in `ARCHITECTURE.md` §4: the
authorization context (which every other context needs to call into for
`AuthorizeAction`, Issue 153) would end up depending on all of them,
creating exactly the import cycle that architecture forbids. The registry
pattern keeps `packages/authorization` at the bottom of the dependency
graph: it defines a port, and everyone else implements and registers
against it.

### Unknown resource types fail loudly

`registry.resolve(resourceType, resourceId)` throws
`UnknownResourceTypeError` — naming the unresolved `resourceType` — rather
than resolving to `undefined` or an empty attribute set. A policy silently
evaluating with no resource attributes at all is a much more dangerous
failure mode than an exception: depending on how the policy is written, an
empty attribute set can make a `DENY` rule fail to match and fall through to
an unrelated `PERMIT`, silently over-granting. Registration bugs (a new
resource type added to a policy target without a matching resolver
registered anywhere) should surface immediately in tests and staging, not
manifest later as an authorization bug that looks like correct code
enforcing an incorrect policy — see `docs/security/threat-model-abac.md`
(Issue 159) once it exists.

### Registering twice for the same resource type

`register` overwrites rather than throwing on a duplicate registration for
the same resource type. Composition-root wiring runs once, in a fixed
order, at process startup — a second registration in that context is far
more likely to be a deliberate override (test setup swapping in a fake
resolver) than a bug worth crashing startup over.

## Attribute model

`AttributeContext` (`packages/authorization/domain/value-objects/attribute-context.ts`,
Issue 144) is the shape every condition is evaluated against: four typed
bags — `subject`, `resource`, `action`, `environment` — the same
categorization NIST SP 800-162 uses, so the vocabulary is legible to anyone
who already knows ABAC theory.

```ts
const context = AttributeContext.create({
  subject: { id: "user-1", role: "admin" },
  resource: { ownerId: "user-2", sensitivity: "high" },
  action: { name: "read" },
  environment: { requestedAt: new Date() },
});

context.get("subject", "role"); // "admin"
context.get("subject", "nonexistent"); // undefined — never throws
context.resolve("resource.ownerId"); // "user-2" — the dotted-path form Condition.comparison's `attribute` field uses
```

A missing attribute resolves to `undefined`, never throws — both `get` and
`resolve` are total functions over any category/key or dotted path,
including one that names a category nothing supplied a bag for (it's simply
empty) or doesn't match any of the four categories at all (`resolve`
returns `undefined` rather than guessing). This is what lets the evaluation
engine below treat "attribute wasn't supplied" as an ordinary, defined
outcome (a comparison that evaluates to `false`) instead of a special case
it has to guard against.

_Attribute sourcing_ — how each bag actually gets populated from Identity
records, request claims, and resource lookups (this doc's resource-attribute
section above covers the last of those) — is `AttributeProvider`'s job,
Issue 145, not yet built.

## Evaluation semantics

`evaluateCondition` (`packages/authorization/domain/services/policy-evaluation-engine.ts`,
Issue 146) is a pure function: no I/O, no repository calls, walking a
`Condition` tree against an `AttributeContext` and returning a `boolean`.
Purity is what makes exhaustive branch-coverage testing of authorization
logic tractable — an evaluator that can also fail on a network call has a
failure mode no unit test can exercise deterministically.

- **Short-circuiting**: `AND` uses `Array.prototype.every`, `OR` uses
  `Array.prototype.some` — both bail out of the remaining operands as soon
  as the overall result is decided, so a comparison later in an `AND` never
  runs once an earlier one is `false` (verified directly in
  `policy-evaluation-engine.spec.ts` via a spy operand that must not be
  read).
- **Missing attributes evaluate to `false`**, never throw — a comparison
  against an attribute nobody supplied is the same "this rule doesn't
  apply" outcome as one that resolved and didn't match, not a distinct
  error condition the caller has to guard against.
- **Type mismatches evaluate to `false`**, not coerced — comparing a number
  operator (`lt`/`lte`/`gt`/`gte`) against a non-numeric, non-`Date`
  attribute, or `eq`/`neq` against mismatched array-vs-scalar shapes, never
  silently succeeds via implicit coercion. This is the same rationale
  Issue 147's operator library will formalize further; this evaluator
  anticipates it minimally so it's usable today.

`evaluateRule` evaluates a `Rule`'s condition alone — it does not consult
`rule.effect`. Turning "did this rule's condition match" into a
`PERMIT`/`DENY`/`NOT_APPLICABLE` outcome is the combining-algorithm layer's
job, covered next.

## Combining algorithms

A policy can have several rules, and a resource type can have several
applicable policies — `combining-algorithms.ts` (Issue 148) reduces all of
their outcomes to one final decision. `deriveRuleOutcomes` maps each rule to
`rule.effect` if its condition matched, `NOT_APPLICABLE` otherwise; a
`CombiningAlgorithm` then reduces the full outcome list:

| Algorithm                                                                        | Rule                                                       | When to use it                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `denyOverrides` (**system default**, see `docs/security/authorization-model.md`) | any `DENY` wins over any `PERMIT`                          | Safety-favoring; one applicable deny should never be overridable by a more permissive rule elsewhere in the same set. |
| `permitOverrides`                                                                | any `PERMIT` wins over any `DENY`                          | Policy sets designed to be permissive-by-default.                                                                     |
| `firstApplicable`                                                                | the first non-`NOT_APPLICABLE` outcome wins, in rule order | Rule _order_ is meaningful and intentional — the other two algorithms are order-independent.                          |

All three return `NOT_APPLICABLE` when every input outcome is
`NOT_APPLICABLE` — "nothing had an opinion" is preserved rather than
defaulted to a `PERMIT` or `DENY` here; `AuthorizationService`
(`docs/security/authorization-model.md`) is where a fail-closed default is
actually applied, one layer up, once RBAC's opinion (or lack of one) is
also known.

These names are lifted directly from the XACML standard's
combining-algorithm vocabulary rather than invented — reusing established
names lets contributors bring prior ABAC knowledge to this code instead of
re-learning Verixa-specific terminology for a well-understood concept.
