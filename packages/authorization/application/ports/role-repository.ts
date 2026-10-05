import type { Role, RoleId } from "../../domain/entities/role.js";

/**
 * The persistence contract for `Role` — the **port** half of ports & adapters
 * (hexagonal architecture). No Prisma, SQL, or database implementation details appear here;
 * concrete adapters implement this interface without the domain or application layers
 * ever depending on infrastructure. See `docs/guides/domain-modeling.md`.
 *
 * ## Method Contracts
 *
 * - `findById(id: RoleId)`:
 *   Returns the matching `Role`, or `undefined` when no role exists with the given id.
 *   Missing role is an expected outcome (e.g. looking up a referenced role), not an
 *   exceptional error condition.
 *
 * - `findByName(name: string)`:
 *   Finds a role by its name, which is unique across the deployment. Roles are
 *   global -- an administrative concern, not a tenant one -- so there is no
 *   scope argument; see `model Role` in the Prisma schema, where `name` is
 *   `@unique` and there is no `organization_id`. Returns `undefined` when no
 *   role has that name.
 *
 * - `findAll()`:
 *   Returns every role the deployment defines. Replaces an earlier
 *   `findAllForOrg(orgId)`, which could not be implemented against a `roles`
 *   table that has no organization column.
 *
 * - `save(role: Role)`:
 *   Idempotent upsert: persists whatever `Role` aggregate state it is given, whether
 *   the role is newly created or previously existed. Callers do not distinguish "create"
 *   from "update" — the aggregate's own state is the single source of truth.
 *
 * - `delete(id: RoleId)`:
 *   Removes the specified role from persistence.
 *   - If the role does not exist: completes silently as an idempotent no-op.
 *   - If the role is a protected system role (`isSystemRole: true`): implementations
 *     MUST throw {@link SystemRoleImmutableError} with `attemptedAction: "delete"`
 *     to prevent accidental destruction of system recoverability roles.
 */
export interface RoleRepository {
  findById(id: RoleId): Promise<Role | undefined>;
  findByName(name: string): Promise<Role | undefined>;
  findAll(): Promise<Role[]>;
  save(role: Role): Promise<void>;
  delete(id: RoleId): Promise<void>;
}
