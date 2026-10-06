# The Composition Root

`apps/api/src/composition-root.ts` is the one file in the system allowed to
know which concrete implementation backs each port. Everything else —
domain, application, and the ports they depend on — knows only interfaces.
`RegisterUser` takes a `UserRepository`; it has no idea a `PrismaUserRepository`
exists. `RefreshAccessToken` takes a `RevocationList`; it has no idea whether
that list is backed by Redis or an in-memory map in a test.

This document explains the shape that file has settled into, added to once
per bounded context as each one lands (identity and credentials in Phase 03,
sessions in Phase 05, and so on), so the same conventions get applied rather
than reinvented each time.

## The rule composition-root wiring exists to protect

**Nothing outside this file imports a `Prisma*` class**, and nothing outside
it constructs a Redis client, an HMAC signer, or any other concrete adapter.
The moment a route handler or a use case reaches for a concrete
implementation directly, dependency inversion is gone — that code can no
longer be tested without the real infrastructure behind it, which is exactly
the property the whole ports-and-adapters split exists to buy back.

Wiring here is deliberately boring and explicit: constructor calls in a
straight line, not a DI container resolving bindings at runtime. A missing
dependency is a compile error, not something that surfaces the first time a
request hits an unwired route. At the size this file is (one process, a
few dozen use cases), that costs a few extra lines per context and buys
complete type safety on every wire-up.

## `Container` is a plain object, grouped by context

`buildContainer()` returns a `Container`: one property per bounded context
(`identity`, `credentials`, `sessions`, `audit`), each a plain interface
listing every use case that context exposes, plus `prisma` and `dispose`.
There is no service locator, no `container.get(SomeUseCase)` — every use
case a caller might need is a named, statically-typed property, so accessing
one that doesn't exist is a compile error rather than a runtime `undefined`.

Adding a context means:

1. Import its use cases and adapters from the package (`@verixa/sessions`,
   here) exactly as any other consumer would — the composition root has no
   special access, just ordinary public exports.
2. Declare a `<Context>UseCases` interface listing what that context exposes.
3. Construct its adapters and use cases inside `buildContainer()`, in the
   same style as every context before it.
4. Add the new property to `Container` and to the object `buildContainer()`
   returns.

## One instance per process, not per request

Adapters that hold fixed configuration — `Argon2PasswordHasher`,
`SigningKeyProvider`/`JwtTokenSigner`, `SessionExpiryPolicy` — are
constructed once, inside `buildContainer()`, and shared by every use case
that needs one. They are not rebuilt per request. Cost parameters, signing
keys, and expiry windows do not change between requests; reconstructing the
object that holds them would just be an allocation for nothing.

This matters beyond performance in at least one case: `AuthenticateWithPassword`
and `RegisterUserWithPassword` deliberately **share** an `Argon2PasswordHasher`
instance rather than each getting their own, because the timing decoy that
hides whether an account exists (`docs/security/authentication-flows.md`) is
cached per hasher instance. A second instance would build its own decoy on
its first failed login, which is a subtle way to reintroduce the timing gap
the decoy exists to close.

## Lazy connections: a container that builds without live infrastructure

`new PrismaClient(...)` and `new Redis(url, { lazyConnect: true })` both
share a property worth calling out explicitly: constructing the client does
not open a socket. The connection opens on the first command that actually
needs one. That is what lets `buildContainer()` succeed as a pure
"assemble the object graph" step even when Postgres or Redis isn't reachable
yet — a fresh checkout with no `docker compose up` run, a CI job that only
wants to prove the wiring type-checks and resolves, or the boot smoke test
below.

Without `lazyConnect`, adding Redis to the container would mean
`buildContainer()` throws or hangs any time Redis is down, even for a caller
who never touches a session — turning an infrastructure dependency of one
context into a startup dependency of the whole process.

`dispose()` mirrors this: it calls `redis.disconnect()`, not `redis.quit()`.
`quit()` sends a command, which would force a connection that was never
opened just to close it again. A container that was built but never used to
touch a session — most unit tests, and this file's own boot smoke test —
should be able to shut down without ever having reached Redis at all.

## Fail fast on missing configuration, not on first use

`SigningKeyProvider`'s constructor throws if handed an empty secret, and that
throw happens inside `buildContainer()`, at boot, reading
`config.SESSION_ACCESS_TOKEN_SECRET` via `loadConfig()`. A deployment missing
that environment variable fails to start, with a message naming the missing
variable, rather than accepting traffic and failing the first time someone
tries to log in.

This is the same shape `packages/config`'s schema validation already
enforces for every required variable — reading configuration is `loadConfig()`'s
job, not something scattered across whichever adapter happens to need a
given value first. The composition root is where that config is decoded
into adapters; it isn't a second place validation rules live.

