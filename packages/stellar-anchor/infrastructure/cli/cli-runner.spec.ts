import { describe, expect, it } from "vitest";

import { InMemoryHashAnchor } from "../testing/in-memory-hash-anchor.js";

import { runCli, type AnchorCliDeps } from "./cli-runner.js";

/** sha256("test") — a valid 64-char lowercase hex digest. */
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

interface CliRun {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

function run(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: AnchorCliDeps = {
    argv,
    env,
    io: {
      log: (message) => {
        stdout.push(message);
      },
      error: (message) => {
        stderr.push(message);
      },
    },
    // The existing testing fake: no network, no funded account, no real secret.
    createAnchor: () => new InMemoryHashAnchor(),
  };
  return runCli(deps).then((exitCode) => ({ exitCode, stdout, stderr }));
}

describe("anchor-cli", () => {
  it("refuses to sign on public without STELLAR_ALLOW_LOCAL_SIGNING=1", async () => {
    const { exitCode, stderr } = await run(["anchor", HASH], {
      STELLAR_NETWORK: "public",
      STELLAR_ANCHOR_SECRET_KEY: "Sdummy",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/Refusing to sign on the public network/);
  });

  it("exits non-zero with a readable message when STELLAR_ANCHOR_SECRET_KEY is missing", async () => {
    const { exitCode, stderr } = await run(["anchor", HASH], { STELLAR_NETWORK: "testnet" });
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/STELLAR_ANCHOR_SECRET_KEY must be set/);
  });

  it("reports the receipt on a valid invocation", async () => {
    const { exitCode, stdout } = await run(["anchor", HASH], {
      STELLAR_ANCHOR_SECRET_KEY: "Sdummy",
    });
    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain(`ANCHORED: ${HASH}`);
    expect(out).toMatch(/reference:\s+\S+/);
    expect(out).toMatch(/at:\s+\S+/);
  });

  it("exits non-zero with a readable message when balance has no key at all", async () => {
    const { exitCode, stderr } = await run(["balance"], {});
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/STELLAR_ANCHOR_PUBLIC_KEY/);
  });

  it("rejects a malformed hash before touching the network", async () => {
    const { exitCode, stderr } = await run(["anchor", "not-a-hash"], {
      STELLAR_ANCHOR_SECRET_KEY: "Sdummy",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/64-character lowercase hex/);
  });

  it("requires an anchor reference for verify", async () => {
    const { exitCode, stderr } = await run(["verify", HASH], {});
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/anchor reference/);
  });
});
