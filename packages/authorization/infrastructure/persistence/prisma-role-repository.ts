import type { PrismaClient } from "@verixa/database";
import { Result } from "@verixa/shared-kernel";

import type { RoleRepository } from "../../application/ports/role-repository.js";
import { Role, type RoleId } from "../../domain/entities/role.js";
import { SystemRoleImmutableError } from "../../domain/errors/system-role-immutable-error.js";

import { mapPrismaError } from "./error-mapper.js";

/**
 * The shape every read here selects: the role's own columns plus the keys of
 * the permissions joined to it.
 *
 * `role_permissions` is an *explicit* join model (`@@id([roleId, permissionId])`),
 * not an implicit many-to-many, so a row of it carries only the two ids — the
 * key lives one hop further on, through `permission`. An earlier version of this
 * adapter read `record.permissions[n].key` directly and wrote
 * `permissions: { connect: [{ key }] }`, both of which only typecheck against an
 * implicit relation.
 */
const ROLE_WITH_PERMISSIONS = {
  permissions: { include: { permission: { select: { key: true } } } },
} as const;

interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystemRole: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly permissions: readonly { readonly permission: { readonly key: string } }[];
}

/** Rebuilds the aggregate from a row. Storage is trusted, so validation is skipped. */
function toDomain(row: RoleRow): Role {
  return Role.reconstitute({
    id: row.id as RoleId,
    name: row.name,
    description: row.description ?? undefined,
    isSystemRole: row.isSystemRole,
    permissions: new Set(row.permissions.map((p) => p.permission.key)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upserts the role and makes its permission set match the aggregate exactly.
   *
   * The join rows are replaced rather than merged: the aggregate is the single
   * source of truth for which permissions a role holds, so a permission revoked
   * in the domain has to disappear here. `deleteMany` then `createMany` runs
   * inside one transaction, because a role observed between the two would appear
   * to hold no permissions at all — and this is the table an authorization check
   * reads.
   *
   * A permission key with no row in `permissions` is skipped rather than
   * created. The permission catalogue is seeded, and inventing rows here would
   * let a typo in a policy silently become a real permission.
   */
  async save(role: Role): Promise<void> {
    try {
      const keys = Array.from(role.permissions);

      await this.prisma.$transaction(async (tx) => {
        await tx.role.upsert({
          where: { id: role.id },
          create: {
            id: role.id,
            name: role.name,
            description: role.description ?? null,
            isSystemRole: role.isSystemRole,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
          },
          update: {
            name: role.name,
            description: role.description ?? null,
            isSystemRole: role.isSystemRole,
            updatedAt: role.updatedAt,
          },
        });

        const known =
          keys.length === 0
            ? []
            : await tx.permission.findMany({
                where: { key: { in: keys } },
                select: { id: true },
              });

        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        if (known.length > 0) {
          await tx.rolePermission.createMany({
            data: known.map((p) => ({ roleId: role.id, permissionId: p.id })),
          });
        }
      });
    } catch (error) {
      throw mapPrismaError(error, "Role");
    }
  }

  async findById(id: RoleId): Promise<Role | undefined> {
    try {
      const row = await this.prisma.role.findUnique({
        where: { id },
        include: ROLE_WITH_PERMISSIONS,
      });
      return row === null ? undefined : toDomain(row);
    } catch (error) {
      throw mapPrismaError(error, "Role");
    }
  }

  /** Names are unique across the deployment: roles are global, not per-tenant. */
  async findByName(name: string): Promise<Role | undefined> {
    try {
      const row = await this.prisma.role.findUnique({
        where: { name },
        include: ROLE_WITH_PERMISSIONS,
      });
      return row === null ? undefined : toDomain(row);
    } catch (error) {
      throw mapPrismaError(error, "Role");
    }
  }

  async findAll(): Promise<Role[]> {
    try {
      const rows = await this.prisma.role.findMany({
        orderBy: { name: "asc" },
        include: ROLE_WITH_PERMISSIONS,
      });
      return rows.map(toDomain);
    } catch (error) {
      throw mapPrismaError(error, "Role");
    }
  }

  /**
   * Deletes a role, refusing a system role.
   *
   * The refusal is checked here rather than left to the database: a system role
   * is what a locked-out operator recovers through, and losing one is not
   * something a later migration can undo. Deleting a role that does not exist
   * is a silent no-op, so a retried delete does not fail.
   */
  async delete(id: RoleId): Promise<void> {
    try {
      const existing = await this.prisma.role.findUnique({
        where: { id },
        select: { name: true, isSystemRole: true },
      });
      if (existing === null) return;

      if (existing.isSystemRole) {
        throw new SystemRoleImmutableError(id, existing.name, "delete");
      }

      await this.prisma.role.delete({ where: { id } });
    } catch (error) {
      if (error instanceof SystemRoleImmutableError) throw error;
      throw mapPrismaError(error, "Role");
    }
  }
}
