import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiErrorSchema,
  ApplyReviewDecisionSchema,
  ClassificationPreviewRequestSchema,
  ClassificationPreviewSchema,
  ClassificationRuleListSchema,
  ClassificationRuleSchema,
  CreateClassificationRuleSchema,
  ReorderClassificationRulesSchema,
  ReviewDecisionResultSchema,
  ReviewGroupListSchema,
  UndoReviewDecisionResultSchema,
  UpdateClassificationRuleSchema,
} from "@spendlens/contracts";
import {
  type AuditLog,
  type ClassificationEngine,
  ClassificationError,
  type ClassificationReview,
  ClassificationReviewError,
  type WorkspaceMutation,
} from "@spendlens/db";
import type { Context } from "hono";
import { AppError } from "../api/app-error.js";
import type { AppEnv } from "../api/request-context.js";

export interface ClassificationRoutesOptions {
  engine: ClassificationEngine;
  review: ClassificationReview;
  audit: AuditLog;
}

const RuleParamsSchema = z.object({
  ruleId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "ruleId", in: "path" },
    }),
});

const ReviewActionParamsSchema = z.object({
  actionId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "actionId", in: "path" },
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
  404: errorResponse,
  409: errorResponse,
  500: errorResponse,
} as const;

const listRulesRoute = createRoute({
  method: "get",
  path: "/api/classification/rules",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ClassificationRuleListSchema } },
      description: "Ordered classification rules",
    },
    ...protectedErrors,
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/api/classification/rules",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateClassificationRuleSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ClassificationRuleSchema } },
      description: "Created classification rule",
    },
    ...protectedErrors,
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/api/classification/rules/{ruleId}",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  request: {
    params: RuleParamsSchema,
    body: {
      content: { "application/json": { schema: UpdateClassificationRuleSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ClassificationRuleSchema } },
      description: "Updated classification rule",
    },
    ...protectedErrors,
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/api/classification/rules/{ruleId}",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  request: { params: RuleParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: ClassificationRuleSchema } },
      description: "Deleted classification rule",
    },
    ...protectedErrors,
  },
});

const previewRuleRoute = createRoute({
  method: "post",
  path: "/api/classification/rules/preview",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ClassificationPreviewRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ClassificationPreviewSchema } },
      description: "Transactions and fields affected by the candidate rule",
    },
    ...protectedErrors,
  },
});

const reorderRulesRoute = createRoute({
  method: "put",
  path: "/api/classification/rules/reorder",
  tags: ["Classification"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ReorderClassificationRulesSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ClassificationRuleListSchema } },
      description: "Reordered classification rules",
    },
    ...protectedErrors,
  },
});

const listReviewGroupsRoute = createRoute({
  method: "get",
  path: "/api/classification/review",
  tags: ["Classification Review"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ReviewGroupListSchema } },
      description: "Uncertain transactions grouped by counterparty and narration similarity",
    },
    ...protectedErrors,
  },
});

const applyReviewDecisionRoute = createRoute({
  method: "post",
  path: "/api/classification/review/decisions",
  tags: ["Classification Review"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ApplyReviewDecisionSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ReviewDecisionResultSchema } },
      description: "Applied review decision",
    },
    ...protectedErrors,
  },
});

const undoReviewDecisionRoute = createRoute({
  method: "post",
  path: "/api/classification/review/decisions/{actionId}/undo",
  tags: ["Classification Review"],
  security: [{ sessionCookie: [] }],
  request: { params: ReviewActionParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: UndoReviewDecisionResultSchema } },
      description: "Undid review decision",
    },
    ...protectedErrors,
  },
});

export function createClassificationRoutes(options: ClassificationRoutesOptions) {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(listRulesRoute, (context) =>
    context.json({ items: options.engine.listRules(context.get("session").workspaceId) }, 200),
  );

  routes.openapi(createRuleRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.engine.createRule(
          {
            workspaceId: session.workspaceId,
            actorUserId: session.user.id,
            draft: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        201,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(updateRuleRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.engine.updateRule(
          {
            workspaceId: session.workspaceId,
            ruleId: context.req.valid("param").ruleId,
            changes: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(deleteRuleRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.engine.deleteRule(
          session.workspaceId,
          context.req.valid("param").ruleId,
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(previewRuleRoute, (context) => {
    try {
      return context.json(
        options.engine.previewRule(context.get("session").workspaceId, context.req.valid("json")),
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(reorderRulesRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        {
          items: options.engine.reorderRules(
            session.workspaceId,
            context.req.valid("json").ruleIds,
            auditMutation(options.audit, context),
          ),
        },
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(listReviewGroupsRoute, (context) => {
    try {
      return context.json(options.review.listGroups(context.get("session").workspaceId), 200);
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(applyReviewDecisionRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.review.applyDecision(
          {
            workspaceId: session.workspaceId,
            actorUserId: session.user.id,
            decision: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  routes.openapi(undoReviewDecisionRoute, (context) => {
    try {
      return context.json(
        options.review.undoDecision(
          context.get("session").workspaceId,
          context.req.valid("param").actionId,
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapClassificationError(error);
    }
  });

  return routes;
}

function auditMutation(audit: AuditLog, context: Context<AppEnv>) {
  const session = context.get("session");
  return (mutation: WorkspaceMutation) => {
    audit.record({
      workspaceId: session.workspaceId,
      actorUserId: session.user.id,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      action: mutation.action,
      ...(mutation.beforeState === undefined ? {} : { beforeState: mutation.beforeState }),
      ...(mutation.afterState === undefined ? {} : { afterState: mutation.afterState }),
      ...(mutation.relatedRuleId === undefined ? {} : { relatedRuleId: mutation.relatedRuleId }),
      requestId: context.get("requestId"),
    });
  };
}

function mapClassificationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const field = issue.path.join(".") || "request";
      fields[field] = [...(fields[field] ?? []), issue.message];
    }
    return AppError.validation(
      "VALIDATION_FAILED",
      "The classification request is invalid.",
      fields,
    );
  }
  if (error instanceof ClassificationError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404 : 400;
    return new AppError("classification", error.code, error.message, status);
  }
  if (error instanceof ClassificationReviewError) {
    const status = error.code.endsWith("NOT_FOUND")
      ? 404
      : error.code === "REVIEW_ACTION_ALREADY_UNDONE"
        ? 409
        : 400;
    return new AppError("classification", error.code, error.message, status);
  }
  throw error;
}
