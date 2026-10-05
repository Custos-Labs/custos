import type { AuthorizationDecision as DomainAuthorizationDecision } from "../../domain/authorization-decision.js";
import type { PolicyId } from "../../domain/entities/policy.js";
import {
  AttributeContext,
  type AttributeBag,
} from "../../domain/value-objects/attribute-context.js";
import type { AuthorizationDecision } from "../dto/authorization-decision.js";
import type { AuthorizationService } from "../services/authorization-service.js";
import type { ResourceAttributeResolverRegistry } from "../services/resource-attribute-resolver-registry.js";

export interface AuthorizeActionCommand {
  readonly subjectId: string;
  /**
   * The organization the check is being made within.
   *
   * Required because `SubjectRef` is tenant-scoped: the same subject may hold
   * different roles in different organizations, so a decision rendered without
   * a tenant is not answerable. An earlier version of this command omitted it
   * and passed flat primitives to a port that has since become tenant-aware.
   */
  readonly tenantId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly subjectAttributes?: AttributeBag;
  readonly resourceAttributes?: AttributeBag;
  readonly environmentAttributes?: AttributeBag;
}

/**
 * The Policy Decision Point (PDP): the single call site other contexts and
 * route handlers use to ask "can this subject do this action on this
 * resource," wrapping `AuthorizationService` (Issue 152) the way Issue 153
 * specifies. Has no HTTP/Fastify dependency — like every use case, it can be
 * called identically from a route handler, a CLI command, or a test (see
 * `docs/guides/use-cases.md`).
 *
 * When constructed with a `resourceAttributeResolvers` registry (Issue 151),
 * `execute` resolves the resource's own attributes automatically via
 * `resourceId`, so callers don't have to fetch and pass them by hand on
 * every check; `resourceAttributes` on the command can still supply
 * additional attributes, or override a resolved one (e.g. a caller that
 * already has the resource loaded and wants to skip a redundant fetch).
 * Passing no registry (or one with nothing registered for this resource
 * type) simply means no resource attributes are resolved automatically —
 * not an error, since not every check needs any.
 */
export class AuthorizeAction {
  constructor(
    private readonly authorizationService: AuthorizationService,
    private readonly resourceAttributeResolvers?: ResourceAttributeResolverRegistry,
  ) {}

  async execute(command: AuthorizeActionCommand): Promise<AuthorizationDecision> {
    let resolvedResourceAttributes: AttributeBag = {};

    if (this.resourceAttributeResolvers?.has(command.resourceType) === true) {
      try {
        resolvedResourceAttributes = await this.resourceAttributeResolvers.resolve(
          command.resourceType,
          command.resourceId,
        );
      } catch (error) {
        // A resource-attribute resolution failure means the request cannot
        // be evaluated against whatever policies target this resource type
        // — failing open here would silently skip exactly the attributes an
        // ABAC policy might be relying on to deny. Denying is the only safe
        // outcome, and it is reported as a distinct reason (this is the
        // "policy-error path" Issue 153's tests cover) rather than left
        // indistinguishable from an ordinary policy-driven denial.
        return {
          granted: false,
          reason: `Denied: could not resolve "${command.resourceType}" resource attributes (${
            error instanceof Error ? error.message : String(error)
          }).`,
          matchedPolicyIds: [],
          evaluatedAt: new Date(),
        };
      }
    }

    const context = AttributeContext.create({
      subject: { id: command.subjectId, ...command.subjectAttributes },
      resource: {
        id: command.resourceId,
        ...resolvedResourceAttributes,
        ...command.resourceAttributes,
      },
      action: { name: command.action },
      environment: command.environmentAttributes ?? {},
    });

    const result = await this.authorizationService.authorize({
      subject: { subjectId: command.subjectId, tenantId: command.tenantId },
      action: command.action,
      resource: { resourceType: command.resourceType, resourceId: command.resourceId },
      context: context.toBags(),
    });

    return {
      granted: result.effect === "PERMIT",
      reason: AuthorizeAction.describeReason(result),
      // The service reports ids as plain strings; the DTO brands them. They are
      // the ids of policies the evaluator matched, so the brand holds.
      matchedPolicyIds: result.matchedPolicyIds as readonly PolicyId[],
      evaluatedAt: new Date(),
    };
  }

  /**
   * Phrases the decision for a caller.
   *
   * Written as sentences rather than passing the service's own `reason`
   * through: that one is terse and internal ("ABAC policy permit"), and this is
   * the string a route handler surfaces and an audit entry records. The layer
   * that decided is named because "denied" and "denied because nothing matched"
   * send a reader to different places — the first looks like a bug, the second
   * like missing configuration.
   *
   * Driven by `source`, the single layer that produced the returned effect. An
   * earlier version branched on `abacDecision` and `rbacDecision` fields that
   * the decision does not have.
   */
  private static describeReason(result: DomainAuthorizationDecision): string {
    const matched =
      result.matchedPolicyIds.length > 0
        ? ` (matched: ${result.matchedPolicyIds.join(", ")})`
        : "";
    const granted = result.effect === "PERMIT";

    switch (result.source) {
      case "rbac":
        return granted
          ? "Granted: role/permission grant permits this action."
          : "Denied: role/permission grant denies this action.";
      case "abac":
      case "composition":
        if (granted) {
          return result.source === "composition"
            ? `Granted: role grant and policy together permit this action${matched}.`
            : `Granted: an applicable policy permits this action${matched}.`;
        }
        // An empty `matchedPolicyIds` is the difference between "a policy said
        // no" and "nothing said yes". The service reports both as `abac` with a
        // DENY effect -- it reserves `fail-closed` for a layer that failed, not
        // for a layer with no opinion -- so the matched set is what separates
        // them, and the two send a reader somewhere quite different.
        return result.matchedPolicyIds.length > 0
          ? `Denied: an applicable policy denies this action${matched}.`
          : "Denied: no role grant or policy permits this action (fail-closed default).";
      case "fail-closed":
        // Reserved for a layer that could not answer: a malformed request, or an
        // unreachable role store or policy repository. Denying is correct, but it
        // must not read as a deliberate policy decision.
        return `Denied: the authorization layer could not complete the check (${result.reason}).`;
    }
  }

}
