# Configuration

`@verixa/config` (`packages/config`) loads and validates `process.env` with
[Zod](https://zod.dev/) at process startup and hands back a typed, immutable
config object. No other code should read `process.env` directly.

## Usage

```ts
import { ConfigError, loadConfig } from "@verixa/config";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
```

`loadConfig()` is pure and synchronous — pass it an explicit
`Record<string, string | undefined>` in tests instead of mutating
`process.env`.

## The fail-fast principle

Reading `process.env.SOME_VAR` scattered across a codebase means every one of
those call sites can fail independently, at whatever moment the code path
finally executes — often deep in production, hours after deployment, in a
branch nobody hit during smoke testing. `loadConfig()` validates the entire
environment schema **once, at startup**, so a missing or malformed variable
is a deployment that fails to boot, not a 3am page for a `NullPointer`-shaped
bug three layers deep.

This is the same reasoning behind validating input at your API boundary
(Phase 12) rather than trusting it all the way down the call stack: catch
the invalid state as early as possible, where the failure is obvious and the
fix is obvious, instead of letting it propagate into ambiguous downstream
symptoms.

## Schema

Configuration is divided into variables validated upfront by `@verixa/config`
(which fail fast on startup if invalid or missing) and those read directly by the
composition root or infrastructure adapters (which fall back to local development
defaults or enforce specific runtime invariants).

### Validated by `@verixa/config`

Validated at process startup with Zod. Missing required variables or malformed values
fail fast with a `ConfigError` before any listener binds or connection pool opens.

| Variable                          | Required | Default                                          | Notes                                                                                                                |
| --------------------------------- | -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | no       | `development`                                    | `development` \| `test` \| `production`                                                                              |
| `PORT`                            | no       | `3000`                                           | coerced from string to number, 1–65535                                                                               |
| `HOST`                            | no       | `0.0.0.0`                                        | interface the server binds to                                                                                        |
| `LOG_LEVEL`                       | no       | `info`                                           | consumed by the logger added in Issue 008 (`trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent`) |
| `DATABASE_URL`                    | no       | `postgres://verixa:verixa@localhost:5432/verixa` | connection string for the primary Postgres database                                                                  |
| `DATABASE_POOL_SIZE`              | no       | `10`                                             | max 100 (stock Postgres `max_connections`); sizing formula: `pool size ≈ peak concurrent requests / app instances`   |
| `DATABASE_POOL_TIMEOUT_SECONDS`   | no       | `10`                                             | max 300; seconds to wait for a free connection before throwing pool timeout                                          |
| `REDIS_URL`                       | no       | `redis://localhost:6379`                         | connection string for `@verixa/sessions`'s `RedisRevocationList` deny-list                                           |
| `SESSION_ACCESS_TOKEN_SECRET`     | **yes**  | none                                             | ≥32 chars HMAC secret for JWT access tokens (`openssl rand -base64 48`)                                              |
| `SESSION_MAX_CONCURRENT_SESSIONS` | no       | `0`                                              | maximum concurrent active sessions per user; `0` disables eviction enforcement                                       |
| `MFA_ENFORCEMENT_LEVEL`           | no       | `optional`                                       | global default policy: `required` \| `optional` \| `disabled`                                                        |
| `MFA_ALLOWED_METHODS`             | no       | all methods                                      | comma-separated list of permitted MFA methods (e.g. `totp,webauthn`)                                                 |

### Read directly (composition root / not validated)

Read directly at the composition root (`apps/api/src/composition-root.ts`) or in domain adapters.
Most fall back to safe local development defaults, while critical secrets enforce runtime fail-fast checks.

| Variable                      | Default when unset                | Notes                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MFA_ENCRYPTION_KEY`          | **none — `encrypt` throws**       | **Required for MFA; rotation-sensitive.** Base64 of 32 bytes (AES-256-GCM). There is deliberately no fallback: the old constant-key fallback stored every TOTP secret under a key published in this repository (`docs/QUARANTINE.md`). **Cannot be rotated** without making stored TOTP secrets undecryptable — users would have to re-enroll. Generate with `openssl rand -base64 32`. |
| `STELLAR_NETWORK`             | `testnet`                         | `testnet` or `public` (mainnet) for audit-log ledger anchoring                                                                                                                                                                                                                                                                                                                          |
| `STELLAR_SIGNING_BACKEND`     | `local` if key set, else disabled | `local` for env-held key; `kms` requires an injected signer via `ContainerOverrides`                                                                                                                                                                                                                                                                                                    |
| `STELLAR_ANCHOR_SECRET_KEY`   | unset                             | Stellar secret seed (`S...`); anchoring disabled when unset; verification requires no key                                                                                                                                                                                                                                                                                               |
| `STELLAR_ALLOW_LOCAL_SIGNING` | unset                             | must be set to `1` to permit local secret key signing on the `public` mainnet network                                                                                                                                                                                                                                                                                                   |
| `AUDIT_BATCHED_WRITES`        | unset (per-event writes)          | set `1` to batch audit writes via `BatchedAuditWriter`; see `docs/performance/audit-write-throughput.md`                                                                                                                                                                                                                                                                                |
| `AUDIT_MAX_BATCH_SIZE`        | `100`                             | max entries flushed in a single batch transaction; malformed values degrade to default                                                                                                                                                                                                                                                                                                  |
| `AUDIT_FLUSH_INTERVAL_MS`     | `250`                             | batch buffer flush interval in milliseconds                                                                                                                                                                                                                                                                                                                                             |
| `AUDIT_MAX_QUEUE_SIZE`        | `10000`                           | memory queue ceiling before backpressure shedding occurs                                                                                                                                                                                                                                                                                                                                |
| `WEBAUTHN_RP_ID`              | `localhost`                       | relying-party domain ID; must match the visited domain in production (`verixa.example`)                                                                                                                                                                                                                                                                                                 |
| `WEBAUTHN_ORIGIN`             | `http://localhost:3000`           | expected browser origin; must match the full HTTPS origin in production (`https://verixa.example`); startup warns when defaults are active                                                                                                                                                                                                                                              |

### Excluded test-only and multi-key variables

The following variables appear in `.env.example` but are excluded from the runtime tables:

- `TEST_DATABASE_URL`: Dedicated test database (`verixa_test`) exclusively for integration tests so test runs never mutate development state (see `docs/guides/database.md`).
- `TEST_REDIS_URL`: Dedicated Redis instance exclusively for sessions integration test suites.
- `TOKEN_SIGNING_KEYS`: Multi-key JSON array loaded via `loadSigningKeys()` in `@verixa/config` for asymmetric access token signing and key rotation (see `docs/security/token-design.md`).
| Variable          | Required | Default                 | Notes                                                                                                                                                             |
| ----------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`        | no       | `development`           | `development` \| `test` \| `production`                                                                                                                           |
| `PORT`            | no       | `3000`                  | coerced from string to number, 1–65535                                                                                                                            |
| `HOST`            | no       | `0.0.0.0`               | interface the server binds to                                                                                                                                     |
| `LOG_LEVEL`       | no       | `info`                  | consumed by the logger added in Issue 008                                                                                                                         |
| `WEBAUTHN_RP_ID`  | no       | `localhost`             | read at the composition root (`apps/api/src/composition-root.ts`), not by `@verixa/config` — must be the production domain or every WebAuthn ceremony is rejected |
| `WEBAUTHN_ORIGIN` | no       | `http://localhost:3000` | same; must be the full production origin                                                                                                                          |

See `.env.example` at the repo root for a copyable starting point (`cp
.env.example .env`). `.env` itself is git-ignored — never commit real secrets.

## Errors

A validation failure throws `ConfigError`, whose `message` lists every
invalid field (not just the first one found), so a contributor fixes their
`.env` in one pass instead of playing whack-a-mole:

```
Invalid environment configuration:
  - PORT: Expected number, received nan
  - HOST: String must contain at least 1 character(s)
```
