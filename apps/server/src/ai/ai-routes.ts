import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AiClassificationJobRequestSchema,
  AiConnectionTestSchema,
  AiModelListSchema,
  AiPayloadPreviewSchema,
  AiProviderInputSchema,
  AiProviderListSchema,
  AiProviderSettingSchema,
  AiProviderUpdateSchema,
  ApiErrorSchema,
  JobSchema,
} from "@spendlens/contracts";
import {
  type AiProviderStore,
  AiProviderStoreError,
  type AuditLog,
  type JobQueue,
} from "@spendlens/db";
import { AppError } from "../api/app-error.js";
import { jobResponse } from "../api/infrastructure-routes.js";
import type { AppEnv } from "../api/request-context.js";
import type { AiClassificationService } from "./ai-classification-service.js";
import { AiClassificationServiceError } from "./ai-classification-service.js";
import { AiProviderError } from "./provider-adapters.js";

export const AI_CLASSIFICATION_JOB_TYPE = "classification.ai";

export interface AiRoutesOptions {
  providers: AiProviderStore;
  classification: AiClassificationService;
  jobs: JobQueue;
  audit: AuditLog;
}

const ProviderParamsSchema = z.object({
  providerSettingId: z
    .string()
    .uuid()
    .openapi({ param: { name: "providerSettingId", in: "path" } }),
});

const errorResponse = {
  content: { "application/json": { schema: ApiErrorSchema } },
  description: "Structured API error",
} as const;

const listRoute = createRoute({
  method: "get",
  path: "/api/ai/providers",
  tags: ["AI"],
  responses: {
    200: {
      content: { "application/json": { schema: AiProviderListSchema } },
      description: "Configured AI providers",
    },
    401: errorResponse,
  },
});

const createProviderRoute = createRoute({
  method: "post",
  path: "/api/ai/providers",
  tags: ["AI"],
  request: {
    body: { content: { "application/json": { schema: AiProviderInputSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: AiProviderSettingSchema } },
      description: "AI provider created",
    },
    400: errorResponse,
    401: errorResponse,
    409: errorResponse,
  },
});

const updateProviderRoute = createRoute({
  method: "patch",
  path: "/api/ai/providers/{providerSettingId}",
  tags: ["AI"],
  request: {
    params: ProviderParamsSchema,
    body: { content: { "application/json": { schema: AiProviderUpdateSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AiProviderSettingSchema } },
      description: "AI provider updated",
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
  },
});

const deleteProviderRoute = createRoute({
  method: "delete",
  path: "/api/ai/providers/{providerSettingId}",
  tags: ["AI"],
  request: { params: ProviderParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: AiProviderSettingSchema } },
      description: "AI provider deleted",
    },
    401: errorResponse,
    404: errorResponse,
  },
});

const previewRoute = createRoute({
  method: "get",
  path: "/api/ai/providers/{providerSettingId}/payload-preview",
  tags: ["AI"],
  request: { params: ProviderParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: AiPayloadPreviewSchema } },
      description: "Representative provider payload",
    },
    401: errorResponse,
    404: errorResponse,
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/api/ai/providers/{providerSettingId}/test",
  tags: ["AI"],
  request: { params: ProviderParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: AiConnectionTestSchema } },
      description: "Provider connection result",
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    429: errorResponse,
    503: errorResponse,
  },
});

const modelsRoute = createRoute({
  method: "get",
  path: "/api/ai/providers/{providerSettingId}/models",
  tags: ["AI"],
  request: { params: ProviderParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: AiModelListSchema } },
      description: "Provider models",
    },
    401: errorResponse,
    404: errorResponse,
    429: errorResponse,
    503: errorResponse,
  },
});

const classificationJobRoute = createRoute({
  method: "post",
  path: "/api/ai/classification-jobs",
  tags: ["AI"],
  request: {
    body: {
      content: { "application/json": { schema: AiClassificationJobRequestSchema } },
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: JobSchema } },
      description: "Grouped AI classification job queued",
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
  },
});

