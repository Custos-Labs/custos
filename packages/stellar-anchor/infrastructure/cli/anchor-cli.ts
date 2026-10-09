#!/usr/bin/env node
import { runCli } from "./cli-runner.js";

runCli({
  argv: process.argv.slice(2),
  env: process.env,
  io: {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  },
}).then(
  (exitCode) => process.exit(exitCode),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