## Presence, not a silent no-op, when a feature is unconfigured

`AuditUseCases.anchor` is `AnchorAuditLog | undefined` — present only when
`STELLAR_ANCHOR_SECRET_KEY` is configured, absent otherwise. It is not a
`NullHashAnchor` that quietly accepts anchoring calls and does nothing. The
difference matters: a silent stub here is the one outcome that actively
misleads an operator, who would have every reason to believe their audit log
is externally verifiable when nothing has ever actually been committed
anywhere. Absence forces every caller to handle the "not configured" case
explicitly instead of getting a false sense of security from a well-typed but
inert object.

Contrast this with `NullCredentialNotifier`, which _is_ deliberately a silent
no-op: sending no email is genuinely correct behavior until Phase 14 adds a
real notifier, whereas silently pretending to anchor a hash is never correct
behavior at any phase. The rule isn't "no-ops are bad" — it's that the
no-op's behavior has to actually be indistinguishable from the feature being
absent, and "your audit log is verifiable" fails that test the moment it's
untrue.

## Replacing a placeholder as a real dependency lands: `SessionRevoker`

Phase 03 wired `ConfirmPasswordReset` against a `SessionRevoker` port with
`NoSessionsRevoker` behind it — correct at the time, since sessions didn't
exist yet, so revoking all of a user's sessions on password reset was
genuinely a no-op. Phase 05's composition-root change is the other half of
that plan playing out: `NoSessionsRevoker` is replaced with
`SessionsPackageRevoker`, adapting `LogoutEverywhere` to the same
`SessionRevoker` interface `ConfirmPasswordReset` already called.

Nothing in `packages/credentials` changed to make this work — the call site
existed from the start specifically so that "invalidate sessions on password
reset" was never a step a future contributor had to remember to add. Only
the composition root, which is the one place allowed to know a real adapter
now exists, changed.

## The boot smoke test

Each context that reaches the composition root gets a test proving the
container actually resolves that context's use cases against real (not fake)
adapters — see `apps/api/src/composition-root.spec.ts` for the sessions
wiring added here. Thanks to lazy connections, this runs without Postgres or
Redis: it builds the container, asserts each use case is an instance of the
real class (`container.sessions.issueSession instanceof IssueSession`, not a
fake), and disposes it. It also asserts the fail-fast behavior above: with
`SESSION_ACCESS_TOKEN_SECRET` unset, `buildContainer()` throws.

This is deliberately not the same thing as an integration test exercising a
use case end-to-end against a live database — that already exists elsewhere
(`tests/integration/composition-root.spec.ts`) for identity/credentials. The
boot smoke test answers a narrower, cheaper question: "does the object graph
wire up correctly," which is exactly what the acceptance criteria for wiring
a context into the composition root ask for, and exactly the class of bug
(a missing constructor argument, a port satisfied by the wrong adapter) that
a database-backed integration test would otherwise be the only thing to
catch.

## Related

- `planning/ARCHITECTURE.md` — where the composition root sits in the overall
  layering, and why `apps/api` owns no business logic of its own.
- `docs/guides/domain-modeling.md` — the port/adapter boundary this file sits
  on top of.
- `docs/guides/configuration.md` — how `packages/config` validates the
  environment variables read here.

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

# Composition Root & Dependency Inversion Guide

This guide explains Verixa's composition root architecture, wiring conventions, package boundary enforcement, and coverage gating.

---

> This guide was assembled from two separately-written descriptions that a
> merge left concatenated, each with its own top-level heading. They covered
> the same subject from different angles rather than contradicting each other,
> so both are kept: sections 1-4 state the rules, section 5 walks the actual
> file. Nothing was dropped.

## 1. The Role of the Composition Root

The composition root (`apps/api/src/composition-root.ts`) is the **single place** in the application where the object graph is constructed and concrete implementations are bound to interface ports.

### Invariant: Zero Infrastructure in Domain or Application Layers

Domain entities and application use cases depend exclusively on abstract ports:

- A use case like `RegisterWebAuthnCredential` requires an `AttestationVerifier` and repository interfaces (`MfaMethodRepository`, `WebAuthnChallengeRepository`, `WebAuthnCredentialRepository`).
- It has no knowledge of how those interfaces are fulfilled—whether in-memory fakes, Prisma database adapters, or hardware security modules.
- **The rule:** No file outside `composition-root.ts` may import concrete persistence adapters or construct repository instances.

### Why Explicit Construction Over Magic Dependency Injection (DI) Containers

We deliberately rejected runtime reflection/DI containers (e.g. Inversify, NestJS decorators, Awilix):

- **Compile-Time Type Safety:** When a use case gains a dependency or change in configuration, TypeScript immediately flags missing arguments in `composition-root.ts` at build time.
- **No Hidden Lifecycle Regressions:** In DI containers, missing or circular dependencies fail at runtime during production boot rather than at compile time.
- **Readability:** Anyone reading `composition-root.ts` can trace the exact instantiation and lifecycle of every component without memorizing container DSLs or token registries.

