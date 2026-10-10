import { Keypair } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";

import { stroopsToXlm, type AnchorFundingAlert } from "../../application/ports/account-balance.js";
import { isValidSha256Hex, type HashAnchor } from "../../application/ports/hash-anchor.js";
import { AnchorBalanceMonitor, HorizonAccountBalanceReader } from "../balance-monitor.js";
import { LocalTransactionSigner } from "../signing/local-transaction-signer.js";
import { StellarHashAnchor, type StellarNetwork } from "../stellar/stellar-hash-anchor.js";

const USAGE = `
Usage:
  anchor  <sha256-hex>                 Anchor a hash to Stellar (requires STELLAR_ANCHOR_SECRET_KEY)
  verify  <sha256-hex> <anchor-ref>    Check that a Stellar transaction commits to a hash
  balance                              Report the anchoring account's balance as a metric line

Environment:
  STELLAR_ANCHOR_SECRET_KEY   Secret key (S...) of the anchoring account. Required for "anchor".
                              Development and testnet only; see the note in this file's header.
  STELLAR_NETWORK             "testnet" (default) or "public".
  STELLAR_ALLOW_LOCAL_SIGNING Set to "1" to permit signing with the above on the public network.
  STELLAR_ANCHOR_PUBLIC_KEY   Account to report in "balance", if the secret key is not available.
  STELLAR_ANCHOR_MIN_XLM      Alert threshold in XLM for "balance". Defaults to 1.

"balance" exits 0 when funded, 1 below the threshold, and 2 when the account
cannot cover a fee, the balance is unreadable, or Horizon is unreachable.
`.trim();

/** Where the CLI writes. The real entry uses console; tests capture. */
export interface CliIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export interface AnchorCliDeps {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly io: CliIo;
  /**
   * Builds the anchor backend for the `anchor` command. Defaults to a
   * StellarHashAnchor signing with a LocalTransactionSigner (the development
   * path). Tests substitute the existing `InMemoryHashAnchor` fake — which is
   * why the refusal and receipt paths are testable with no network, no funded
   * account, and no real secret.
   */
  readonly createAnchor?: (network: StellarNetwork, secretKey: string) => HashAnchor;
}

/** A CLI failure with a defined exit code. Thrown internally, never leaks. */
class CliFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

function fail(message: string, exitCode = 1): never {
  throw new CliFailure(message, exitCode);
}

function resolveNetwork(env: Record<string, string | undefined>): StellarNetwork {
  const value = env["STELLAR_NETWORK"] ?? "testnet";
  if (value !== "testnet" && value !== "public") {
    fail(`STELLAR_NETWORK must be "testnet" or "public", received "${value}".`);
  }
  return value;
}

async function reportBalance(deps: AnchorCliDeps): Promise<number> {
  const { env, io } = deps;
  const network = resolveNetwork(env);
  const thresholdXlm = Number(env["STELLAR_ANCHOR_MIN_XLM"] ?? "1");
  if (!Number.isFinite(thresholdXlm) || thresholdXlm < 0) {
    fail("STELLAR_ANCHOR_MIN_XLM must be a non-negative number of XLM.");
  }

  const secretKey = env["STELLAR_ANCHOR_SECRET_KEY"];
  const publicKey =
    env["STELLAR_ANCHOR_PUBLIC_KEY"] ??
    (secretKey === undefined || secretKey.length === 0
      ? undefined
      : Keypair.fromSecret(secretKey).publicKey());

  if (publicKey === undefined) {
    fail(
      "balance needs STELLAR_ANCHOR_PUBLIC_KEY (preferred) or STELLAR_ANCHOR_SECRET_KEY to derive it from.",
    );
  }

  const alerts: AnchorFundingAlert[] = [];
  const monitor = new AnchorBalanceMonitor({
    reader: new HorizonAccountBalanceReader({ network }),
    publicKey,
    thresholdXlm,
    alerter: { alert: (alert) => void alerts.push(alert) },
  });

  const status = await monitor.check();

  io.log(
    JSON.stringify({
      name: "verixa_stellar_anchor_balance_xlm",
      network,
      publicKey,
      status: status.kind,
      availableXlm:
        status.kind === "unknown" ? undefined : stroopsToXlm(status.balance.availableStroops),
      thresholdXlm,
    }),
  );

  for (const alert of alerts) {
    io.error(`ALERT ${alert.kind}: ${alert.message}`);
  }

  return status.kind === "funded" ? 0 : status.kind === "below_threshold" ? 1 : 2;
}

async function run(deps: AnchorCliDeps): Promise<number> {
  const { argv, env, io } = deps;
  const [command, ...args] = argv;

  if (command === "balance") {
    return await reportBalance(deps);
  }

  if (command !== "anchor" && command !== "verify") {
    fail(USAGE);
  }

  const hash = args[0];
  if (hash === undefined || !isValidSha256Hex(hash)) {
    fail("Expected a 64-character lowercase hex SHA-256 digest as the first argument.");
  }

  const network = resolveNetwork(env);

  if (command === "verify") {
    const anchorRef = args[1];
    if (anchorRef === undefined) {
      fail(
        "verify requires an anchor reference (a Stellar transaction hash) as its second argument.",
      );
    }

    const anchor = new StellarHashAnchor({ network });

    const result = await anchor.verify(hash, anchorRef);
    if (Result.isErr(result)) {
      fail(`Verification could not be completed: ${result.error.message}`);
    }

    if (result.value) {
      io.log(`VERIFIED: transaction ${anchorRef} commits to ${hash} on ${network}.`);
      return 0;
    }

    io.error(`NOT VERIFIED: transaction ${anchorRef} does not commit to ${hash}.`);
    return 1;
  }

  if (network === "public" && env["STELLAR_ALLOW_LOCAL_SIGNING"] !== "1") {
    fail(
      "Refusing to sign on the public network with a key from the environment.\nSet STELLAR_ALLOW_LOCAL_SIGNING=1 only if you accept the risk described in docs/security/stellar-key-management.md, and wire a KmsTransactionSigner instead.",
    );
  }

  const secretKey = env["STELLAR_ANCHOR_SECRET_KEY"];
  if (secretKey === undefined || secretKey.length === 0) {
    fail("STELLAR_ANCHOR_SECRET_KEY must be set to anchor a hash.");
  }

  const anchor =
    deps.createAnchor !== undefined
      ? deps.createAnchor(network, secretKey)
      : new StellarHashAnchor({ signer: new LocalTransactionSigner(secretKey), network });
  const result = await anchor.anchor(hash);

  if (Result.isErr(result)) {
    fail(`Anchoring failed: ${result.error.message}`);
  }

  io.log(`ANCHORED: ${hash}`);
  io.log(`  network:   ${result.value.network}`);
  io.log(`  reference: ${result.value.anchorRef}`);
  io.log(`  at:        ${result.value.anchoredAt.toISOString()}`);
  return 0;
}

/** Runs the CLI against injected deps. Returns the process exit code. */
export async function runCli(deps: AnchorCliDeps): Promise<number> {
  try {
    return await run(deps);
  } catch (error) {
    if (error instanceof CliFailure) {
      deps.io.error(error.message);
      return error.exitCode;
    }
    deps.io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
