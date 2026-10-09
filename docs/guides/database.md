# Database

Verixa uses PostgreSQL. This guide covers the database architecture, Prisma
schema, the ordered migration history under `packages/database/prisma/migrations/`,
and repository implementations.

## Local Postgres

`docker compose up postgres` starts a single Postgres 16 container that
provisions **two** databases on first start:

- `verixa` — the development database, `DATABASE_URL` in `.env.example`
  points here.
- `verixa_test` — a separate database for tests, `TEST_DATABASE_URL` points
  here. Created by `infra/postgres/01-init-test-db.sh`, which the official
  Postgres image runs automatically on first container start (anything
  under `/docker-entrypoint-initdb.d/` executes once, in filename order, the
  first time the data volume is empty).

It also provisions **two roles**, in `infra/postgres/02-init-app-role.sh`.

### Why the application does not connect as the superuser

| Role         | Used by          | Privileges                         |
| ------------ | ---------------- | ---------------------------------- |
| `verixa`     | Migrations, psql | Superuser, owns every table        |
| `verixa_app` | The running API  | `SELECT/INSERT/UPDATE/DELETE` only |

**PostgreSQL superusers bypass row level security entirely** — the policies
are not consulted at all. Every tenant-isolation policy in the RLS migration
is, for a superuser connection, decoration.

`FORCE ROW LEVEL SECURITY` on those tables closes the _owner_ half of this
(an owner is otherwise exempt from policies on their own tables). It does
nothing about superusers, so the second half is closed by simply not
connecting as one.

The failure this prevents is quiet, which is what makes it worth two roles.
With the API connected as a superuser, a bug that forgot to set
`app.current_organization_id` would read across every tenant, and no test
would fail — the policy that should have stopped it was never evaluated.
Multi-tenancy would look like it worked right up until it mattered.

Migrations still run as `verixa`, because DDL needs the owner. That split is
visible in the connection string rather than inferred from code paths:
`docker-compose.yml` gives the `api` service the `verixa_app` URL, while
`.env` keeps the owner URL for the Prisma CLI.

> **Existing checkouts:** init scripts run only when the data directory is
> empty. If your volume predates this, `docker compose down -v` and start
> again, or the `verixa_app` role will not exist and the API will fail to
> connect.

### Why tests need their own database, not the dev one

A test suite that creates, mutates, and deletes rows is fundamentally
incompatible with a database a developer is also interactively poking at —
a test truncating a table mid-manual-debugging session, or a developer's
half-finished manual data change silently breaking a test's assumptions
about starting state, are both real, recurring sources of "why did this
just fail, it worked five minutes ago" confusion. Two logically separate
databases on the same Postgres server is enough isolation for local
development. It stops there deliberately, though: `verixa` and
`verixa_test` still share one Postgres _process_, so a truly broken test
(exhausting connections, for example) can still affect the other database's
availability. Issue 047 replaces this with fully ephemeral, per-test-run
containers (Testcontainers) for automated/CI test runs, which is a
stronger isolation guarantee than two databases sharing a server —
tracked here as future work, not implemented yet.

## Connection configuration

`DATABASE_URL` flows through `@verixa/config` (`packages/config/index.ts`)
like every other environment variable — validated as a URL at startup,
defaulted to the local dev value if unset, fails fast with a readable error
if malformed. No repository reads it yet (that starts with Issue 046,
alongside Prisma), but the config plumbing is in place now rather than
being bolted on later.

`TEST_DATABASE_URL` is deliberately **not** part of `@verixa/config` — the
running application server never needs to know about the test database, so
adding it to the app's config schema would be scope creep onto a
test-infrastructure concern. Test code reads it through
`tests/integration/helpers/database.ts`, which also builds the Prisma
client for tests with that URL passed **explicitly** rather than relying on
the ambient `DATABASE_URL` the schema reads. That matters: a suite that
deletes rows should never be one environment variable away from doing it to
a developer's own development database.

## Waiting for Postgres to be ready

`pnpm db:wait` (`scripts/db-wait.mjs`) polls a plain TCP connection to
`DATABASE_URL`'s host:port until it succeeds or times out (30 attempts,
1s apart). It's a standalone Node script, not a workspace package — no
`pg` driver dependency, just `node:net` — because "is anything listening on
this port yet" doesn't require speaking the Postgres wire protocol. That's
weaker than "Postgres has finished initializing and is ready for queries"
(a container can accept a TCP connection slightly before the database
behind it is fully up), which is why `docker-compose.yml`'s own
`healthcheck` (`pg_isready`, the real Postgres readiness check) is still
the authoritative signal for `depends_on: condition: service_healthy` in
that file. `db:wait` exists for contexts without compose's health-check
orchestration to lean on — a plain shell script, a CI step before compose
is involved, or a developer who wants to know from the command line.