export function createAiRoutes(options: AiRoutesOptions) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, (context) => {
    const session = context.get("session");
    const items = options.providers.list(session.workspaceId);
    return context.json(
      { items, providersDisabled: items.every((provider) => !provider.enabled) },
      200,
    );
  });

  app.openapi(createProviderRoute, async (context) => {
    const session = context.get("session");
    try {
      const created = await options.providers.create(
        session.workspaceId,
        context.req.valid("json"),
      );
      options.audit.record({
        workspaceId: session.workspaceId,
        actorUserId: session.user.id,
        entityType: "ai_provider_setting",
        entityId: created.id,
        action: "ai_provider.created",
        afterState: created,
        requestId: context.get("requestId"),
      });
      return context.json(created, 201);
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(updateProviderRoute, async (context) => {
    const session = context.get("session");
    const { providerSettingId } = context.req.valid("param");
    const before = options.providers.get(session.workspaceId, providerSettingId);
    try {
      const updated = await options.providers.update(
        session.workspaceId,
        providerSettingId,
        context.req.valid("json"),
      );
      options.audit.record({
        workspaceId: session.workspaceId,
        actorUserId: session.user.id,
        entityType: "ai_provider_setting",
        entityId: updated.id,
        action: "ai_provider.updated",
        beforeState: before,
        afterState: updated,
        requestId: context.get("requestId"),
      });
      return context.json(updated, 200);
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(deleteProviderRoute, async (context) => {
    const session = context.get("session");
    try {
      const deleted = await options.providers.delete(
        session.workspaceId,
        context.req.valid("param").providerSettingId,
      );
      options.audit.record({
        workspaceId: session.workspaceId,
        actorUserId: session.user.id,
        entityType: "ai_provider_setting",
        entityId: deleted.id,
        action: "ai_provider.deleted",
        beforeState: deleted,
        requestId: context.get("requestId"),
      });
      return context.json(deleted, 200);
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(previewRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.classification.payloadPreview(
          session.workspaceId,
          context.req.valid("param").providerSettingId,
        ),
        200,
      );
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(testRoute, async (context) => {
    const session = context.get("session");
    try {
      return context.json(
        await options.classification.testConnection(
          session.workspaceId,
          context.req.valid("param").providerSettingId,
        ),
        200,
      );
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(modelsRoute, async (context) => {
    const session = context.get("session");
    try {
      return context.json(
        {
          items: await options.classification.listModels(
            session.workspaceId,
            context.req.valid("param").providerSettingId,
          ),
          listingSupported: true,
        },
        200,
      );
    } catch (error) {
      throw mapAiError(error);
    }
  });

  app.openapi(classificationJobRoute, (context) => {
    const session = context.get("session");
    const input = context.req.valid("json");
    const setting = options.providers.get(session.workspaceId, input.providerSettingId);
    if (!setting) {
      throw mapAiError(
        new AiClassificationServiceError("AI_PROVIDER_NOT_FOUND", "The AI provider was not found."),
      );
    }
    if (!setting.enabled) {
      throw mapAiError(
        new AiClassificationServiceError(
          "AI_PROVIDER_DISABLED",
          "Enable the AI provider before starting classification.",
        ),
      );
    }
    const job = options.jobs.enqueue({
      workspaceId: session.workspaceId,
      jobType: AI_CLASSIFICATION_JOB_TYPE,
      idempotencyKey: randomUUID(),
      payload: input,
      maxAttempts: 3,
    });
    options.audit.record({
      workspaceId: session.workspaceId,
      actorUserId: session.user.id,
      entityType: "job",
      entityId: job.id,
      action: "ai_classification.queued",
      afterState: {
        providerSettingId: setting.id,
        transactionCount: input.transactionIds.length,
      },
      relatedJobId: job.id,
      requestId: context.get("requestId"),
    });
    return context.json(jobResponse(job), 202);
  });

  return app;
}

function mapAiError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return AppError.validation(
      "VALIDATION_FAILED",
      "The AI provider settings are invalid.",
      fields,
    );
  }
  if (error instanceof AiProviderStoreError || error instanceof AiClassificationServiceError) {
    const status = error.code.endsWith("NOT_FOUND")
      ? 404
      : error.code.endsWith("DUPLICATE")
        ? 409
        : 400;
    return new AppError("provider", error.code, error.message, status);
  }
  if (error instanceof AiProviderError) {
    const status =
      error.code === "AI_PROVIDER_RATE_LIMITED"
        ? 429
        : error.code === "AI_PROVIDER_RESPONSE_INVALID"
          ? 422
          : 503;
    return new AppError("provider", error.code, error.message, status, {
      retryable: error.retryable,
    });
  }
  throw error;
}
