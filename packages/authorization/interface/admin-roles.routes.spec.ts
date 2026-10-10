import Fastify from "fastify";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { AuthorizationRepository } from "../application/authorization-repository.js";
import { SystemRoleImmutableError } from "../domain/errors/system-role-immutable-error.js";

import { registerAdminAuthorizationRoutes } from "./admin-roles.routes.js";

describe("admin-roles.routes", () => {
  it("returns 403 with domain error code when deleting a system role", async () => {
    const mockRepo: Partial<AuthorizationRepository> = {
      hasPermission: vi.fn().mockResolvedValue(true),
      deleteRole: vi
        .fn()
        .mockRejectedValue(
          new SystemRoleImmutableError("role_super_admin", "super-admin", "delete"),
        ),
    };

    const app = Fastify();
    registerAdminAuthorizationRoutes(app, mockRepo as AuthorizationRepository);
    await app.ready();

    const response = await supertest(app.server)
      .delete("/admin/roles/role_super_admin")
      .set("x-user-id", "admin_user");

    // Acceptance criteria:
    // 1. Deleting a system role produces a SystemRoleImmutableError with attemptedAction: "delete"
    // 2. The response for that case is 403 with the domain error's code.
    expect(response.status).toBe(403);
    const body = response.body as {
      code: string;
      error: string;
      attemptedAction: string;
    };
    expect(body.code).toBe("SYSTEM_ROLE_IMMUTABLE");
    expect(body.attemptedAction).toBe("delete");
    expect(body.error).toContain('Cannot delete system role "super-admin"');

    await app.close();
  });
});