## Verifying connectivity

`tests/integration/database.spec.ts` asserts a real TCP connection to
`TEST_DATABASE_URL` succeeds — no application code, no ORM, just proof that
whatever's running there is reachable from wherever the test is. It shares
its connection-check helper (`tests/integration/helpers/tcp-connect.ts`)
with nothing else in the codebase on purpose: `scripts/db-wait.mjs` needs
the identical logic but is a dependency-free root-level script outside any
workspace package's TypeScript project, so importing between the two would
mean crossing a boundary that doesn't otherwise exist. Duplicating ~15
lines was the simpler, more honest choice than inventing a shared module
for it.

### Running it

- **Locally**, this test **skips** when nothing is listening on
  `TEST_DATABASE_URL`'s port, so `pnpm test` passes on a fresh clone with
  no Docker running. Start `docker compose up postgres` to actually run it.
  See "Database-backed tests" below for why skipping is the local default
  and how CI prevents that from hiding missing coverage.
- **In CI**, `.github/workflows/ci.yml`'s `ci` job runs a `postgres:16-alpine`
  GitHub Actions **service container** (`services: postgres:`) — a
  lighter-weight mechanism than `docker compose` for CI specifically:
  GitHub starts and health-checks it automatically, alongside the job (not
  inside a separate container the job has to reach across a network), so it's
  reachable at plain `localhost:5432` from every step with no extra
  networking setup. `TEST_DATABASE_URL` is set as a job-level `env` var
  pointing at it.

## Prisma and the migration workflow

`packages/database` (`@verixa/database`) owns the schema, the migration
history, and the generated Prisma client. Everything database-related lives
in that one package rather than at the repo root, for the same reason every
other capability is a package: `apps/api` and the repository adapters
declare an explicit dependency on it, and pnpm's strict `node_modules`
resolution then guarantees the generated client is actually reachable from
the packages that import it — which a root-level `prisma/` directory does
not.

There is **one** schema and **one** migration history for the whole system,
not one per bounded context. That follows directly from
`docs/adr/0002-multi-tenancy-model.md`: all tenants share the same tables,
isolated by a row-level `organization_id` and Postgres RLS. Separate
contexts own separate _tables_, but they live in the same database, so they
migrate together.

### Commands

```bash
pnpm db:generate         # regenerate the Prisma client from schema.prisma
pnpm db:migrate          # create + apply a migration (development)
pnpm db:migrate:deploy   # apply existing migrations (CI/production)
pnpm db:migrate:status   # show which migrations have/haven't been applied
```

### The generated client is not committed

`pnpm db:generate` writes the client into `node_modules`, and it ships a
compiled query-engine binary specific to the platform that generated it — a
client generated on Windows will not run on the Linux container in CI. It's
git-ignored for that reason, which means **a fresh clone must run
`pnpm db:generate` before anything that imports `@verixa/database` will
build, typecheck, or run.** CI does this explicitly as its own step, before
`pnpm build`, for exactly the same reason the build step runs before lint
(see `docs/guides/ci-cd.md`).

`packages/database/index.spec.ts` exists mostly to make that failure mode
obvious: if generation was skipped, it fails on a plain assertion about the
exported client rather than surfacing as a confusing type error somewhere
several layers away.

### `migrate dev` vs. `migrate deploy`

- **`pnpm db:migrate` (`prisma migrate dev`)** is for development. It
  diffs `schema.prisma` against the database, generates a new SQL migration
  file, applies it, and regenerates the client. It can also **reset the
  database** when it detects drift — which is fine locally and catastrophic
  in production.
- **`pnpm db:migrate:deploy` (`prisma migrate deploy`)** is for CI and
  production. It only applies migration files that already exist, in order,
  and never generates, edits, or resets anything. This is the one that runs
  in the deploy pipeline.

Using the wrong one in production is a genuinely destructive mistake, which
is why they're separate named scripts here rather than one script with a
flag.

### Why migrations, not schema sync

Prisma also offers `db push`, which shoves the current schema straight into
the database with no migration file. It's faster while prototyping, and the
wrong tool the moment anything real depends on the database.

A migration file is a **record of a specific change, in order, that can be
replayed**. That matters for three things `db push` can't do:

