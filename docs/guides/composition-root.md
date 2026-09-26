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
