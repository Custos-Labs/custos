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