1. **Reproducibility.** Every environment — a teammate's laptop, CI, staging,
   production — arrives at the same schema by applying the same ordered list
   of changes, rather than each independently syncing to whatever the schema
   file happens to say today.
2. **Review.** A migration is a diff a human can read in a pull request:
   "this drops a column" is visible before it runs. Schema sync hides the
   destructive step inside a tool's diffing logic, where nobody reviews it.
3. **Data changes, not just structure.** Real schema changes often need
   accompanying data changes — backfill a new non-null column before adding
   the constraint, split one column into two. That's SQL that has to run
   _between_ two structural states, which only exists in a migration-based
   workflow.

Verixa set this workflow up in Issue 042, **before any table existed**,
deliberately. Retrofitting migration history onto a database that was built
by schema sync means reconstructing a history nobody recorded — so the
cheapest possible moment to establish it was when there was nothing to
reconstruct. Since Issue 043, every structural change has been tracked as
an ordered migration under `packages/database/prisma/migrations/`.

CI runs `db:migrate:deploy` on every push, applying every migration in
order against a fresh Postgres service container — so a migration that
doesn't apply cleanly fails the build rather than surfacing on someone's
machine later.

## Schema

### `users` (Issue 043)

The persisted form of the `User` aggregate
(`packages/identity/domain/entities/user.ts`).

| Column         | Type             | Notes                                          |
| -------------- | ---------------- | ---------------------------------------------- |
| `id`           | `uuid` PK        | Assigned by the domain, never by the database  |
| `email`        | `citext` UNIQUE  | Case-insensitive; see below                    |
| `display_name` | `text`           | Always present                                 |
| `given_name`   | `text` NULL      | Optional structured name                       |
| `family_name`  | `text` NULL      | Optional even when a given name exists         |
| `status`       | `user_status`    | Enum: `pending`/`active`/`suspended`/`deleted` |
| `created_at`   | `timestamptz(3)` |                                                |
| `updated_at`   | `timestamptz(3)` |                                                |

Three decisions in that table are worth explaining, because each one has a
common alternative that's subtly worse.

**The id is not database-generated.** There's deliberately no
`@default(uuid())`. `User.register()` produces a complete, valid `User` —
identity included — before anything touches persistence, which is what
makes the domain layer testable without a database at all. Letting the
database mint the id would invert that: an entity would only become fully
real once saved, and every test would need a database to produce one.

**`email` is `citext`, not `text`.** The domain already lowercases in
`Email.create()`, so in normal operation every stored value is already
lowercase and `citext` changes nothing. It earns its place as the second
line of defense — a raw SQL insert, a data migration, a bulk import, or a
future code path that skips `Email.create()` could otherwise create two
accounts differing only in case, which is an account-takeover-adjacent bug
rather than a cosmetic one. This is the same defense-in-depth principle
applied throughout: enforce an invariant in the domain _and_ in the
database, because the two protect against different failure modes.

The usual alternative is `text` plus a functional unique index on
`LOWER(email)`. That achieves uniqueness and is a well-known footgun:
Postgres only uses a functional index when a query's `WHERE` clause matches
its expression exactly. So `WHERE email = $1` silently falls back to a
sequential scan while `WHERE LOWER(email) = LOWER($1)` uses the index —
meaning every query site has to remember the wrapper, and the one that
forgets is both slow _and_ case-sensitive. `citext` moves that correctness
into the column type, where it can't be forgotten. `users-table.spec.ts`
tests both halves: that a case-differing duplicate is rejected, and that a
plain equality lookup matches case-insensitively.

**Timestamps are `timestamptz`, not `timestamp`.** Prisma's default for
`DateTime` on Postgres is `timestamp` — no timezone — which silently
reinterprets values against whatever the session timezone happens to be.
That produces hour-shifted timestamps that only appear once a server, a
developer laptop, and a CI runner disagree about local time. Identity and
audit records need an unambiguous instant.

**One known gap.** `given_name` and `family_name` are independently
nullable, so the database permits a family name with no given name — a
state the domain's `PersonName` cannot represent. Closing it needs a
`CHECK` constraint, which Prisma's schema language can't express and which
would have to be hand-written into a migration. That's deferred rather than
guessed at: this environment has no local Postgres to verify how Prisma's
drift detection treats a constraint it can't model, and adding an
unverifiable hand-edit to the migration history could break `migrate dev`
for every contributor. It's a real gap, worth closing once it can be
tested against a live database.

### Objects Prisma does not manage

