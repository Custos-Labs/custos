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
        },
      },
    },
  }),
);
