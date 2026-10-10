import { AccountLockedError, Result } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import type { Container } from "../composition-root.js";
import { sendDomainError, sendError } from "../http/error-response.js";

/**
 * JSON Schema for the registration body.
 *
 * Validates **shape only** — types and presence. Rules like "at least 12
 * characters" are deliberately absent, even though Fastify supports
 * `minLength`, because the password policy lives in `RawPassword` and
 * duplicating it here would create two sources of truth that drift: someone
 * raises the minimum in the domain, the schema still accepts 8, and the
 * mismatch surfaces as a confusing 400 that names a rule nobody can find.
 *
 * The split: schema rejects requests that are malformed. The domain rejects
 * requests that are well-formed and wrong.
 */
const registerBodySchema = {
  type: "object",
  required: ["email", "displayName", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string" },
    displayName: { type: "string" },
    password: { type: "string" },
    givenName: { type: "string" },
    familyName: { type: "string" },
  },
} as const;

interface RegisterBody {
  email: string;
  displayName: string;
  password: string;
  givenName?: string;
  familyName?: string;
}

/**
 * JSON Schema for the login body.
 *
 * Shape only, and noticeably thinner than registration's — no `minLength` on
 * the password, no format check on the email. That is the same rule applied
 * for a sharper reason: on this endpoint, a 400 saying "email must be a valid
 * email" tells an attacker their input never reached the credential lookup,
 * which is one more bit than a failed login should give away. Malformed
 * addresses are rejected by the use case, as failed logins, indistinguishable
 * from every other kind.
 */
const loginBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string" },
    password: { type: "string" },
  },
} as const;

interface LoginBody {
  email: string;
  password: string;
}

/**
 * Authentication routes.
 *
 * Handlers here do one thing: translate HTTP to a use case and back. No
 * business logic, no repository access, no knowledge of Prisma. That is what
 * keeps the use cases testable without an HTTP server, and it is the pattern
 * every route added later should copy.
 *
 * Generic over the logger type for the same reason `buildApp` does not
 * annotate its return as a plain `FastifyInstance`: the app is built with a
 * concrete pino `Logger`, which is not structurally identical to Fastify's
 * own `FastifyBaseLogger` (Fastify's does not require `msgPrefix`). Pinning
 * the default here would reject the very instance `buildApp` produces.
 */
export function registerAuthRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  container: Container,
): void {
  app.post<{ Body: RegisterBody }>(
    "/auth/register",
    { schema: { body: registerBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.registerUserWithPassword.execute({
          email: request.body.email,
          displayName: request.body.displayName,
          password: request.body.password,
          ...(request.body.givenName === undefined ? {} : { givenName: request.body.givenName }),
          ...(request.body.familyName === undefined ? {} : { familyName: request.body.familyName }),
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        // Responds with the user, never the credential. The hash is redacted
        // from serialization anyway (see Credential.toJSON), but the right
        // answer is not to put it in the response object at all — belt and
        // braces, because a future refactor could change either one.
        const { user } = result.value;

        // Audited at the boundary, after the use case succeeded. Deliberately
        // not awaited into the response path's error handling: `RecordAuditEvent`
        // never throws, because a failed audit write must not turn a successful
        // registration into an error the user sees.
        await container.audit.recordEvent.execute({
          action: "user.registered",
          subjectId: user.id,
          metadata: { email: user.email.value },
        });

        await reply.status(201).send({
          id: user.id,
          email: user.email.value,
          displayName: user.displayName.value,
          status: user.status,
          createdAt: user.createdAt.toISOString(),
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.authenticateWithPassword.execute({
          email: request.body.email,
          password: request.body.password,
        });

        if (Result.isErr(result)) {
          // The audit log records *which* failure, unlike the response.
          //
          // This is the payoff of `AccountLockedError` being a distinct type
          // while rendering identically on the wire: the client learns
          // nothing, and the operator can still distinguish a lockout from an
          // ordinary bad password. Collapsing them would have made a
          // credential-stuffing campaign indistinguishable from user error in
          // the one place that needs to tell them apart.
          await container.audit.recordEvent.execute({
            action:
              result.error instanceof AccountLockedError ? "user.locked_out" : "user.login_failed",
            metadata: { email: request.body.email },
          });

          // Routed through the same helper as every other domain error, so the
          // 401 and its body shape come from the error itself. A hand-written
          // `reply.status(401)` here would be a second place where the
          // authentication response is defined, and the one that drifts.
          sendDomainError(reply, result.error);
          return;
        }

        if (result.value.status === "mfa_challenge") {
          await reply.status(202).send({
            status: "mfa_challenge",
            userId: result.value.userId,
            methods: result.value.methods,
          });
          return;
        }

        if (result.value.status === "enrollment_required") {
          await reply.status(202).send({
            status: "enrollment_required",
            userId: result.value.userId,
          });
          return;
        }

        // No session or token yet — that is Phase 05. Until then this returns
        // the authenticated user and nothing else, which is deliberately not
        // enough to stay logged in with. Returning a placeholder token would
        // be worse than returning none: clients would store it, and replacing
        // it later would be a breaking change to a field that never worked.
        const { user } = result.value;

        await container.audit.recordEvent.execute({
          action: "user.login_succeeded",
          actorId: user.id,
          subjectId: user.id,
        });

        await reply.status(200).send({
          id: user.id,
          email: user.email.value,
          displayName: user.displayName.value,
          status: user.status,
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );
}
