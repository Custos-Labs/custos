import type { MfaMethodRow as PrismaMfaMethodRow } from "@verixa/database";

import { MfaMethod, type MfaMethodId, type UserId } from "../../domain/entities/mfa-method.js";
import { encrypt, decrypt } from "../crypto/encryption.js";

export class MfaMethodMapper {
  static toDomain(row: PrismaMfaMethodRow): MfaMethod {
    const secret = row.secret ? decrypt(row.secret) : null;
    return MfaMethod.load({
      id: row.id as MfaMethodId,
      userId: row.userId as UserId,
      type: row.type,
      status: row.status,
      secret,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Persisted since Issue 100: the lockout and replay state now survives
      // rehydration instead of being reset here.
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil,
      lastUsedStep: row.lastUsedStep,
    });
  }

  static toRow(method: MfaMethod): Omit<PrismaMfaMethodRow, "user"> {
    const secret = method.secret ? encrypt(method.secret) : null;
    return {
      id: method.id,
      userId: method.userId,
      type: method.type,
      status: method.status,
      secret,
      lastUsedAt: method.lastUsedAt,
      createdAt: method.createdAt,
      updatedAt: method.updatedAt,
      failedAttempts: method.failedAttempts,
      lockedUntil: method.lockedUntil,
      lastUsedStep: method.lastUsedStep,
    };
  }
}
