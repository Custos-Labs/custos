import { createId, type Id, Result, ValidationError } from "@verixa/shared-kernel";

import { SystemRoleImmutableError } from "../errors/system-role-immutable-error.js";
import { Permission } from "../value-objects/permission.js";

/**
 * An organization id.
 *
 * Exported from here because `UserRoleAssignment` is org-scoped and takes one.
 * A `Role` deliberately is not: roles and permissions are global, because the
 * set of roles a deployment supports is an administrative concern rather than a
 * tenant one, and what varies per organization is *who holds* a role. That is
 * stated in `packages/database/prisma/schema.prisma` above `model Role`, and
 * the `roles` table has no `organization_id` column as a result. An earlier
 * version of this entity carried an `orgId` with `createScoped`/`isGlobal`,
 * which the database was never going to support -- it is why this package's
 * Prisma adapters stopped compiling. Tenancy lives on the assignment.
 */
export type OrgId = Id<"OrganizationId">;
export type RoleId = Id<"RoleId">;

/**
 * Persistence shape for a role, as read from Prisma or an in-memory repository.
 * (Moved from the retired domain/authorization.ts legacy module.)
 */
export interface RoleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly isSystemRole: boolean;
  readonly permissions: readonly string[];
}

export interface RoleProps {
  readonly id: RoleId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly isSystemRole: boolean;
  readonly permissions: ReadonlySet<string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateRoleParams {
  readonly id?: RoleId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly isSystemRole?: boolean;
  readonly permissions?: Iterable<Permission | string>;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/**
 * Role aggregate root.
 *
 * Represents a named, reusable bundle of permissions that can be assigned to users.
 * Owns the invariant that a role's permission set can only change through its own methods
 * (`grant`, `revoke`), never by external mutation.
 *
 * ## System-Role Invariants (Issue 123)
 * Roles flagged with `isSystemRole: true` represent protected, built-in roles (e.g. `super-admin`)
 * essential for system recoverability. They enforce strict domain-level immutability:
 * - Revoking any permission throws {@link SystemRoleImmutableError}.
 * - Renaming the role throws {@link SystemRoleImmutableError}.
 * - Granting additional permissions is still permitted.
 */
export class Role {
  readonly id: RoleId;
  private _name: string;
  private _description: string | undefined;
  readonly isSystemRole: boolean;
  private readonly _permissions: Set<string>;
  readonly createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: {
    id: RoleId;
    name: string;
    description?: string | undefined;
    isSystemRole: boolean;
    permissions: Set<string>;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this._name = props.name;
    this._description = props.description;
    this.isSystemRole = props.isSystemRole;
    this._permissions = props.permissions;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  get name(): string {
    return this._name;
  }

  get description(): string | undefined {
    return this._description;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Returns an unmodifiable read-only view of the permissions granted to this role.
   * Direct mutations of the returned Set are prevented.
   */
  get permissions(): ReadonlySet<string> {
    return new Set(this._permissions);
  }

  /**
   * Creates a new `Role` entity after validating initial parameters.
   */
  static create(params: CreateRoleParams): Result<Role, ValidationError> {
    if (typeof params.name !== "string" || params.name.trim().length === 0) {
      return Result.err(
        new ValidationError("Role name is required and must not be empty.", {
          name: ["required"],
        }),
      );
    }

    const trimmedName = params.name.trim();
    const id = params.id ?? createId<"RoleId">();
    const now = new Date();
    const createdAt = params.createdAt ?? now;
    const updatedAt = params.updatedAt ?? now;
    const isSystemRole = params.isSystemRole ?? false;

    const initialPermissions = new Set<string>();
    if (params.permissions) {
      for (const p of params.permissions) {
        const perm = typeof p === "string" ? Permission.from(p) : p;
        initialPermissions.add(perm.value);
      }
    }

    return Result.ok(
      new Role({
        id,
        name: trimmedName,
        description: params.description?.trim(),
        isSystemRole,
        permissions: initialPermissions,
        createdAt,
        updatedAt,
      }),
    );
  }

  /**
   * Convenience factory to create a protected system role (`isSystemRole: true`).
   */
  static createSystemRole(
    params: Omit<CreateRoleParams, "isSystemRole">,
  ): Result<Role, ValidationError> {
    return Role.create({ ...params, isSystemRole: true });
  }

  /**
   * Reconstitutes an already-persisted Role from trusted storage.
   * Skips domain validation by design.
   */
  static reconstitute(props: RoleProps): Role {
    return new Role({
      id: props.id,
      name: props.name,
      description: props.description,
      isSystemRole: props.isSystemRole,
      permissions: new Set(props.permissions),
      createdAt: props.createdAt,
      updatedAt: props.updatedAt,
    });
  }

  /**
   * Grants a permission to this role.
   *
   * Granting permissions is allowed on all roles, including system roles,
   * to accommodate system expansion without compromising base recoverability.
   */
  grant(permission: Permission | string): void {
    const perm = typeof permission === "string" ? Permission.from(permission) : permission;
    if (!this._permissions.has(perm.value)) {
      this._permissions.add(perm.value);
      this._updatedAt = new Date();
    }
  }

  /**
   * Revokes a permission from this role.
   *
   * @throws {@link SystemRoleImmutableError} if this role is a protected system role (`isSystemRole === true`).
   */
  revoke(permission: Permission | string): void {
    if (this.isSystemRole) {
      throw new SystemRoleImmutableError(this.id, this._name, "revoke");
    }

    const perm = typeof permission === "string" ? Permission.from(permission) : permission;
    if (this._permissions.has(perm.value)) {
      this._permissions.delete(perm.value);
      this._updatedAt = new Date();
    }
  }

  /**
   * Renames this role.
   *
   * @throws {@link SystemRoleImmutableError} if this role is a protected system role (`isSystemRole === true`).
   * @throws {@link ValidationError} if the new name is empty or invalid.
   */
  rename(newName: string): void {
    if (this.isSystemRole) {
      throw new SystemRoleImmutableError(this.id, this._name, "rename");
    }

    if (typeof newName !== "string" || newName.trim().length === 0) {
      throw new ValidationError("Role name is required and cannot be empty.", {
        name: ["required"],
      });
    }

    const trimmed = newName.trim();
    if (this._name !== trimmed) {
      this._name = trimmed;
      this._updatedAt = new Date();
    }
  }

  /**
   * Updates the role's description. Allowed on system roles as well as standard roles.
   */
  updateDescription(description: string | undefined): void {
    this._description = description?.trim();
    this._updatedAt = new Date();
  }

  /**
   * Checks whether this role has the specified permission.
   * Also supports wildcard matching (e.g. `users:*` satisfies `users:read`).
   */
  hasPermission(permission: Permission | string): boolean {
    const required = typeof permission === "string" ? Permission.from(permission) : permission;

    if (this._permissions.has(required.value)) {
      return true;
    }

    // Check wildcard permission (e.g. "users:*")
    const wildcard = `${required.resource}:*`;
    if (this._permissions.has(wildcard)) {
      return true;
    }

    return false;
  }
}
