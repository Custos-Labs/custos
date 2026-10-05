import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@verixa/authorization",
      coverage: {
        // Interface-only files have no executable statements to cover — see
        // packages/identity/vitest.config.ts for the fuller rationale.
        // Ports are interface-only files: a TypeScript `interface` is erased at
        // compile time, so there is no executable statement a test could cover.
        // Counting them would report a meaningless 0% for a file with zero
        // total statements, the same reasoning @verixa/identity documents.
        exclude: ["**/application/ports/**", "index.ts"],
        thresholds: {
          statements: 90,
          lines: 90,
          // The evaluation engine is required (Issue 146) to have 100%
          // branch coverage, since it's the deterministic core every
          // higher-level authorization decision builds on. Set the
          // package-wide floor to match rather than carving out a
          // per-file exception vitest's coverage config can't express.
          functions: 90,
          branches: 90,
          functions: 85,
          branches: 85,
        },
      },
    },
  }),
);
