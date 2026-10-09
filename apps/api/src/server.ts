import { ConfigError, loadConfig } from "@verixa/config";
import { createLogger } from "@verixa/shared-kernel";

import { buildApp } from "./app.js";
import { buildContainer } from "./composition-root.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    // The structured logger (Issue 008) itself depends on config being valid,
    // so a config error can't be routed through it — this is the one place
    // console.error is the right tool.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({ name: "verixa-api", level: config.LOG_LEVEL });

// The composition root, finally constructed at runtime rather than only in
// tests. Until this line existed, every repository, use case and mapper in
const container = buildContainer();

const { rpId, origin, usingDefaults } = container.webauthn;
if (usingDefaults) {
  logger.warn(
    { rpId, origin },
    "WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN not set — using localhost defaults. " +
      "Every WebAuthn registration and assertion will be rejected in production. " +
      "Set both variables; see .env.example and docs/security/mfa-design.md.",
  );
} else {
  logger.info({ rpId, origin }, "WebAuthn relying party configured");
}

const app = buildApp({ logger, container });

// Close the database connection on shutdown rather than letting the process
// exit with connections still checked out. Postgres reclaims them eventually,
// but "eventually" during a rolling deploy means the new instances compete
// for a pool the old ones have not released.
const shutdown = (signal: string): void => {
  app.log.info({ signal }, "shutting down");
  void app
    .close()
    .then(() => container.dispose())
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    });
};

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

app.listen({ port: config.PORT, host: config.HOST }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