Two kinds of database object in this schema exist only in migration SQL,
because Prisma's schema language cannot express them:

- The **partial unique index** on `organization_memberships` (Issue 044),
  which constrains only rows where `status = 'active'`. Prisma's `@@unique`
  has no `WHERE` clause. A plain composite unique would be wrong — it would
  forbid rejoining an organization after leaving it.
- Any **`CHECK` constraint**, including the one `users.given_name` /
  `family_name` still wants (Issue 043).

The consequence to be aware of: `prisma migrate dev` derives new migrations
by diffing `schema.prisma` against migration history, and it cannot see
these objects. They are applied by their migration and stay in the database,
but Prisma will not recreate them if it ever regenerates the schema, and it
will not warn you they exist. Treat them as append-only: add via raw SQL in
a migration, never expect Prisma to manage them afterwards.

## Seeding

`pnpm db:seed` (from `packages/database`) loads deterministic development
fixtures: three users, two organizations, four memberships.

```bash
pnpm --filter @verixa/database run db:seed
```

**It is idempotent.** Every record upserts against a fixed id, so re-running
updates rather than duplicating. That is not a convenience — a seed you are
afraid to re-run becomes a seed nobody runs, and the fixtures drift out of
sync with the schema until they no longer work at all.

Fixed ids also make fixtures _referenceable_: user
`00000000-0000-4000-8000-000000000001` is Alice on every machine and after
every reset, which is what makes a local bug report reproducible.

Two deliberate choices in the data:

- **Bob belongs to two organizations.** A user spanning tenants is the case
  naive multi-tenancy designs get wrong, and it should be what a contributor
  sees by default rather than something they construct by hand.
- **No invitations are seeded.** An invitation is only usable alongside the
  raw token mailed to its recipient, and that token is unrecoverable by
  design — a seeded invitation would be a row nobody could ever accept.
  Seeding a _known_ token would be worse: a working bearer credential
  committed to version control. See
  [token storage](../security/token-storage.md).

### Seed data must never resemble a real secret

Everything here uses `@example.com` (IANA-reserved, can never receive mail),
obvious placeholder names, and no credentials of any kind.

Seed files get copied, pasted into issues, and screenshotted in tutorials, so
anything in one should be worthless if disclosed. The risk isn't a leaked
seed password — it's that a realistic-looking one teaches the habit, and
eventually gets pasted somewhere real. When passwords arrive in Phase 04,
seeded accounts must use values that are visibly unusable outside local
development.

## Connection pooling

Two settings, both validated through `@verixa/config`:

| Variable                        | Default | Meaning                                 |
| ------------------------------- | ------- | --------------------------------------- |
| `DATABASE_POOL_SIZE`            | 10      | Max connections this process holds open |
| `DATABASE_POOL_TIMEOUT_SECONDS` | 10      | How long to wait for a free connection  |

The composition root appends these to the connection URL as Prisma's
`connection_limit` and `pool_timeout` parameters, so operators tune ordinary
validated config instead of hand-editing query strings.

**Sizing:** `pool size ≈ (peak concurrent requests touching the database) /
(number of app instances)`, rounded up modestly.

### Why "just increase the pool size" usually makes things worse

It is the reflexive fix for pool timeouts and it is usually wrong.

Every Postgres connection is a **separate OS process** with its own memory
(`work_mem` is per-operation, per-connection). Once active connections exceed
available cores they stop doing more work and start competing — context
switching, lock contention, buffer pressure. Total throughput _falls_ while
every individual query gets slower. A pool that is "too small" and briefly
queues requests generally beats one that lets a hundred connections thrash.

A pool timeout almost always means queries are too slow or held too long — a
missing index, or a transaction awaiting a network call. The pool is where
the symptom appears, not where the problem is. Fix the query first.

The cap of 100 exists because a stock Postgres `max_connections` is also 100,
and crossing it changes the failure from "requests queue" to "connections
refused" — much harder to diagnose. Remember instances share that budget: ten
app instances at 20 each is 200, and everything past 100 fails outright.

Load testing that would validate these defaults empirically is Phase 23; the
numbers here are conservative starting points, not measured optima.

## Soft delete

Users are never removed. `User.delete()` transitions status to `deleted` and
stamps `deleted_at`; the row stays (Issue 054).

**Why keep the row.** Everything that references a user by id has to stay
resolvable. An audit entry reading "user X suspended user Y" is unreadable if
Y's row is gone, and every foreign key pointing at a deleted user would have
to be nulled or cascaded — losing exactly the history an audit trail exists to
preserve. This is also why `organizations.owner_id` is `ON DELETE RESTRICT`:
the schema is built on the assumption that accounts don't disappear.

