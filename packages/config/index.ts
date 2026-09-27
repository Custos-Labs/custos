import { z } from "zod";

import { ConfigError } from "./config-error.js";

export { ConfigError } from "./config-error.js";
export { loadSigningKeys, SIGNING_KEY_ALGORITHMS, SIGNING_KEYS_ENV_VAR } from "./signing-keys.js";
export type { SigningKeyAlgorithm, SigningKeyConfig } from "./signing-keys.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  // Not yet read by any repository (that starts with Issue 046) — present
  // now so it flows through the same validated, fail-fast config loading
  // as everything else, and so tooling like scripts/db-wait.mjs has one
  // canonical place to get it from instead of reading process.env directly.
  DATABASE_URL: z.string().url().default("postgres://verixa:verixa@localhost:5432/verixa"),

  /**
   * Maximum Postgres connections this process will hold open (Issue 053).
   *
   * Sizing formula: `pool size ≈ (peak concurrent requests that touch the
   * database) / (number of app instances)`, then round up modestly. It is
   * deliberately *not* "as high as the database allows."
   *
   * Raising this is the reflexive fix for connection-pool timeouts and
   * usually makes throughput worse. Every Postgres connection is a separate
   * OS process with its own memory (work_mem is per-operation, per-connection),
   * and past the point where active connections exceed available cores, they
   * compete for CPU and lock contention rather than doing more work — so
   * total throughput falls while every individual query gets slower. A pool
   * that is "too small" and briefly queues requests generally beats one that
   * lets a hundred connections thrash.
   *
   * Timeouts under load usually mean queries are too slow or held too long
   * (a transaction awaiting a network call, a missing index), and the pool is
   * just where the symptom appears. Fix the query before touching this.
   *
   * Capped at 100 because exceeding a stock Postgres `max_connections` (also
   * 100) means connection *errors*, not slowness — and the failure is far
   * more confusing than a queue. Multiple app instances share that budget:
   * ten instances at 20 each is 200, and the eleventh connection past the
   * limit fails outright.
   */
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),

  /**
   * Seconds to wait for a free connection before giving up.
   *
   * Bounded on purpose. Waiting indefinitely turns pool exhaustion into a
   * hang that looks like a dead process, and each waiting request keeps
   * holding memory and an inbound socket — so an unbounded queue converts a
   * slow database into a full outage. Failing fast sheds load and surfaces
   * the real problem.
   */
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(10),

  /**
   * Connection string for the revocation-list store used by
   * `@verixa/sessions`'s `RedisRevocationList` (Phase 05, Issue 096).
   *
   * Defaults to the instance `docker-compose.yml` provisions for local
   * development — same reasoning as `DATABASE_URL`'s default. Was already
   * documented in `.env.example` ahead of any code reading it; this is that
   * code.
   */
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  /**
   * HMAC key `@verixa/sessions`'s `JwtTokenSigner` signs and verifies access
   * tokens with (Issue 096).
   *
   * Unlike `DATABASE_URL`, this has **no default**. A database URL pointing
   * at the wrong (but real) database is a mistake you notice; a signing key
   * everyone's `.env.example` shares is a mistake you don't, because nothing
   * about a session issued with it looks wrong until someone who copied the
   * same public default forges one. Access tokens are bearer credentials —
   * see `docs/security/token-storage.md` on why those get no free passes on
   * secrecy just because a workflow is convenient. Every environment,
   * including local development, generates its own with e.g. `openssl rand
   * -base64 48`.
   *
   * 32 characters is a floor, not a target — it stops a trivially short
   * placeholder from validating, not a guarantee of adequate entropy on its
   * own. Phase 11 covers key management (rotation, storage) properly.
   */
  SESSION_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, "must be at least 32 characters — generate one with `openssl rand -base64 48`"),
   * Maximum simultaneous active sessions a single user may hold (Issue 094).
   * Logging in past this limit evicts the least-recently-active session —
   * see `IssueSession` in `@verixa/sessions`.
   *
   * `0` (the default) disables enforcement entirely, per that issue's own
   * acceptance criterion. Unlike `DATABASE_POOL_SIZE`, there is no safe
   * non-zero default to fall back to: a banking-style deployment might want
   * `1`, a consumer product might never want this on, and guessing wrong in
   * either direction is a product decision this package has no basis to
   * make on a deployment's behalf. Zero is the only default that cannot
   * surprise anyone who has not deliberately opted in.
   */
  SESSION_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(0).default(0),
});

/** The fully validated, immutable application configuration. */
export type Config = Readonly<z.infer<typeof envSchema>>;

/**
 * Validates `process.env` (or a supplied source, for testing) against the
 * application's configuration schema. Throws a {@link ConfigError} listing
 * every problem found, rather than letting an invalid or missing variable
 * surface later as a confusing runtime failure somewhere unrelated.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }

  return Object.freeze(result.data);
}
