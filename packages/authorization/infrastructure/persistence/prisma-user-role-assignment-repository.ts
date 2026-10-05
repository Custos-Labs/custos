import type { PrismaClient } from "@verixa/database";

import type {
  FindUserRoleAssignmentsOptions,
  UserRoleAssignmentRepository,
} from "../../application/ports/user-role-assignment-repository.js";
import type { RoleId } from "../../domain/entities/role.js";
import {
  UserRoleAssignment,
  type OrgId,
  type UserId,
  type UserRoleAssignmentId,
} from "../../domain/entities/user-role-assignment.js";

import { mapPrismaError } from "./error-mapper.js";

interface AssignmentRow {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly organizationId: string;
  readonly assignedAt: Date;
  readonly assignedBy: string | null;
  readonly expiresAt: Date | null;
}

/**
 * Rebuilds the aggregate from a row.
 *
 * `reconstitute`, not `create`: storage is trusted and already validated, and
 * `create` returns a `Result` that an adapter has no sensible way to fail on —
 * a row that will not validate is a corrupt database, not a bad request.
 *
 * `assigned_by` is nullable in the database but required on the aggregate. A row
 * without it predates that column, so the assignment is attributed to the user
 * it was granted to rather than invented: that is visibly odd in an audit view,
 * which is better than a confident wrong name.
 */
function toDomain(row: AssignmentRow): UserRoleAssignment {
  return UserRoleAssignment.reconstitute({
    id: row.id as UserRoleAssignmentId,
    userId: row.userId as UserId,
    roleId: row.roleId as RoleId,
    orgId: row.organizationId as OrgId,
    assignedAt: row.assignedAt,
    assignedBy: (row.assignedBy ?? row.userId) as UserId,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
  });
}

/** `expiresAt: null` means "never expires", so it is never filtered out. */
function expiryFilter(options?: FindUserRoleAssignmentsOptions) {
  if (options?.includeExpired === true) return {};
  const now = options?.now ?? new Date();
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export class PrismaUserRoleAssignmentRepository implements UserRoleAssignmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persists an assignment.
   *
   * A global assignment (`orgId: null`) is refused rather than coerced. The
   * `user_role_assignments.organization_id` column is `NOT NULL` with a foreign
   * key to `organizations`, and the table's row-level security policy is keyed on
   * it — so a row with no organization would not just fail to store, it would be
   * a hole in the tenancy boundary if the column were ever made nullable. The
   * aggregate still models the case; this is the layer that cannot.
   */
  async save(assignment: UserRoleAssignment): Promise<void> {
    if (assignment.orgId === null) {
      throw new Error(
        "A role assignment with no organization cannot be stored: " +
          "user_role_assignments.organization_id is NOT NULL and its row-level " +
          "security policy is keyed on it. Assign the role within an organization.",
      );
    }

    const row = {
      userId: assignment.userId,
      roleId: assignment.roleId,
      organizationId: assignment.orgId,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
      expiresAt: assignment.expiresAt ?? null,
    };

    try {
      await this.prisma.userRoleAssignment.upsert({
        where: { id: assignment.id },
        create: { id: assignment.id, ...row },
        update: row,
      });
    } catch (error) {
      return mapPrismaError(error, "UserRoleAssignment");
    }
  }

  async findById(id: UserRoleAssignmentId): Promise<UserRoleAssignment | undefined> {
    try {
      const row = await this.prisma.userRoleAssignment.findUnique({ where: { id } });
      return row === null ? undefined : toDomain(row);
    } catch (error) {
      return mapPrismaError(error, "UserRoleAssignment");
    }
  }

  async findByUser(
    userId: UserId,
    options?: FindUserRoleAssignmentsOptions,
  ): Promise<UserRoleAssignment[]> {
    try {
      const rows = await this.prisma.userRoleAssignment.findMany({
        where: { userId, ...expiryFilter(options) },
        orderBy: { assignedAt: "asc" },
      });
      return rows.map(toDomain);
    } catch (error) {
      return mapPrismaError(error, "UserRoleAssignment");
    }
  }

  /**
   * An `orgId` of `null` returns nothing rather than every row.
   *
   * No stored assignment can have a null organization (see `save`), so the honest
   * answer is the empty set. Dropping the predicate instead would turn a query
   * scoped to one tenant into one that reads them all, which is the worst
   * possible failure mode for this particular table.
   */
  async findByUserAndOrg(
    userId: UserId,
    orgId: OrgId | null,
    options?: FindUserRoleAssignmentsOptions,
  ): Promise<UserRoleAssignment[]> {
    if (orgId === null) return [];

    try {
      const rows = await this.prisma.userRoleAssignment.findMany({
        where: { userId, organizationId: orgId, ...expiryFilter(options) },
        orderBy: { assignedAt: "asc" },
      });
      return rows.map(toDomain);
    } catch (error) {
      return mapPrismaError(error, "UserRoleAssignment");
    }
  }

  /** Idempotent: revoking an assignment that is already gone is a no-op. */
  async revoke(id: UserRoleAssignmentId): Promise<void> {
    try {
      await this.prisma.userRoleAssignment.deleteMany({ where: { id } });
    } catch (error) {
      return mapPrismaError(error, "UserRoleAssignment");
    }
  }
}
