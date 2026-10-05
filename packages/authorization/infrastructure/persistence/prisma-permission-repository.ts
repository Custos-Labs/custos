import type { PrismaClient } from "@verixa/database";
import { createId, Result } from "@verixa/shared-kernel";

import type { PermissionRepository } from "../../application/ports/permission-repository.js";
import { Permission } from "../../domain/value-objects/permission.js";

import { mapPrismaError } from "./error-mapper.js";

export class PrismaPermissionRepository implements PermissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upserts a permission by its key.
   *
   * Only `key` is stored. `resource` and `action` are derived from it by the
   * value object, and the `permissions` table has no columns for them — an
   * earlier version of this adapter wrote both and so could not compile. Storing
   * them would also let the two drift from the key that authorization checks
   * actually compare.
   *
   * `id` is supplied on create because the column has no database default, and
   * left alone on update: the row's identity is its key, and re-seeding the
   * catalogue must not renumber rows that `role_permissions` points at.
   */
  async save(permission: Permission): Promise<void> {
    try {
      await this.prisma.permission.upsert({
        where: { key: permission.key },
        create: {
          id: createId<"PermissionId">(),
          key: permission.key,
          createdAt: new Date(),
        },
        update: {},
      });
    } catch (error) {
      return mapPrismaError(error, "Permission");
    }
  }

  async findByKey(key: string): Promise<Permission | undefined> {
    try {
      const row = await this.prisma.permission.findUnique({ where: { key } });
      if (row === null) return undefined;

      const parsed = Permission.create(row.key);
      return Result.isOk(parsed) ? parsed.value : undefined;
    } catch (error) {
      return mapPrismaError(error, "Permission");
    }
  }

  /**
   * Every permission in the catalogue.
   *
   * A row whose key no longer parses is skipped rather than thrown on: the
   * catalogue is seeded data, and one malformed row should not make the whole
   * permission list unreadable — which, for this table, would fail every
   * authorization check that needs to resolve a key.
   */
  async findAll(): Promise<Permission[]> {
    try {
      const rows = await this.prisma.permission.findMany({ orderBy: { key: "asc" } });

      const permissions: Permission[] = [];
      for (const row of rows) {
        const parsed = Permission.create(row.key);
        if (Result.isOk(parsed)) permissions.push(parsed.value);
      }
      return permissions;
    } catch (error) {
      return mapPrismaError(error, "Permission");
    }
  }
}
