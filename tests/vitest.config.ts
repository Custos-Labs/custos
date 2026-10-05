import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../vitest.config.js";

const packageEntry = (name: string): string =>
  fileURLToPath(new URL(`../packages/${name}/index.ts`, import.meta.url));

/** A named entry point of a workspace package, resolved to its source. */
const packageSubpath = (name: string, entry: string): string =>
  fileURLToPath(new URL(`../packages/${name}/${entry}.ts`, import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    /**
     * Resolves two workspace packages to their source rather than their build
     * output.
     *
     * `injectWorkspacePackages: true` — required so `pnpm deploy` can build a
     * self-contained Docker image — makes pnpm *copy* a workspace package into
     * its dependents' `node_modules` instead of symlinking, whenever peer
     * resolution varies. `@verixa/audit` and `@verixa/stellar-anchor` qualify,
     * because the Stellar SDK brings `debug`/`supports-color` peers along;
     * `@verixa/identity` and the rest are symlinked and unaffected.
     *
     * Those copies are taken during `pnpm install`, when no package has a
     * `dist` yet, and nothing refreshes them before this suite runs — so every
     * spec failed on a clean checkout with "Failed to resolve entry for
     * package". It never reproduced locally, because a developer's
     * `node_modules` has been through an install *after* a build at some point.
     *
     * Pointing at source is the honest fix for a test runner: these specs
     * exercise behaviour, not packaging, and the Docker job already proves the
     * built artifacts resolve for real. The alternative — dropping
     * `injectWorkspacePackages` — would break the image build to fix the tests.
     */
    resolve: {
      alias: {
        // Listed before the bare specifier: Vite matches aliases in order, and
        // a `@verixa/audit` entry would otherwise swallow the subpath and then
        // fail to resolve `/testing` against a file path.
        "@verixa/audit/testing": packageSubpath("audit", "testing"),
        "@verixa/audit": packageEntry("audit"),
        "@verixa/stellar-anchor": packageEntry("stellar-anchor"),
      },
    },
    test: {
      name: "@verixa/integration-tests",

      /**
       * Spec files run one at a time, not in parallel.
       *
       * They share a single Postgres database, and several of them assert on
       * whole-table state (`prisma.user.count()`) or truncate tables in
       * `afterEach`. Run concurrently, those interleave: `index-usage.spec.ts`
       * seeds 3000 users, another file's `afterEach` deletes them mid-run, and
       * assertions see counts belonging to a different file entirely.
       *
       * That is exactly what CI caught — `expected 3002 to be 1`, plus a
       * foreign-key violation where one file deleted users another was still
       * inserting memberships for. Every individual test was correct; the
       * suite was not.
       *
       * Serial execution is the honest fix for a shared resource. It costs
       * wall-clock time, and the alternative — a separate database per spec
       * file — is genuinely better but belongs with the Testcontainers work
       * rather than bolted on here. Noted rather than silently accepted.
       */
      fileParallelism: false,
    },
  }),
);
