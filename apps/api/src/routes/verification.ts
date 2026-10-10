import { AuthorizationError, ValidationError } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";

import { sendError } from "../http/error-response.js";

const submitVerificationSchema = {
  schema: {
    description: "Submit a new verification request",
    tags: ["Verification"],
    body: {
      type: "object",
      required: ["subjectUserId", "orgId", "verificationType"],
      additionalProperties: false,
      properties: {
        subjectUserId: { type: "string" },
        orgId: { type: "string" },
        verificationType: { type: "string" },
      },
    },
    response: {
      201: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
};

const submitEvidenceSchema = {
  schema: {
    description: "Submit evidence for a verification request",
    tags: ["Verification"],
    params: {
      type: "object",
      required: ["requestId"],
      properties: {
        requestId: { type: "string" },
      },
    },
    response: {
      201: {
        type: "object",
        properties: {
          evidenceId: { type: "string" },
        },
      },
    },
  },
};

const getStatusSchema = {
  schema: {
    description: "Get verification request status",
    tags: ["Verification"],
    params: {
      type: "object",
      required: ["requestId"],
      properties: {
        requestId: { type: "string" },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
};

const reviewQueueSchema = {
  schema: {
    description: "List review queue (reviewer only)",
    tags: ["Review Queue"],
    response: {
      200: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  },
};

const claimCaseSchema = {
  schema: {
    description: "Claim next review case (reviewer only)",
    tags: ["Review Queue"],
    response: {
      200: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
};

const decisionSchema = {
  schema: {
    description: "Review decision: approve, reject, or request-more-info (reviewer only)",
    tags: ["Review Queue"],
    params: {
      type: "object",
      required: ["requestId"],
      properties: {
        requestId: { type: "string" },
      },
    },
    body: {
      type: "object",
      required: ["decision"],
      additionalProperties: false,
      properties: {
        decision: { type: "string", enum: ["approve", "reject", "request-more-info"] },
        reason: { type: "string" },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
};

function checkReviewer(req: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.includes("reviewer")) {
    sendError(reply, new AuthorizationError("Reviewer role required"));
    return false;
  }
  return true;
}

/**
 * Generic over the logger for the same reason `registerAuthRoutes` is: the
 * app is built with a concrete pino `Logger`, which is not structurally
 * identical to Fastify's `FastifyBaseLogger`, so pinning the default here
 * rejects the very instance `buildApp` produces.
 */
export function registerVerificationRoutes<TLogger extends FastifyBaseLogger>(
  fastify: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  fastify.post("/verification", submitVerificationSchema, async (req, reply) => {
    const body = z
      .object({
        subjectUserId: z.string(),
        orgId: z.string(),
        verificationType: z.string(),
      })
      .parse(req.body);

    return reply.status(201).send({
      requestId: "req_mock_123",
      status: "pending_evidence",
      ...body,
    });
  });

  fastify.post("/verification/:requestId/evidence", submitEvidenceSchema, async (req, reply) => {
    const params = z.object({ requestId: z.string() }).parse(req.params);
    // `@fastify/multipart` augments the request with `file()`, but the
    // plugin is not registered yet, so the method may genuinely be absent.
    // Typed narrowly rather than cast to `any`: the shape actually relied on
    // is one optional method returning an optional stream.
    const multipart = req as FastifyRequest & {
      file?: () => { filename?: string; file?: NodeJS.ReadableStream } | undefined;
    };
    const data = multipart.file?.();

    try {
      if (data?.file) {
        await assertStreamWithinLimit(data.file, MAX_EVIDENCE_BYTES);
      }
    } catch (error) {
      if (!(error instanceof EvidenceTooLargeError)) throw error;
      return (reply as FastifyReply).status(400).send({
        error: {
          code: "INVALID_EVIDENCE",
          message: "File size exceeds limit",
        },
      });
    const size = data?.file ? await getStreamSize(data.file) : 1024;

    if (size > 10 * 1024 * 1024) {
      sendError(reply, new ValidationError("File size exceeds limit"));
      return;
    }

    return reply.status(201).send({
      evidenceId: "ev_mock_123",
      requestId: params.requestId,
    });
  });

  fastify.get("/verification/:requestId", getStatusSchema, async (req, reply) => {
    const params = z.object({ requestId: z.string() }).parse(req.params);
    return reply.send({
      requestId: params.requestId,
      status: "pending_evidence",
    });
  });

  fastify.get("/verification/review-queue", reviewQueueSchema, async (req, reply) => {
    if (!checkReviewer(req, reply)) return;
    return reply.send([]);
  });

  fastify.post("/verification/review-queue/claim", claimCaseSchema, async (req, reply) => {
    if (!checkReviewer(req, reply)) return;
    return reply.send({
      requestId: "req_claimed_123",
      status: "in_review",
    });
  });

  fastify.post(
    "/verification/review-queue/:requestId/decision",
    decisionSchema,
    async (req, reply) => {
      if (!checkReviewer(req, reply)) return;
      const params = z.object({ requestId: z.string() }).parse(req.params);
      const body = z
        .object({
          decision: z.enum(["approve", "reject", "request-more-info"]),
          reason: z.string().optional(),
        })
        .parse(req.body);

      const newStatus =
        body.decision === "approve"
          ? "approved"
          : body.decision === "reject"
            ? "rejected"
            : "needs_more_info";

      return reply.send({
        requestId: params.requestId,
        status: newStatus,
      });
    },
  );
}

export class EvidenceTooLargeError extends Error {}

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

/**
 * Accumulates the stream's size, aborting as soon as the running total
 * exceeds `limit`. The stream is destroyed on abort so the remainder of
 * the body is never read through the process — the old `getStreamSize`
 * drained the entire upload first and only then decided the status code,
 * so the limit bounded nothing but the response.
 */
export async function assertStreamWithinLimit(
  stream: NodeJS.ReadableStream,
  limit: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const onData = (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        if (
          "destroy" in stream &&
          typeof (stream as { destroy?: () => void }).destroy === "function"
        ) {
          (stream as { destroy: () => void }).destroy();
        }
        reject(new EvidenceTooLargeError());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