---

## 2. Multi-Factor Authentication (MFA) Wiring (`packages/mfa`)

Phase 06 introduces `@verixa/mfa` into the application container:

```ts
export interface MfaUseCases {
  readonly registerWebAuthnCredential: RegisterWebAuthnCredential;
  readonly verifyWebAuthnAssertion: VerifyWebAuthnAssertion;
}

export interface Container {
  readonly prisma: PrismaClient;
  readonly identity: IdentityUseCases;
  readonly credentials: CredentialUseCases;
  readonly audit: AuditUseCases;
  readonly mfa: MfaUseCases;
  readonly dispose: () => Promise<void>;
}
```

### WebAuthn Configuration & Verifiers

The composition root reads environment configuration for WebAuthn ceremony verification:

- `WEBAUTHN_RP_ID`: The Relying Party identifier (default: `localhost`).
- `WEBAUTHN_ORIGIN`: The expected caller origin (default: `http://localhost:3000`).

Both `RegisterWebAuthnCredential` and `VerifyWebAuthnAssertion` are instantiated with concrete verifiers:

- `WebAuthnAttestationVerifier`: Validates registration ceremonies and extracts attested public keys.
- `WebAuthnAssertionVerifier`: Validates authentication ceremonies, cryptographic signatures, and monotonic signature counter clone detection.

---

## 3. Package Encapsulation & Boundary Enforcement

Every context package (`@verixa/identity`, `@verixa/credentials`, `@verixa/mfa`) exposes a curated public surface via its root `index.ts`:

- Wildcard re-exports (`export *`) are forbidden. Each entity, port, and use case is explicitly re-exported.
- External packages cannot deep-import from internal paths (e.g. `@verixa/mfa/application/use-cases/...` or `@verixa/mfa/domain/...`).
- **ESLint Enforcement:** `eslint.config.mjs` enforces this with `no-restricted-imports`:
  ```js
  {
    files: ["**/*.ts"],
    ignores: ["packages/identity/**", "packages/credentials/**", "packages/mfa/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@verixa/identity/*", "@verixa/credentials/*", "@verixa/mfa/*"],
              message: "Import from the package root (`@verixa/mfa`), not a deep path.",
            },
          ],
        },
      ],
    },
  }
  ```

---

## 4. Coverage Gate Standard

Each domain context must pass automated test coverage thresholds in CI:

- **Statements:** ≥ 90%
- **Lines:** ≥ 90%
- **Functions:** ≥ 85%
- **Branches:** ≥ 85%

Interface-only ports, testing fakes, and generated database harnesses are excluded from coverage calculations so that the gate accurately measures application and domain logic without skewing from erased TypeScript interfaces.

## 5. Wiring in Practice

`apps/api/src/composition-root.ts` is the only place in the system allowed to
know which concrete implementations exist. Everything else depends on
interfaces: `RegisterUser` knows it needs _a_ `UserRepository` and has no idea
one is backed by Prisma. That inversion is what keeps the application layer
testable without a database, and it only holds while the knowledge of "which
implementation" stays concentrated in one file instead of leaking into the
modules that use it.

The rule to preserve: **nothing outside this file imports a `Prisma*` class.**
The moment a route handler constructs its own repository, the inversion is gone
and that handler can no longer be tested without a database.

Wiring is explicit construction rather than a DI container for the same reason:
a container hides these edges behind runtime resolution, so a missing
dependency becomes a runtime failure instead of a compile error. At this size,
a few lines of boring code buys complete type safety.

```ts
const container = buildContainer(); // production: reads DATABASE_URL
const app = buildApp({ container }); // Fastify routes over that graph
```

`buildContainer` takes an optional `PrismaClient` so tests can inject one
pointed at a throwaway database. A test that writes rows should never be one
environment variable away from a developer's own data.

### Audit

Audit wiring is the part of the composition root with an **ordering**
requirement, which is why it gets its own file and its own section.

#### Registering subscribers

```ts
// apps/api/src/composition/register-audit-subscribers.ts
export function registerAuditSubscribers(
  publisher: DomainEventPublisher,
  recordEvent: RecordAuditEvent,
): void {
  publisher.subscribe<SessionCreatedEvent>("sessions.session.created", ...);
  // ...one registration per subscriber, and no other work
}
```

It is called from inside `buildContainer`, immediately after the publisher is
constructed:

```ts
const eventPublisher = new InMemoryEventPublisher();
registerAuditSubscribers(eventPublisher, recordAuditEvent);
```

#### Why it happens here, and not later

