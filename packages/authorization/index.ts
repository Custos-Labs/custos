// Curated public surface of @verixa/authorization. Nothing outside this package
// should import from a deep path (`@verixa/authorization/domain/...`,
// `@verixa/authorization/application/...`) — see docs/guides/domain-modeling.md
// ("Package encapsulation") for why, and eslint.config.mjs's
// `no-restricted-imports` rule, which enforces it.

// Rebuilt after a merge interleaved two versions of this file: several export
// statements appeared twice verbatim, and six names were exported from two
// different modules at once, which does not compile. Nothing outside this
// package imported either side of those six, so the duplicates were removed in
// favour of each concept's home module rather than by renaming anything.

export { AUTHORIZATION_PRECEDENCE, AUTHORIZATION_REASONS, UnsafeAuthorizationPrecedenceError, assertAuthorizationPrecedenceIsSafe, resolveAuthorizationPrecedence } from "./domain/authorization-decision.js";
export type { AuthorizationDecision, AuthorizationDecisionSource, AuthorizationEffect, AuthorizationPrecedence, PolicyEffect } from "./domain/authorization-decision.js";
export { emptyAttributeContext } from "./domain/attribute-context.js";
export type { AttributeBag, AttributeContext, AuthorizationRequest, ResourceRef, SubjectRef } from "./domain/attribute-context.js";
export type { PolicyDecisionPoint, PolicyEvaluation } from "./application/ports/policy-decision-point.js";
export type { RoleCheckRequest, RoleDecision, RoleDecisionKind, RolePermissionGate } from "./application/ports/role-permission-gate.js";
export { AuthorizationService } from "./application/services/authorization-service.js";
export type { AuthorizationResult, AuthorizeParams } from "./application/services/authorization-service.js";
export type { PermissionRepository } from "./application/ports/permission-repository.js";
export type { RoleRepository } from "./application/ports/role-repository.js";
export type { FindUserRoleAssignmentsOptions, UserRoleAssignmentRepository } from "./application/ports/user-role-assignment-repository.js";
export { PermissionChecker } from "./application/services/permission-checker.js";
export type { PermissionCheckerOptions } from "./application/services/permission-checker.js";
export { requireAllPermissions, requireAnyPermission, requirePermission } from "./interface/guards/require-permission.js";
export type { AuthenticatedPrincipal, GuardReply, OrgIdResolver, PermissionCheckerLike, RequestWithPrincipal } from "./interface/guards/require-permission.js";
export { createResolvePrincipalHook } from "./interface/hooks/resolve-principal.js";
export type { PermissionResolverLike, ResolvePrincipalOptions } from "./interface/hooks/resolve-principal.js";
export { AssignPermissionToRole } from "./application/use-cases/assign-permission-to-role.js";
export type { AssignPermissionToRoleCommand, AssignPermissionToRoleError } from "./application/use-cases/assign-permission-to-role.js";
export { AssignRoleToUser } from "./application/use-cases/assign-role-to-user.js";
export type { AssignRoleToUserCommand, AssignRoleToUserError } from "./application/use-cases/assign-role-to-user.js";
export { CreateRole } from "./application/use-cases/create-role.js";
export type { CreateRoleCommand, CreateRoleError } from "./application/use-cases/create-role.js";
export { DefinePermission } from "./application/use-cases/define-permission.js";
export type { DefinePermissionCommand, DefinePermissionError } from "./application/use-cases/define-permission.js";
export { RevokePermissionFromRole } from "./application/use-cases/revoke-permission-from-role.js";
export type { RevokePermissionFromRoleCommand, RevokePermissionFromRoleError } from "./application/use-cases/revoke-permission-from-role.js";
export { RevokeRoleFromUser } from "./application/use-cases/revoke-role-from-user.js";
export type { RevokeRoleFromUserCommand, RevokeRoleFromUserError } from "./application/use-cases/revoke-role-from-user.js";
export { Role } from "./domain/entities/role.js";
export type { CreateRoleParams, OrgId, RoleId, RoleProps } from "./domain/entities/role.js";
export { SystemRoleImmutableError } from "./domain/errors/system-role-immutable-error.js";
export type { SystemRoleAction } from "./domain/errors/system-role-immutable-error.js";
export { Permission } from "./domain/value-objects/permission.js";
export { PermissionMatcher } from "./domain/services/permission-matcher.js";
export { InMemoryPermissionRepository } from "./infrastructure/fakes/in-memory-permission-repository.js";
export { InMemoryRoleRepository } from "./infrastructure/fakes/in-memory-role-repository.js";
export { InMemoryUserRoleAssignmentRepository } from "./infrastructure/fakes/in-memory-user-role-assignment-repository.js";
export { permissionRepositoryContract } from "./infrastructure/testing/contracts/permission-repository.contract.js";
export { roleRepositoryContract } from "./infrastructure/testing/contracts/role-repository.contract.js";
export { userRoleAssignmentRepositoryContract } from "./infrastructure/testing/contracts/user-role-assignment-repository.contract.js";
export { UserRoleAssignment } from "./domain/entities/user-role-assignment.js";
export type { CreateUserRoleAssignmentParams, UserId, UserRoleAssignmentId, UserRoleAssignmentProps } from "./domain/entities/user-role-assignment.js";
export type { AttributeBagName, AttributeBags, AttributeCategory, AttributeRecord, AttributeValue, AttributeValueType } from "./domain/value-objects/attribute-context.js";
export { between, evaluateOperator } from "./domain/dsl/operators.js";
export type { ComparisonOperator, OperatorResult } from "./domain/dsl/operators.js";
export type { PolicySimulationEngine, PolicySimulationRun, PolicySource, SimulatedRuleOutcome } from "./application/ports/policy-simulation-engine.js";
export { SimulatePolicy } from "./application/use-cases/simulate-policy.js";
export type { PolicyFixture, PolicyFixtureSet, PolicySimulationReport, SimulationFixtureResult } from "./application/use-cases/simulate-policy.js";
export { POLICY_SIMULATE_EXIT_CODES, POLICY_SIMULATE_USAGE, PolicySimulateCommand, parseArgv, parseFixtureSet, renderJson, renderTable } from "./infrastructure/cli/policy-simulate-command.js";
export type { PolicySimulateFormat, PolicySimulateIo, PolicySimulateOptions } from "./infrastructure/cli/policy-simulate-command.js";
export type { AttributeProviderFailure, AttributeResolutionResult } from "./application/services/attribute-resolution-pipeline.js";
export { Policy } from "./domain/entities/policy.js";
export type { PolicyId, PolicyStatus, PolicyTarget } from "./domain/entities/policy.js";
export { Condition } from "./domain/value-objects/condition.js";
export type { AlwaysCondition, AndCondition, ComparisonCondition, ComparisonLiteral, NotCondition, OrCondition } from "./domain/value-objects/condition.js";
export type { Effect } from "./domain/value-objects/effect.js";
export { Rule } from "./domain/value-objects/rule.js";
export type { PolicyRepository } from "./application/ports/policy-repository.js";
export { InMemoryPolicyRepository } from "./infrastructure/fakes/in-memory-policy-repository.js";
export { PrismaPolicyRepository } from "./infrastructure/persistence/prisma-policy-repository.js";
export type { ResourceAttributeResolver, ResourceAttributeValue, ResourceAttributes } from "./application/ports/resource-attribute-resolver.js";
export { ResourceAttributeResolverRegistry, UnknownResourceTypeError } from "./application/services/resource-attribute-resolver-registry.js";
export { evaluateCondition, evaluateRule } from "./domain/services/policy-evaluation-engine.js";
export { denyOverrides, deriveRuleOutcomes, firstApplicable, permitOverrides } from "./domain/services/combining-algorithms.js";
export type { CombiningAlgorithm, RuleOutcome } from "./domain/services/combining-algorithms.js";
export { NoRbacGrants } from "./application/ports/rbac-authorization.js";
export type { RbacAuthorizationPort, RbacDecision } from "./application/ports/rbac-authorization.js";
export { AuthorizeAction } from "./application/use-cases/authorize-action.js";
export type { AuthorizeActionCommand } from "./application/use-cases/authorize-action.js";
export { AuthorizationError } from "./domain/authorization.js";
export type { PermissionKey, RoleAssignment, RoleRecord } from "./domain/authorization.js";
export type { AuthorizationRepository } from "./application/authorization-repository.js";
export { PrismaAuthorizationRepository } from "./infrastructure/prisma-authorization-repository.js";
export { DEFAULT_PERMISSIONS, DEFAULT_ROLES, seedDefaultRoles } from "./infrastructure/seed/seed-default-roles.js";
export { registerAdminAuthorizationRoutes } from "./interface/admin-roles.routes.js";
