import type { Id } from "@verixa/shared-kernel";
import type { MfaMethod, MfaMethodId } from "../../domain/entities/mfa-method.js";

/**
 * Port for accessing and persisting \MfaMethod\ aggregates.
 * 
 * Implementations must handle encryption-at-rest for the TOTP secret 
 * transparently ? it must never be saved in plaintext. The domain remains 
 * ignorant of this storage-level concern.
 */
export interface MfaMethodRepository {
  /**
   * Idempotently saves the \MfaMethod\. 
   * Updates an existing record or creates a new one.
   */
  save(method: MfaMethod): Promise<void>;

  /**
   * Retrieves an \MfaMethod\ by its ID.
   * Returns \undefined\ if no method exists for the given ID.
   */
  findById(id: MfaMethodId): Promise<MfaMethod | undefined>;

  /**
   * Retrieves all \ctive\ MFA methods for the specified user.
   * Excludes methods in \pending\ or \disabled\ states.
   */
  findActiveByUserId(userId: Id<"UserId">): Promise<MfaMethod[]>;

  /**
   * Retrieves all \pending\ MFA methods for the specified user.
   * Used to find methods awaiting confirmation (e.g. initial TOTP setup).
   */
  findPendingByUserId(userId: Id<"UserId">): Promise<MfaMethod[]>;

  /**
   * Physically deletes the \MfaMethod\ from persistence.
   * Unlike User accounts, incomplete/abandoned MFA enrollments can be hard-deleted.
   */
import type { MfaMethod, MfaMethodId, UserId } from "../../domain/entities/mfa-method.js";

export interface MfaMethodRepository {
  save(method: MfaMethod): Promise<void>;
  findById(id: MfaMethodId): Promise<MfaMethod | undefined>;
  findActiveByUserId(userId: UserId): Promise<MfaMethod[]>;
  findPendingByUserId(userId: UserId): Promise<MfaMethod[]>;
  delete(id: MfaMethodId): Promise<void>;
}