### Reading

| Method                     | Deleted users |
| -------------------------- | ------------- |
| `findById`, `findByEmail`  | excluded      |
| `findByIdIncludingDeleted` | included      |
| `existsByEmail`            | **included**  |

Exclusion is the default because it is what nearly every caller means, and
because the safe failure is to not find someone rather than to resurrect them.

The admin path is a **separate method**, not `findById(id, { includeDeleted:
true })`. A boolean parameter can be handed a variable that happens to be
`true`; a method name cannot. It also makes every privileged read greppable
in review.

`existsByEmail` including deleted users looks inconsistent and isn't. It
answers "can this email be registered", and the unique index covers deleted
rows too. If it ignored them, registration would pass its own check and then
fail on a constraint violation at insert — a confusing 500 instead of a clean 409.

### The consequence: a deleted user's email stays taken

Because the unique index still covers the row, someone who deletes their
account cannot re-register with the same address. That is a real limitation,
stated here rather than discovered later.

It is not fixed with a partial unique index. The proper fix is **anonymization
at erasure time** (Phase 24): the retention job rewrites the address to
something like `deleted-<uuid>@deleted.invalid`, which frees the original and
removes the personal data at the same time. Soft delete handles "this account
is gone"; erasure handles "this person's data is gone". They are different
operations and both are needed.

### Soft delete is not erasure

Soft delete deliberately **retains personal data**. Under GDPR-style
right-to-erasure, "we set a flag" is not deletion — the email, name, and every
audit record still exist and are still readable.

So Phase 24 must still implement genuine erasure, and the tension is real:
erasure removes data that audit integrity wants kept. The usual resolution is
to anonymize the personal fields while preserving the row and its id, so
referential integrity and the shape of the audit trail survive while the
identifying data does not. `deleted_at` is indexed specifically so that job
can find candidates efficiently — "every user deleted more than N days ago" is
a range scan over that column.

## Indexing

Every query the repositories actually run is index-backed. The indexes:

| Table                      | Index                                   | Serves                         |
| -------------------------- | --------------------------------------- | ------------------------------ |
| `users`                    | PK `id`                                 | `findById`                     |
| `users`                    | unique `email` (citext)                 | `findByEmail`, `existsByEmail` |
| `users`                    | `deleted_at`                            | Phase 24 retention scan        |
| `organizations`            | unique `slug` (citext)                  | `findBySlug`, `existsBySlug`   |
| `organization_memberships` | `(user_id, organization_id)`            | membership lookup              |
| `organization_memberships` | `organization_id`                       | list by organization           |
| `organization_memberships` | partial unique, `WHERE status='active'` | one active membership per pair |
| `invitations`              | unique `token_hash`                     | `findByToken`                  |
| `invitations`              | `(organization_id, status)`             | pending invitations            |
| `invitations`              | `expires_at`                            | expiry sweep                   |

### Why `organization_id` is indexed separately

It looks redundant next to `(user_id, organization_id)` and isn't. A B-tree
is only usable **from its leading column**, so a composite index on
`(user_id, organization_id)` cannot serve a query filtering on
`organization_id` alone. Dropping the standalone index would silently turn
`findAllByOrganization` into a sequential scan.

This is the least obvious call in the schema, which is why
`tests/integration/index-usage.spec.ts` asserts it explicitly.

### A sequential scan is not a bug

On a small table a seq scan is genuinely _faster_ — reading three rows from
one heap page beats descending a B-tree and then visiting the heap anyway.
Postgres knows this and chooses correctly. It also correctly scans when a
query touches most of the table, regardless of size.

So the index test seeds thousands of rows before asserting anything, and runs
`ANALYZE` first. Without volume the planner would rightly pick a scan and the
assertion would fail; without fresh statistics it would be planning from
defaults. Forcing the issue with `enable_seqscan = off` would prove only that
Postgres obeys orders.

The suite also asserts that an _unselective_ query still scans — a test suite
treating every seq scan as failure would push toward indexes that make things
worse.

### Reading `EXPLAIN`

```sql
EXPLAIN SELECT * FROM users WHERE email = 'alice@example.com';
```

- **Index Scan** — walks the index, fetches matching heap rows.
- **Index Only Scan** — answered entirely from the index; the heap is never
  touched. Fastest.
- **Bitmap Index Scan** — collects matches, then reads the heap in physical
  order. Chosen when many rows match.
