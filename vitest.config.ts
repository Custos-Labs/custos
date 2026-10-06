import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Shared base config every package's vitest.config.ts merges into its own.
 * Not run directly against the whole monorepo in one process — each package
 * still runs its own `vitest run` (see package.json "test" scripts) so a
 * package's tests execute with that package's own node_modules and working
 * directory, which matters once cross-package imports (Issue 007) are
 * involved.
 */
export default defineConfig({
  resolve: {
    alias: {
      // @stellar/stellar-sdk pulls in debug/supports-color through a chain
      // that gives @verixa/stellar-anchor a peer-dependency signature, which
      // makes pnpm materialize it as a content-filtered `file:` copy for
      // some consumers (apps/api) instead of a plain workspace symlink
      // (packages/audit gets the symlink and never hits this). A `file:`
      // copy only contains git-tracked files, so the gitignored `dist/`
      // output built by `pnpm build` is silently missing from it, and
      // Vite's stricter entry resolution in v6 fails rather than guessing.
      // Aliasing straight to the real build output sidesteps node_modules
      // resolution for this one package entirely.
      "@verixa/stellar-anchor": `${repoRoot}packages/stellar-anchor/dist/index.js`,
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      exclude: ["**/dist/**", "**/*.spec.ts", "**/vitest.config.ts", "**/eslint.config.mjs"],
    },
  },
});
