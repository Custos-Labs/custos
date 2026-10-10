import { AccountLockedError, Result } from "@verixa/shared-kernel";

import type { UserId } from "../../domain/entities/mfa-method.js";
import { BackupCodeSet } from "../../domain/services/backup-code-set.js";
import type { AuditLogger } from "../ports/audit-logger.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";

export interface ConsumeBackupCodeCommand {
  readonly userId: string;
  readonly code: string;
}

export type ConsumeBackupCodeOutcome =
  | { readonly kind: "ok"; readonly codesRemaining: number }
  | { readonly kind: "exhausted" }
  | { readonly kind: "failed" };

export type ConsumeBackupCodeError = AccountLockedError | Error;

export type ConsumeBackupCodeResult = Result<ConsumeBackupCodeOutcome, ConsumeBackupCodeError>;

export class ConsumeBackupCode {
  constructor(
    private readonly mfaMethodRepository: MfaMethodRepository,
    private readonly auditLogger: AuditLogger,
  ) {}

  async execute(command: ConsumeBackupCodeCommand): Promise<ConsumeBackupCodeResult> {
    const userId = command.userId as UserId;

    const activeMethods = await this.mfaMethodRepository.findActiveByUserId(userId);
    const backupMethod = activeMethods.find((m) => m.type === "backup_codes");

    if (!backupMethod || !backupMethod.secret) {
      // Intentionally taking the same time as a failure?
      // Actually we should burn time here to prevent timing attacks,
      // but without a decoy hash, we can't easily burn time.
      // For now we'll just fail.
      return Result.ok({ kind: "failed" });
    }

    const now = new Date();
    if (backupMethod.isLockedAt(now)) {
      return Result.err(new AccountLockedError("Authentication attempts are rate-limited."));
    }

    const hashes = parseStoredHashes(backupMethod.secret);
    if (hashes === null) {
      return Result.ok({ kind: "failed" });
    }

    let matchedIndex = -1;

    // Hashing is expensive. We verify sequentially until a match is found.
    // If it's an attack, they will pay the cost of verifying all remaining hashes.
    for (let i = 0; i < hashes.length; i++) {
      const isValid = await BackupCodeSet.verify(command.code, hashes[i]!);
      if (isValid) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      backupMethod.recordFailedAttempt(now);
      await this.mfaMethodRepository.save(backupMethod);
      await this.auditLogger.record("backup_code.failed", userId);
      return Result.ok({ kind: "failed" });
    }

    // Match found. Consume the code by removing its hash.
    hashes.splice(matchedIndex, 1);

    // Update the record with the remaining hashes and clear lockout / failure counter.
    backupMethod.updateSecret(JSON.stringify(hashes), now);
    backupMethod.recordUse(now);
    await this.mfaMethodRepository.save(backupMethod);

    await this.auditLogger.record("backup_code.consumed", userId, {
      remaining: hashes.length.toString(),
    });

    if (hashes.length === 0) {
      return Result.ok({ kind: "exhausted" });
    }

    return Result.ok({ kind: "ok", codesRemaining: hashes.length });
  }
}

/**
 * Reads the stored backup-code hashes.
 *
 * `JSON.parse` is typed `any`, so the shape is checked rather than asserted: a
 * secret holding valid JSON of the wrong shape (an object, or an array with a
 * non-string in it) would otherwise flow on as a `string[]` and only fail
 * later, inside the verification loop, where it would read as a hashing fault
 * rather than corrupt data. Returns `null` for anything unusable, which the
 * caller treats as a failed attempt.
 */
function parseStoredHashes(secret: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.every((h) => typeof h === "string")) {
    return null;
  }

  return parsed;
}