- **Seq Scan** — reads every row. Correct for small tables and unselective
  queries; a problem when a selective lookup falls back to it.

`EXPLAIN ANALYZE` also _executes_ the query and reports real timings — use it
to compare estimated against actual row counts. A large gap usually means
stale statistics, and `ANALYZE` is the fix.

## Backup and restore

```bash
pnpm db:backup            # -> backups/verixa-<timestamp>.dump
pnpm db:backup my-label   # -> backups/my-label.dump
pnpm db:restore           # restores the most recent dump
pnpm db:restore my-label  # restores a specific one
```

Local and development only. Production backups — scheduling, offsite
retention, encryption, point-in-time recovery — are Phase 20.

`backups/` is git-ignored: dumps contain real local data and are large.

### A backup you have never restored is not a backup

The single most common backup failure is discovering, during an incident,
that the dumps were empty, truncated, or unreadable all along. Nothing about
taking a backup verifies you can get data back out of it.

So run the drill. Take a backup, restore it into a scratch database, confirm
the data is there. `db:backup` prints the restore command for exactly this
reason.

### Choices in the scripts

- **`--format=custom`, not plain SQL.** The custom format is compressed and
  is the only one `pg_restore` can restore _selectively_ (single table,
  schema-only, data-only) or in parallel. A `.sql` dump can only be replayed
  start to finish — the wrong property at the moment you need it most.
- **`--single-transaction` on restore.** A failure halfway leaves the
  database as it was, rather than half-restored. That intermediate state is
  what turns a bad afternoon into a bad week.
- **The restore script refuses non-local hosts.** It drops every object in
  the target, so a stale `DATABASE_URL` pointing at something shared would be
  unrecoverable. The guard is deliberately blunt: it protects against a tired
  mistake, not an adversary.

## Schema checks in CI

Three checks run on every push (Issue 058):

| Check                             | Catches                               |
| --------------------------------- | ------------------------------------- |
| `prisma validate`                 | A schema that isn't legal Prisma      |
| `prisma format --check`           | Formatting drift between contributors |
| `prisma migrate diff --exit-code` | **Schema/migration drift**            |

The third is the one that matters. It replays every migration into a throwaway
shadow database and asks whether the result matches `schema.prisma`.

They diverge when someone edits the schema and forgets to generate a
migration. Locally everything works — the Prisma client is generated _from
`schema.prisma`_, so the new field exists and typechecks. In production only
migrations run, so the column was never created and the first query against
it fails. Catching that at merge instead of at deploy is the entire point.

### Objects Prisma does not manage

Two kinds of object in this schema exist only in migration SQL, because
Prisma's schema language cannot express them:

- The **partial unique index** on `organization_memberships` — `@@unique` has
  no `WHERE` clause.
- The **RLS policies** (Issue 052).

They are applied by their migration and stay in the database, but Prisma will
not recreate them if it regenerates the schema and will not warn you they
exist. Treat them as append-only: add via raw SQL in a migration, never
expect Prisma to manage them afterwards.

## Database-backed tests

Tests needing a real Postgres live in `tests/integration/` and follow one
pattern:

```ts
const available = await databaseAvailability();

describe.skipIf(!available)("users table", () => { ... });
```

They **skip** when no database is reachable, so `pnpm test` passes on a
fresh clone with nothing running — a contributor's first command shouldn't
fail for reasons unrelated to their change.

The obvious hazard is that skipping hides missing coverage: a misconfigured
CI service container would make every database test skip and still report
green. CI therefore sets `REQUIRE_DATABASE_TESTS=1`, which turns an
unreachable database into a hard failure.

That check runs at module top level rather than in `beforeAll`, and the
reason is worth recording. Vitest skips a suite's hooks along with its
tests, so an assertion inside the `beforeAll` of a `describe.skipIf`-ed
block never executes — the first version of this guard silently did nothing
in precisely the situation it existed to catch. Module evaluation always
runs, so throwing there fails collection reliably.

## Migration History & Evolution

The schema has evolved through ordered migrations under `packages/database/prisma/migrations/`:

- **Phase 03 baseline**: tables for `users`, `organizations`, `organization_memberships`,
  `invitations`, and Row-Level Security policies.
- **Authentication & Sessions**: `credentials`, token tables, session storage, and password history.
- **Audit & Governance**: `audit_logs`, cryptographic anchors, and query performance indexes.
- **RBAC & Verification**: `roles`, `permissions`, `role_permissions`, `user_role_assignments`,
  MFA tables, verification requests, and policy versions.
