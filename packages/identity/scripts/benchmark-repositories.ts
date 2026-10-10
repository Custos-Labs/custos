import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@verixa/database";
import { Result } from "@verixa/shared-kernel";

import { User, type UserId } from "../domain/entities/user.js";
import { DisplayName } from "../domain/value-objects/display-name.js";
import { Email } from "../domain/value-objects/email.js";
import { PrismaUserRepository } from "../infrastructure/persistence/prisma-user-repository.js";

/**
 * Measures latency of the core repository operations (Issue 059).
 *
 *   pnpm db:benchmark
 *
 * ## What a baseline is for
 *
 * You cannot say something "got slower" without a number from before. This
 * script exists so that when Phase 23 starts optimizing, there is a recorded
 * starting point rather than an argument about whether the current behavior
 * was always like this.
 *
 * ## Why p95 and not just an average
 *
 * A mean hides the tail, and the tail is what users experience as "the app is
 * slow". One request in twenty taking 400ms is a real problem that a 12ms
 * average conceals completely. p50 says what a typical request costs; p95 says
 * what a bad one costs. Both are reported because optimizing one at the
 * expense of the other is a common and invisible mistake.
 *
 * ## What these numbers are *not*
 *
 * They are not a performance target, and they are not comparable across
 * machines. Latency here is dominated by the round trip to Postgres, so a
 * local container, a shared CI runner, and a production instance across a
 * network will differ by an order of magnitude for reasons that have nothing
 * to do with the code. A baseline is only meaningful compared against itself,
 * measured the same way on the same hardware.
 */

export const DEFAULT_BENCHMARK_ITERATIONS = 200;
export const DEFAULT_BENCHMARK_WARMUP = 20;

export interface BenchmarkConfig {
  readonly iterations: number;
  readonly warmup: number;
  readonly databaseUrl: string;
}

export function parseBenchmarkConfig(env: NodeJS.ProcessEnv = process.env): BenchmarkConfig {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL environment variable is required to run benchmarks");
  }

  const iterationsRaw = env["BENCH_ITERATIONS"];
  const iterations =
    iterationsRaw !== undefined && iterationsRaw !== ""
      ? Number(iterationsRaw)
      : DEFAULT_BENCHMARK_ITERATIONS;

  if (Number.isNaN(iterations) || !Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(
      `Invalid BENCH_ITERATIONS: expected positive integer, got "${String(iterationsRaw)}"`,
    );
  }

  const warmupRaw = env["BENCH_WARMUP"];
  const warmup =
    warmupRaw !== undefined && warmupRaw !== "" ? Number(warmupRaw) : DEFAULT_BENCHMARK_WARMUP;

  if (Number.isNaN(warmup) || !Number.isInteger(warmup) || warmup < 0) {
    throw new Error(
      `Invalid BENCH_WARMUP: expected non-negative integer, got "${String(warmupRaw)}"`,
    );
  }

  return {
    iterations,
    warmup,
    databaseUrl,
  };
}

export interface Measurement {
  readonly operation: string;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  // Nearest-rank: the smallest value at or above the given percentile. Simple
  // and honest about being an estimate at these sample sizes — interpolating
  // between samples would imply a precision 200 iterations do not support.
  const rank = Math.ceil((p / 100) * sortedMs.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedMs.length - 1);
  // `.at()` rather than `sortedMs[index]`: bracket access with a computed
  // index trips security/detect-object-injection, and restructuring beats
  // suppressing the rule.
  return sortedMs.at(index) ?? 0;
}

export async function measure(
  operation: string,
  run: (i: number) => Promise<unknown>,
  iterations = DEFAULT_BENCHMARK_ITERATIONS,
  warmup = DEFAULT_BENCHMARK_WARMUP,
): Promise<Measurement> {
  // Warm-up runs are discarded. The first few calls pay for connection
  // establishment, Prisma's query-engine startup, and a cold buffer cache —
  // costs that are real but one-off, and that would otherwise dominate the
  // max and distort p95.
  for (let i = 0; i < warmup; i += 1) {
    await run(-1 - i);
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }

  samples.sort((a, b) => a - b);
  return {
    operation,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: samples[0] ?? 0,
    max: samples[samples.length - 1] ?? 0,
  };
}

function makeUser(seed: string): User {
  const email = Email.create(`bench-${seed}@example.com`);
  const displayName = DisplayName.create("Bench User");
  if (!Result.isOk(email) || !Result.isOk(displayName)) {
    throw new Error("benchmark fixture setup failed");
  }
  return User.register({ email: email.value, displayName: displayName.value });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseBenchmarkConfig(env);
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const users = new PrismaUserRepository(prisma);

  const seeded: User[] = [];
  const results: Measurement[] = [];

  try {
    await prisma.$connect();

    console.log(`Benchmarking against ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
    console.log(`${String(config.iterations)} iterations, ${String(config.warmup)} warm-up\n`);

    results.push(
      await measure(
        "UserRepository.save (insert)",
        async (i) => {
          const user = makeUser(`${randomUUID()}-${String(i)}`);
          await users.save(user);
          if (i >= 0) seeded.push(user);
        },
        config.iterations,
        config.warmup,
      ),
    );

    if (seeded.length === 0) throw new Error("no users were seeded");

    results.push(
      await measure(
        "UserRepository.findById",
        async (i) => {
          const user = seeded[Math.abs(i) % seeded.length];
          return users.findById(user?.id as UserId);
        },
        config.iterations,
        config.warmup,
      ),
    );

    results.push(
      await measure(
        "UserRepository.findByEmail",
        async (i) => {
          const user = seeded[Math.abs(i) % seeded.length];
          if (user === undefined) return undefined;
          return users.findByEmail(user.email);
        },
        config.iterations,
        config.warmup,
      ),
    );

    results.push(
      await measure(
        "UserRepository.existsByEmail",
        async (i) => {
          const user = seeded[Math.abs(i) % seeded.length];
          if (user === undefined) return false;
          return users.existsByEmail(user.email);
        },
        config.iterations,
        config.warmup,
      ),
    );

    results.push(
      await measure(
        "UserRepository.save (update)",
        async (i) => {
          const user = seeded[Math.abs(i) % seeded.length];
          if (user === undefined) return;
          await users.save(user);
        },
        config.iterations,
        config.warmup,
      ),
    );

    console.log("| Operation | p50 (ms) | p95 (ms) | p99 (ms) | min | max |");
    console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const r of results) {
      console.log(
        `| ${r.operation} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ` +
          `${r.p99.toFixed(2)} | ${r.min.toFixed(2)} | ${r.max.toFixed(2)} |`,
      );
    }
  } finally {
    if (seeded.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: seeded.map((u) => u.id) } } });
    }
    await prisma.$disconnect();
  }
}

const isMainModule = Boolean(
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)),
);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error("Benchmark failed:", error);
    process.exitCode = 1;
  });
}
