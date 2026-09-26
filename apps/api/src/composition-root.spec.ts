import {
  IssueSession,
  ListActiveSessions,
  Logout,
  LogoutEverywhere,
  RefreshAccessToken,
} from "@verixa/sessions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildContainer } from "./composition-root.js";

/**
 * Exercises the sessions wiring added to the composition root (Issue 096)
 * without a real Postgres or Redis: `PrismaClient` and the `ioredis` client
 * are both lazy by construction (see `buildContainer`'s comments), so
 * building the container and inspecting its shape never opens either
 * connection. `tests/integration/composition-root.spec.ts` is the
 * complementary end-to-end proof against a real database for the
 * identity/credentials wiring; this is the boot smoke test the sessions
 * acceptance criteria ask for — "resolves all sessions-package use cases
 * with real (non-fake) adapters" — for the part that doesn't need live
 * infrastructure to demonstrate.
 */
describe("composition root: sessions", () => {
  const originalSecret = process.env["SESSION_ACCESS_TOKEN_SECRET"];

  beforeEach(() => {
    process.env["SESSION_ACCESS_TOKEN_SECRET"] = "test-only-secret-value-at-least-32-chars";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env["SESSION_ACCESS_TOKEN_SECRET"];
    } else {
      process.env["SESSION_ACCESS_TOKEN_SECRET"] = originalSecret;
    }
  });

  it("resolves every sessions use case with real (Prisma/Redis-backed) adapters", async () => {
    const container = buildContainer();
    try {
      expect(container.sessions.issueSession).toBeInstanceOf(IssueSession);
      expect(container.sessions.refreshAccessToken).toBeInstanceOf(RefreshAccessToken);
      expect(container.sessions.logout).toBeInstanceOf(Logout);
      expect(container.sessions.logoutEverywhere).toBeInstanceOf(LogoutEverywhere);
      expect(container.sessions.listActiveSessions).toBeInstanceOf(ListActiveSessions);
    } finally {
      await container.dispose();
    }
  });

  it("fails fast at startup when no signing secret is configured", () => {
    delete process.env["SESSION_ACCESS_TOKEN_SECRET"];

    expect(() => buildContainer()).toThrow(/SESSION_ACCESS_TOKEN_SECRET/);
  });
});