An event published while nobody is subscribed to it is not queued, delayed or
replayed. It is **dropped, silently and permanently** —
`InMemoryEventPublisher.publish` looks up a handler list and iterates whatever
it finds.

So the ordering rule for auditing is: subscribers must exist before the first
event can be published. There is no way to enforce that at a call site; the
only mechanism is eager registration in the function that builds the object
graph. Three alternatives were considered and rejected:

- **Lazy registration on first publish.** Reads as efficient and is a data-loss
  bug: whatever the very first event of a process is, that event is never
  audited. Worse than not audited, because the log looks complete — a gap at
  the head of a chain is indistinguishable from nothing having happened yet.
- **Registering in `buildApp` instead.** Then a process that publishes before
  the HTTP layer is built loses those events: a scheduled job, a queue
  consumer, or a test that drives use cases directly. Any of them would have to
  remember to call the registration step, which is the same "something to
  remember" this design exists to remove.
- **Registering per request.** Two registrations for one event name means the
  handler runs twice, which means two audit entries for one login. A log that
  duplicates events is not a ledger, and a `sequence` that no longer matches
  the count of real events makes every later report wrong.

`InMemoryEventPublisher` is synchronous by design: handlers run in
subscription order inside the request that published the event, so an audit
record exists before the caller sees a response. The trade is that a slow
handler blocks the request. If that ever becomes a real problem the answer is
an out-of-process event bus, not making this one async.

#### The two ways an entry gets written

Both paths exist, and which one is live changes as contexts are built:

- **Directly**, by a route calling `container.audit.recordEvent.execute(...)`.
  This is how registration and login are audited today
  (`apps/api/src/routes/auth.ts`), because those operations are request-driven
  and the route knows exactly what happened.
- **By subscription**, when a context publishes a domain event and an audit
  subscriber maps it to an entry. No context publishes on a code path yet —
  sessions (Phase 05) and RBAC (Phase 07) are still being built — so this wiring
  is deliberately ahead of its publishers. A subscriber registered late loses
  every event before it, silently; a subscriber registered early does nothing
  until the first event arrives. Only one of those is recoverable.

Both write into one hash-chained log through `RecordAuditEvent`, so verification
does not have to know which path produced a row. See
`docs/guides/domain-events.md` for the publisher side of that.

#### Adding a subscriber

A subscriber that exists, is fully tested inside `@verixa/audit`, and is never
wired up records nothing — and fails as a missing row six months later rather
than as a red test. That is the failure mode this section is about, so the
whole procedure is four steps with a check at the end:

1. Implement it in `packages/audit/application/subscribers/`, extending
   `AuditEventSubscriber<E>`, and export the class **and its event interface**
   from `packages/audit/index.ts`. The event type is part of the public
   surface: `subscribe` is generic over it, and a publisher in another context
   has to be able to build one.
2. Add one `publisher.subscribe<...>("<event.name>", ...)` line to
   `registerAuditSubscribers`.
3. Add a row to the table in
   `tests/integration/audit-subscriber-registration.spec.ts` asserting that a
   composed container, given that event name, gains an audit entry.
4. Add the event name to `docs/guides/domain-events.md` if it is emitted by an
   aggregate.

Step 3 is what makes an omission visible. The integration spec publishes on a
container that has never had `buildApp` called on it, which is also what makes
_late_ registration visible: registering anywhere other than composition means
the first event of a process is dropped, and publishing against a bare
container is exactly the test that catches it.

#### What the container exposes

```ts
export interface Container {
  readonly prisma: PrismaClient;
  readonly eventPublisher: DomainEventPublisher; // subscribers already attached
  readonly audit: {
    readonly recordEvent: RecordAuditEvent;
    readonly queryEvents: QueryAuditEvents;
    readonly verifyChain: VerifyAuditChain;
    readonly anchor: AnchorAuditLog | undefined;
  };
  // ...identity, credentials, dispose
}
```

Two details that are deliberate, both about _absence_:

- **`eventPublisher` is on the container** so anything with the graph can
  publish through the wired publisher rather than constructing its own. A
  second `InMemoryEventPublisher` is a second set of subscribers, which is to
  say no subscribers.
- **`anchor` is `undefined` when no signing key is configured**, rather than a
  no-op stub. A deployment that has not set up anchoring must not be able to
  believe it has: a silent stub would leave an operator thinking their audit
  log is externally verifiable when nothing has ever been committed anywhere.

Recording itself never fails the operation it records. `RecordAuditEvent`
catches, reports to stderr, and returns `undefined` — a login that succeeded
should not be reported as failed because the audit write broke. The residual
risk (an attacker who can reliably break audit writes can act unrecorded) is
mitigated by visibility, not by failing requests: a gap in the sequence is
detectable, and `pnpm audit:verify-chain` is how someone looks. See
`docs/security/audit-log-integrity.md`.
