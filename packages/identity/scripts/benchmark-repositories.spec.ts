import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BENCHMARK_ITERATIONS,
  DEFAULT_BENCHMARK_WARMUP,
  measure,
  parseBenchmarkConfig,
  percentile,
} from "./benchmark-repositories.js";

describe("benchmark-repositories config and runners (no database required)", () => {
  describe("parseBenchmarkConfig", () => {
    it("returns default iterations and warmup when only DATABASE_URL is set", () => {
      const config = parseBenchmarkConfig({
        DATABASE_URL: "postgres://verixa:verixa@localhost:5432/verixa",
      });

      expect(config.iterations).toBe(DEFAULT_BENCHMARK_ITERATIONS);
      expect(config.iterations).toBe(200);
      expect(config.warmup).toBe(DEFAULT_BENCHMARK_WARMUP);
      expect(config.warmup).toBe(20);
      expect(config.databaseUrl).toBe("postgres://verixa:verixa@localhost:5432/verixa");
    });

    it("honours custom BENCH_ITERATIONS override", () => {
      const config = parseBenchmarkConfig({
        DATABASE_URL: "postgres://localhost/test",
        BENCH_ITERATIONS: "45",
      });

      // Acceptance criterion: A test fails if BENCH_ITERATIONS is ignored
      expect(config.iterations).toBe(45);
      expect(config.iterations).not.toBe(DEFAULT_BENCHMARK_ITERATIONS);
    });

    it("honours custom BENCH_WARMUP override", () => {
      const config = parseBenchmarkConfig({
        DATABASE_URL: "postgres://localhost/test",
        BENCH_WARMUP: "5",
      });

      expect(config.warmup).toBe(5);
      expect(config.warmup).not.toBe(DEFAULT_BENCHMARK_WARMUP);
    });

    it("honours both BENCH_ITERATIONS and BENCH_WARMUP overrides simultaneously", () => {
      const config = parseBenchmarkConfig({
        DATABASE_URL: "postgres://localhost/test",
        BENCH_ITERATIONS: "500",
        BENCH_WARMUP: "50",
      });

      expect(config.iterations).toBe(500);
      expect(config.warmup).toBe(50);
    });

    it("throws a clear error when DATABASE_URL is unset", () => {
      expect(() => parseBenchmarkConfig({})).toThrow(/DATABASE_URL/);
    });

    it("throws a clear error when DATABASE_URL is whitespace only", () => {
      expect(() => parseBenchmarkConfig({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
    });

    it("throws a validation error when BENCH_ITERATIONS is not a positive integer", () => {
      expect(() =>
        parseBenchmarkConfig({
          DATABASE_URL: "postgres://localhost/test",
          BENCH_ITERATIONS: "not-a-number",
        }),
      ).toThrow(/Invalid BENCH_ITERATIONS/);

      expect(() =>
        parseBenchmarkConfig({
          DATABASE_URL: "postgres://localhost/test",
          BENCH_ITERATIONS: "0",
        }),
      ).toThrow(/Invalid BENCH_ITERATIONS/);

      expect(() =>
        parseBenchmarkConfig({
          DATABASE_URL: "postgres://localhost/test",
          BENCH_ITERATIONS: "-10",
        }),
      ).toThrow(/Invalid BENCH_ITERATIONS/);
    });

    it("throws a validation error when BENCH_WARMUP is negative or invalid", () => {
      expect(() =>
        parseBenchmarkConfig({
          DATABASE_URL: "postgres://localhost/test",
          BENCH_WARMUP: "invalid",
        }),
      ).toThrow(/Invalid BENCH_WARMUP/);

      expect(() =>
        parseBenchmarkConfig({
          DATABASE_URL: "postgres://localhost/test",
          BENCH_WARMUP: "-1",
        }),
      ).toThrow(/Invalid BENCH_WARMUP/);
    });
  });

  describe("measure runner", () => {
    it("executes the exact number of iterations and warmup specified", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const customIterations = 12;
      const customWarmup = 3;

      const measurement = await measure("test.operation", fn, customIterations, customWarmup);

      // Total invocations must equal warmup + iterations
      expect(fn).toHaveBeenCalledTimes(customWarmup + customIterations);
      expect(measurement.operation).toBe("test.operation");
      expect(typeof measurement.p50).toBe("number");
      expect(typeof measurement.p95).toBe("number");
      expect(typeof measurement.p99).toBe("number");
      expect(measurement.min).toBeLessThanOrEqual(measurement.max);
    });
  });

  describe("percentile helper", () => {
    it("returns 0 for empty samples", () => {
      expect(percentile([], 50)).toBe(0);
    });

    it("computes nearest-rank percentile correctly", () => {
      const samples = [10, 20, 30, 40, 50];
      expect(percentile(samples, 50)).toBe(30);
      expect(percentile(samples, 95)).toBe(50);
      expect(percentile(samples, 1)).toBe(10);
    });
  });
});
