import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_DATABASE_URL,
  databaseAvailability,
  isDatabaseAvailable,
  testDatabaseUrl,
} from "./database.js";
import { createHttpTestClient } from "./http-client.js";
import { canConnect } from "./tcp-connect.js";

async function listeningPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a bound TCP address"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
    server.on("error", reject);
  });
}

async function closedPort(): Promise<number> {
  const { port, close } = await listeningPort();
  await close();
  return port;
}

describe("integration test helpers", () => {
  describe("tcp-connect", () => {
    it("resolves true for a listening port", async () => {
      const { port, close } = await listeningPort();
      try {
        await expect(canConnect("127.0.0.1", port)).resolves.toBe(true);
      } finally {
        await close();
      }
    });

    it("resolves false for a closed port", async () => {
      const port = await closedPort();
      await expect(canConnect("127.0.0.1", port)).resolves.toBe(false);
    });
  });

  describe("database helpers (without requiring a live database)", () => {
    const savedRequire = process.env["REQUIRE_DATABASE_TESTS"];
    const savedUrl = process.env["TEST_DATABASE_URL"];

    afterEach(() => {
      if (savedRequire === undefined) {
        delete process.env["REQUIRE_DATABASE_TESTS"];
      } else {
        process.env["REQUIRE_DATABASE_TESTS"] = savedRequire;
      }

      if (savedUrl === undefined) {
        delete process.env["TEST_DATABASE_URL"];
      } else {
        process.env["TEST_DATABASE_URL"] = savedUrl;
      }
    });

    it("testDatabaseUrl returns default when TEST_DATABASE_URL is unset", () => {
      delete process.env["TEST_DATABASE_URL"];
      expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
    });

    it("testDatabaseUrl honours custom TEST_DATABASE_URL", () => {
      process.env["TEST_DATABASE_URL"] = "postgresql://user:pass@remote:5432/custom_db";
      expect(testDatabaseUrl()).toBe("postgresql://user:pass@remote:5432/custom_db");
    });

    it("isDatabaseAvailable returns false when target port is closed", async () => {
      const port = await closedPort();
      process.env["TEST_DATABASE_URL"] =
        `postgresql://verixa:verixa@127.0.0.1:${String(port)}/verixa_test`;
      await expect(isDatabaseAvailable()).resolves.toBe(false);
    });

    it("databaseAvailability throws when REQUIRE_DATABASE_TESTS=1 and database is unreachable", async () => {
      const port = await closedPort();
      process.env["TEST_DATABASE_URL"] =
        `postgresql://verixa:verixa@127.0.0.1:${String(port)}/verixa_test`;
      process.env["REQUIRE_DATABASE_TESTS"] = "1";

      await expect(databaseAvailability()).rejects.toThrow(
        /REQUIRE_DATABASE_TESTS=1 but no database is reachable/,
      );
    });

    it("databaseAvailability returns false (skips) when REQUIRE_DATABASE_TESTS is unset and database is unreachable", async () => {
      const port = await closedPort();
      process.env["TEST_DATABASE_URL"] =
        `postgresql://verixa:verixa@127.0.0.1:${String(port)}/verixa_test`;
      delete process.env["REQUIRE_DATABASE_TESTS"];

      await expect(databaseAvailability()).resolves.toBe(false);
    });
  });

  describe("http-client", () => {
    it("boots a real app instance and responds to /health", async () => {
      const client = await createHttpTestClient();
      try {
        const response = await client.request.get("/health");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
      } finally {
        await client.close();
      }
    });
  });
});
