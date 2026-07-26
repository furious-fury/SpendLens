import { ApiErrorSchema, ImportProgressSchema, JobSchema } from "@spendlens/contracts";
import type { AuditLog, JobQueue, JobRecord } from "@spendlens/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "./app-error.js";
import type { AppEnv } from "./request-context.js";

export interface InfrastructureRoutesOptions {
  jobs: JobQueue;
  audit: AuditLog;
  sqlite: () => {
    prepare(sql: string): {
      get(...parameters: unknown[]): unknown;
    };
    transaction<T>(operation: () => T): () => T;
  };
}

const JobParamsSchema = z.object({
  jobId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "jobId", in: "path" },
      example: "19f9b931-1d81-7d63-aaf7-3f784a06877c",
    }),
});

const ImportParamsSchema = z.object({
  importId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "importId", in: "path" },
      example: "29f9b931-1d81-7d63-aaf7-3f784a06877c",
    }),
});

const errorResponse = {
  content: { "application/json": { schema: ApiErrorSchema } },
  description: "Structured API error",
} as const;

const protectedErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  500: errorResponse,
} as const;

const getJobRoute = createRoute({
  method: "get",
  path: "/api/jobs/{jobId}",
  tags: ["Jobs"],
  security: [{ sessionCookie: [] }],
  request: { params: JobParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: JobSchema } },
      description: "Current job status and progress",
    },
    ...protectedErrors,
    404: errorResponse,
  },
});

const cancelJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{jobId}/cancel",
  tags: ["Jobs"],
  security: [{ sessionCookie: [] }],
  request: { params: JobParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: JobSchema } },
      description: "Cancelled job",
    },
    ...protectedErrors,
    404: errorResponse,
    409: errorResponse,
  },
});

const importProgressRoute = createRoute({
  method: "get",
  path: "/api/imports/{importId}/progress",
  tags: ["Imports", "Jobs"],
  security: [{ sessionCookie: [] }],
  request: { params: ImportParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: ImportProgressSchema } },
      description: "Import status and related background jobs",
    },
    ...protectedErrors,
    404: errorResponse,
  },
});

export function createInfrastructureRoutes(
  options: InfrastructureRoutesOptions,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(getJobRoute, (context) => {
    const session = context.get("session");
    const job = options.jobs.get(session.workspaceId, context.req.valid("param").jobId);
    if (!job) {
      throw new AppError("internal", "JOB_NOT_FOUND", "The requested job was not found.", 404);
    }
    return context.json(jobResponse(job), 200);
  });

  routes.openapi(cancelJobRoute, (context) => {
    const session = context.get("session");
    const jobId = context.req.valid("param").jobId;
    const before = options.jobs.get(session.workspaceId, jobId);
    if (!before) {
      throw new AppError("internal", "JOB_NOT_FOUND", "The requested job was not found.", 404);
    }
    if (before.status === "succeeded" || before.status === "failed") {
      throw new AppError(
        "internal",
        "JOB_ALREADY_FINISHED",
        "A completed job cannot be cancelled.",
        409,
      );
    }
    const cancelled = options.sqlite().transaction(() => {
      const result = options.jobs.cancel(session.workspaceId, jobId);
      if (result && before.status !== result.status) {
        options.audit.record({
          workspaceId: session.workspaceId,
          actorUserId: session.user.id,
          entityType: "job",
          entityId: jobId,
          action: "job.cancelled",
          beforeState: { status: before.status },
          afterState: { status: result.status },
          relatedJobId: jobId,
          ...(result.relatedImportBatchId
            ? { relatedImportBatchId: result.relatedImportBatchId }
            : {}),
          requestId: context.get("requestId"),
        });
      }
      return result;
    })();
    if (!cancelled) {
      throw new AppError("internal", "JOB_NOT_FOUND", "The requested job was not found.", 404);
    }
    return context.json(jobResponse(cancelled), 200);
  });

  routes.openapi(importProgressRoute, (context) => {
    const session = context.get("session");
    const importId = context.req.valid("param").importId;
    const imported = options
      .sqlite()
      .prepare("SELECT status FROM import_batches WHERE id = ? AND workspace_id = ?")
      .get(importId, session.workspaceId) as { status: string } | undefined;
    if (!imported) {
      throw new AppError("import", "IMPORT_NOT_FOUND", "The import was not found.", 404);
    }
    return context.json(
      {
        importId,
        status: imported.status as "pending" | "previewed" | "committed" | "failed",
        jobs: options.jobs.getImportJobs(session.workspaceId, importId).map(jobResponse),
      },
      200,
    );
  });

  return routes;
}

export function jobResponse(job: JobRecord) {
  return {
    id: job.id,
    type: job.jobType,
    status: job.status,
    progressBasisPoints: job.progressBasisPoints,
    progressMessage: job.progressMessage,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    error:
      job.errorCode && job.errorMessage ? { code: job.errorCode, message: job.errorMessage } : null,
    result: job.result,
    relatedImportBatchId: job.relatedImportBatchId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
