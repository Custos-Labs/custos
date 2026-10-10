import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  toHttpError,
} from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type { AuthorizationRepository } from "../application/authorization-repository.js";
import { AuthorizationError } from "../domain/errors/authorization-error.js";
import { AuthorizationError as LegacyAuthorizationError } from "../domain/authorization.js";

interface RoleParams {
  roleId: string;
}
interface UserParams {
  userId: string;
}
interface RoleQuery {
  organizationId?: string;
}
interface CreateRoleBody {
  name: string;
  description: string;
}
interface UpdateRoleBody {
  name?: string;
  description?: string;
}
interface PermissionBody {
  key: string;
}
interface AssignmentBody {
  roleId: string;
  organizationId?: string;
  expiresAt?: string;
}

function header(
  request: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Translates legacy authorization error codes to shared-kernel domain
 * errors so the admin surface speaks the single error shape.
 */
function toSharedError(error: unknown): unknown {
  if (error instanceof LegacyAuthorizationError) {
    switch (error.code) {
      case "NOT_FOUND":
        return new NotFoundError("The requested authorization record was not found.");
      case "CONFLICT":
        return new ConflictError("The request conflicts with the current authorization state.");
      case "INVALID":
        return new ValidationError("The request was invalid.");
      case "FORBIDDEN":
        return new AuthorizationError("Forbidden.");
    }
  }
  return error;
}

/** Thin adapter: the shared mapping, sent through this route's reply shape. */
function sendRouteError(
  reply: { code: (status: number) => { send: (body: object) => unknown } },
  error: unknown,
): unknown {
  const { status, body } = toHttpError(toSharedError(error));
  return reply.code(status).send(body);
}

/** Registers the complete RBAC management surface. Authentication is supplied
 * by the session layer through x-user-id until the principal plugin lands. */
export function registerAdminAuthorizationRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  authorization: AuthorizationRepository,
): void {
  const requirePermission = async (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (status: number) => { send: (body: object) => unknown } },
    permission: string,
  ): Promise<boolean> => {
    const userId = header(request, "x-user-id");
    if (
      userId === undefined ||
      !(await authorization.hasPermission(
        userId,
        header(request, "x-organization-id") ?? null,
        permission,
      ))
    ) {
      sendRouteError(reply, new AuthorizationError("Forbidden."));
      return false;
    }
    return true;
  };

  app.get("/admin/roles", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:read"))) return;
    return authorization.listRoles();
  });
  app.post<{ Body: CreateRoleBody }>("/admin/roles", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:write"))) return;
    if (request.body.name.trim() === "" || request.body.description.trim() === "") {
      return sendRouteError(reply, new ValidationError("name and description are required"));
    }
    try {
      const role = await authorization.createRole({
        ...request.body,
        isSystemRole: false,
      });
      return reply.code(201).send(role);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  app.patch<{ Params: RoleParams; Body: UpdateRoleBody }>(
    "/admin/roles/:roleId",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.updateRole(request.params.roleId, request.body);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
  app.delete<{ Params: RoleParams }>("/admin/roles/:roleId", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:write"))) return;
    try {
      await authorization.deleteRole(request.params.roleId);
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  app.get("/admin/permissions", async (request, reply) => {
    if (!(await requirePermission(request, reply, "roles:read"))) return;
    return authorization.listPermissions();
  });
  app.post<{ Params: RoleParams; Body: PermissionBody }>(
    "/admin/roles/:roleId/permissions",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.grantPermission(request.params.roleId, request.body.key);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
  app.delete<{ Params: RoleParams; Body: PermissionBody }>(
    "/admin/roles/:roleId/permissions",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        return await authorization.revokePermission(request.params.roleId, request.body.key);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
  app.get<{ Params: UserParams; Querystring: RoleQuery }>(
    "/admin/users/:userId/roles",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:read"))) return;
      const callerOrganizationId = header(request, "x-organization-id");
      if (
        callerOrganizationId === undefined ||
        (request.query.organizationId !== undefined &&
          request.query.organizationId !== callerOrganizationId)
      ) {
        return sendRouteError(reply, new AuthorizationError("Forbidden."));
      }
      return authorization.listAssignments(request.params.userId, callerOrganizationId);
    },
  );
  app.post<{ Params: UserParams; Body: AssignmentBody }>(
    "/admin/users/:userId/roles",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        const actorId = header(request, "x-user-id");
        const callerOrganizationId = header(request, "x-organization-id");
        const organizationId = request.body.organizationId ?? callerOrganizationId;
        if (organizationId === undefined || organizationId !== callerOrganizationId) {
          return sendRouteError(reply, new AuthorizationError("Forbidden."));
        }
        const targetRole = await authorization.getRole(request.body.roleId);
        if (targetRole === undefined) {
          return sendRouteError(reply, new NotFoundError("Role not found"));
        }
        if (actorId === request.params.userId) {
          const canGrant = await Promise.all(
            targetRole.permissions.map((permission) =>
              authorization.hasPermission(
                actorId,
                header(request, "x-organization-id") ?? null,
                permission,
              ),
            ),
          );
          if (!canGrant.every(Boolean)) {
            return sendRouteError(reply, new AuthorizationError("Forbidden."));
          }
        }
        const assignment = await authorization.assignRole({
          userId: request.params.userId,
          roleId: request.body.roleId,
          organizationId,
          assignedBy: header(request, "x-user-id") ?? null,
          expiresAt: request.body.expiresAt === undefined ? null : new Date(request.body.expiresAt),
        });
        return reply.code(201).send(assignment);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
  app.delete<{ Params: { assignmentId: string } }>(
    "/admin/user-role-assignments/:assignmentId",
    async (request, reply) => {
      if (!(await requirePermission(request, reply, "roles:write"))) return;
      try {
        await authorization.revokeAssignment(request.params.assignmentId);
        return reply.code(204).send();
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
}
