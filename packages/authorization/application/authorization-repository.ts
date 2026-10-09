import type { RoleRecord } from "../domain/entities/role.js";

/**
 * Read-model for a role-assignment row returned by this port.
 * (Verbatim shape of the retired legacy interface.)
 */
export interface RoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  organizationId: string;
  assignedAt: Date;
  assignedBy: string | null;
  expiresAt: Date | null;
}

export interface AuthorizationRepository {
  listRoles(): Promise<RoleRecord[]>;
  getRole(id: string): Promise<RoleRecord | undefined>;
  createRole(input: Omit<RoleRecord, "id" | "permissions">): Promise<RoleRecord>;
  updateRole(id: string, input: { name?: string; description?: string }): Promise<RoleRecord>;
  deleteRole(id: string): Promise<void>;
  listPermissions(): Promise<{ id: string; key: string; description: string }[]>;
  grantPermission(roleId: string, key: string): Promise<RoleRecord>;
  revokePermission(roleId: string, key: string): Promise<RoleRecord>;
  listAssignments(userId: string, organizationId?: string): Promise<RoleAssignment[]>;
  assignRole(input: Omit<RoleAssignment, "id" | "assignedAt">): Promise<RoleAssignment>;
  revokeAssignment(id: string): Promise<void>;
  hasPermission(userId: string, organizationId: string | null, key: string): Promise<boolean>;
}
