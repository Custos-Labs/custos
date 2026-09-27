# Composition Root

`apps/api/src/composition-root.ts` is the one file in the system allowed to
know which concrete implementations exist. Everything else — use cases,
domain services, route handlers — depends on interfaces (`UserRepository`,
`PasswordHasher`, `CombiningAlgorithm`), never on a `Prisma*` class or a
specific adapter directly.

That is what makes the application layer testable without a database: a use
case can be exercised against an in-memory fake because it never imported
Prisma in the first place. The inversion only holds because "which
implementation" is concentrated in one place instead of scattered across every
module that needs a repository.

**The rule to preserve: nothing outside `composition-root.ts` imports a
`Prisma*` class.** The moment a route handler constructs its own repository,
the dependency inversion is gone and that handler can no longer be tested
without a real database.

Wiring here is deliberately boring and explicit — `buildContainer` calls
constructors directly and returns a plain object, rather than routing
resolution through a DI container. A container would hide these edges behind
runtime lookup, where a missing dependency becomes a runtime failure instead
of a compile error. At this codebase's size, explicit construction costs a
handful of lines per context and buys complete type safety in exchange.

## Shape of the container

`buildContainer(prismaClient?)` returns a `Container`: one field per bounded
context (`identity`, `credentials`, `audit`, `authorization`, …), each holding
the fully-wired use cases and services that context exposes, plus the raw
`prisma` client and a `dispose()` for shutdown. Tests inject a `PrismaClient`
pointed at a throwaway database; production passes nothing and gets one built
from `DATABASE_URL`.

Extending the container for a new context means adding a new field to
`Container` and constructing its use cases inside `buildContainer` — additive
by construction, since existing fields are untouched.

## Wiring a context with no adapters to assemble

Not every context needs infrastructure. `AuthorizationServices` (Phase 08 —
Issues 146, 148, 156) wires the deterministic ABAC core: the pure evaluation
engine, the combining algorithms, and the policy linter. None of these touch a
repository or any I/O, so "wiring" them is exposing the package's functions
under the container's configured default (`DEFAULT_COMBINING_ALGORITHM`)
rather than assembling any adapter — there is nothing to inject.

```ts
authorization: {
  combiningAlgorithm: DEFAULT_COMBINING_ALGORITHM,
  evaluateRequest: (rules, context) => combine(DEFAULT_COMBINING_ALGORITHM, rules, context),
  lintPolicySet,
},
```

This intentionally does **not** include `AuthorizeAction`, `SimulatePolicy`, a
policy repository, or attribute providers — Issue 157's other named
deliverables. Those depend on work that does not exist yet in this codebase
(a `PolicyRepository` and attribute providers — roadmap issues 150, 153, 154),
and Phase 07's RBAC has not landed either. Issue 157's own guidance for an
unmet dependency is to check with a maintainer or, failing that, "proceed
against the interface alone" — wiring the deterministic core that exists
today, ahead of the parts that don't, is that call. `PolicyRepository`,
`AuthorizeAction`, and `SimulatePolicy` belong in `AuthorizationServices` once
their own issues land; adding them then is a compatible, additive change, not
a rework of what's here.

## Proving the wiring, not just the types

A container that constructs the wrong thing still typechecks — the compiler
has no opinion on whether `RegisterUser` was handed a _working_ repository,
only that it was handed _something_ shaped like one. That's why the
composition root gets its own tests instead of relying on type-checking
alone:

- `apps/api/src/composition-root.spec.ts` is a unit-level boot smoke test for
  the parts of the container that need no database at all (today, the
  authorization services) — it runs even on a machine with no Postgres
  available.
- `tests/integration/composition-root.spec.ts` exercises the full container,
  including the Prisma-backed contexts, end to end against a real database.

Both assert the same thing at different depths: that the object graph
resolves, and that resolving it produces something that actually behaves
correctly, not merely something that compiles.
