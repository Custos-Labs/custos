# Policy Linting

`lintPolicySet` (`packages/authorization/application/services/policy-linter.ts`)
is a static-analysis tool over a `PolicySet` — it never evaluates a rule
against a real request, and reads only the condition trees themselves. It
exists to catch two classes of authoring mistakes at write time, before they
become a security incident or a support ticket about an authorization
decision nobody can explain:

- **Conflict** — a `PERMIT` rule and a `DENY` rule whose conditions can be
  simultaneously true for some request, i.e. the rule set expresses
  contradictory intent about that request.
- **Shadowing** — an earlier rule whose condition is implied by (broader
  than, or equal to) a later rule's condition, so the later rule can never
  be reached under `first-applicable` evaluation order — see
  `docs/security/policy-dsl-grammar.md` for why order only matters under that
  algorithm.

```ts
const result = lintPolicySet(policySet);
// result.findings: readonly LinterFinding[]
// result.unanalyzedPairs: number
```

## What the linter can and can't reason about

Reasoning about overlap between two arbitrary boolean condition trees is a
general boolean satisfiability problem, not a simple structural comparison.
This linter deliberately does not attempt to solve it in general. Instead, it
only analyzes rule conditions that are (or flatten to) a **conjunction of
`equals`/`notEquals` attribute comparisons** — e.g. `role equals "admin" AND
orgId equals "org-1"`, or a single such comparison on its own.

For that shape, and only that shape, "do these two conditions overlap" and
"does this condition imply that one" both reduce to a straightforward,
attribute-by-attribute comparison of two constraint sets:

- Two constraint sets **overlap** (some request can satisfy both) unless they
  contain contradictory constraints on the same attribute — an `equals X` and
  an `equals Y` for `X !== Y`, or an `equals X` and a `notEquals X`. Two
  different `notEquals` exclusions on the same attribute are compatible (a
  context can avoid both values at once).
- One constraint set **implies** another when every constraint in the first
  also appears in the second — the second can only add constraints, never
  contradict or drop one the first requires.

A rule whose condition uses `OR`, `NOT`, or any comparison operator other
than `equals`/`notEquals` (`in`, the ordering operators, `exists`) is left
unanalyzed. So is any pair where either rule falls into that category. These
pairs are counted in `LintResult.unanalyzedPairs` rather than silently
treated as "no finding," so a caller can tell "checked and found nothing"
apart from "not actually checked."

### Why this tradeoff, and not a general solver

A hand-rolled SAT solver is a lot of surface area — and a lot of ways to be
subtly wrong — for a linter whose job is to catch the common cases cheaply
and stay quiet on the rest, rather than guess. A pure conjunction of equality
checks also happens to be the shape the overwhelming majority of real ABAC
rules take in practice ("this role AND this resource type AND this
environment flag"), which is exactly the shape for which the overlap/implies
questions have a cheap, provably-correct answer instead of an
exponential-in-the-worst-case one.

**The false-positive rate is zero by construction.** Every finding this
linter reports is a provable overlap or a provable implication — there is no
condition shape for which it asserts a conflict or a shadow it cannot
actually demonstrate with the constraint-set reasoning above. The cost is
false negatives: a genuine conflict or shadow hidden behind an `OR`, a `NOT`,
or a non-equality operator will not be flagged, and will show up instead as
an unanalyzed pair. This tradeoff was chosen deliberately over the reverse
(attempting to approximate wider condition shapes and risking a false
positive) — a linter that cries wolf on legitimate policy sets is one authors
learn to ignore, which defeats the point of running it at all.

## Known-good and known-conflict fixtures

`policy-linter.spec.ts` includes:

- A **known-good** fixture set (three rules, each with a distinct
  discriminating attribute) that produces zero findings and zero unanalyzed
  pairs — proving the linter doesn't cry wolf on a clean policy set.
- A **known-conflict** fixture set seeding both a direct conflict (a `PERMIT`
  and a `DENY` rule sharing an attribute-equality condition) and a shadow (a
  broad early rule and a narrower later one for the same effect) — proving
  the linter catches both documented classes of issue in one pass.
- Targeted cases for each `notEquals` overlap combination, empty-condition
  ("matches everything") rules, and conditions nested under `AND`/`OR`/`NOT`
  that fall outside the analyzable shape.

## Where this is exposed today

This is a library function, not yet a CLI command. `apps/cli` (Phase 17,
issue range 321–340) doesn't exist in this codebase yet, so there is no
`policy-lint` command to wire it into. Exposing `lintPolicySet` as a
well-tested, documented library function now — callable directly from
application code, an integration test, or a future CLI command without any
changes — was the pragmatic scoping call: it delivers the acceptance
criteria this issue is actually about (the linter finds the two documented
issue classes, with a stated false-positive/false-negative tradeoff) without
scaffolding an entire new application around it. Wiring a `policy-lint` CLI
command is straightforward once `apps/cli` exists, and is left to whichever
issue introduces that app.
