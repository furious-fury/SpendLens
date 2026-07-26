import {
  AnalyzeImportRequestSchema,
  ApiErrorSchema,
  CommitImportRequestSchema,
  ImportDecisionRequestSchema,
  ImportDeduplicationSummarySchema,
  ImportPreviewSchema,
} from "@spendlens/contracts";
import {
  ImportReconciliationError,
  type AuditLog,
  type ImportDeduplicationSummary,
  type ImportReconciliationStore,
  type StoredImportPreview,
} from "@spendlens/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../api/app-error.js";
import type { AppEnv } from "../api/request-context.js";
import { DuplicateImportError, type ImportPreviewService } from "./import-service.js";
import { StatementParserError } from "./parser-types.js";
import { receiveSecurePdf } from "./secure-upload.js";

export interface ImportRoutesOptions {
  previews: ImportPreviewService;
  reconciler: ImportReconciliationStore;
  audit: AuditLog;
  temporaryRoot?: string;
}

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
  404: errorResponse,
  409: errorResponse,
  500: errorResponse,
} as const;

const createPreviewRoute = createRoute({
  method: "post",
  path: "/api/imports/previews",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/pdf": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ImportPreviewSchema } },
      description: "Parsed statement preview",
    },
    ...protectedErrors,
    413: errorResponse,
    422: errorResponse,
  },
});

const getPreviewRoute = createRoute({
  method: "get",
  path: "/api/imports/previews/{importId}",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: { params: ImportParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: ImportPreviewSchema } },
      description: "Stored statement preview",
    },
    ...protectedErrors,
  },
});

const analyzeImportRoute = createRoute({
  method: "post",
  path: "/api/imports/previews/{importId}/reconcile",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: {
    params: ImportParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AnalyzeImportRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportDeduplicationSummarySchema } },
      description: "Duplicate analysis and review queue",
    },
    ...protectedErrors,
  },
});

const getReconciliationRoute = createRoute({
  method: "get",
  path: "/api/imports/previews/{importId}/reconcile",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: { params: ImportParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: ImportDeduplicationSummarySchema } },
      description: "Current duplicate analysis and decisions",
    },
    ...protectedErrors,
  },
});

const decideImportRoute = createRoute({
  method: "post",
  path: "/api/imports/previews/{importId}/decisions",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: {
    params: ImportParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ImportDecisionRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportDeduplicationSummarySchema } },
      description: "Updated duplicate decisions",
    },
    ...protectedErrors,
  },
});

const commitImportRoute = createRoute({
  method: "post",
  path: "/api/imports/previews/{importId}/commit",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: {
    params: ImportParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CommitImportRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportDeduplicationSummarySchema } },
      description: "Committed import result",
    },
    ...protectedErrors,
  },
});

const deleteImportRoute = createRoute({
  method: "delete",
  path: "/api/imports/{importId}",
  tags: ["Imports"],
  security: [{ sessionCookie: [] }],
  request: { params: ImportParamsSchema },
  responses: {
    204: { description: "Import deleted" },
    ...protectedErrors,
  },
});

export function createImportRoutes(options: ImportRoutesOptions): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(createPreviewRoute, async (context) => {
    const session = context.get("session");
    try {
      const upload = await receiveSecurePdf(context.req.raw, {
        ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
      });
      const preview = await options.previews.create(session.workspaceId, upload, (importId) => {
        options.audit.record({
          workspaceId: session.workspaceId,
          actorUserId: session.user.id,
          entityType: "import_batch",
          entityId: importId,
          action: "import.preview_created",
          afterState: { status: "previewed" },
          relatedImportBatchId: importId,
          requestId: context.get("requestId"),
        });
      });
      return context.json(previewResponse(preview), 201);
    } catch (error) {
      throw mapImportError(error);
    }
  });

  routes.openapi(getPreviewRoute, (context) => {
    const session = context.get("session");
    const preview = options.previews.get(session.workspaceId, context.req.valid("param").importId);
    if (!preview) {
      throw new AppError("import", "IMPORT_NOT_FOUND", "The import preview was not found.", 404);
    }
    return context.json(previewResponse(preview), 200);
  });

  routes.openapi(analyzeImportRoute, (context) => {
    const session = context.get("session");
    const importId = context.req.valid("param").importId;
    try {
      const request = context.req.valid("json");
      const summary = options.reconciler.analyze(
        {
          workspaceId: session.workspaceId,
          importId,
          ...(request.accountId ? { accountId: request.accountId } : {}),
        },
        (result) =>
          auditImport(options.audit, context, session, importId, {
            action: "import.duplicates_analyzed",
            afterState: auditSummary(result),
          }),
      );
      return context.json(reconciliationResponse(summary), 200);
    } catch (error) {
      throw mapReconciliationError(error);
    }
  });

  routes.openapi(getReconciliationRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        reconciliationResponse(
          options.reconciler.get(session.workspaceId, context.req.valid("param").importId),
        ),
        200,
      );
    } catch (error) {
      throw mapReconciliationError(error);
    }
  });

  routes.openapi(decideImportRoute, (context) => {
    const session = context.get("session");
    const importId = context.req.valid("param").importId;
    try {
      const summary = options.reconciler.applyDecisions(
        {
          workspaceId: session.workspaceId,
          importId,
          actorUserId: session.user.id,
          decisions: context.req.valid("json").decisions,
        },
        (result) =>
          auditImport(options.audit, context, session, importId, {
            action: "import.duplicate_decisions_updated",
            afterState: auditSummary(result),
          }),
      );
      return context.json(reconciliationResponse(summary), 200);
    } catch (error) {
      throw mapReconciliationError(error);
    }
  });

  routes.openapi(commitImportRoute, (context) => {
    const session = context.get("session");
    const importId = context.req.valid("param").importId;
    try {
      const summary = options.reconciler.commit(
        {
          workspaceId: session.workspaceId,
          importId,
          confirmUnreconciled: context.req.valid("json").confirmUnreconciled,
        },
        (result) =>
          auditImport(options.audit, context, session, importId, {
            action: "import.committed",
            beforeState: { status: "previewed" },
            afterState: {
              status: "committed",
              counts: result.counts,
              commitResult: result.commitResult,
            },
          }),
      );
      return context.json(reconciliationResponse(summary), 200);
    } catch (error) {
      throw mapReconciliationError(error);
    }
  });

  routes.openapi(deleteImportRoute, (context) => {
    const session = context.get("session");
    const importId = context.req.valid("param").importId;
    try {
      options.reconciler.deleteImport(session.workspaceId, importId, (result) => {
        options.audit.record({
          workspaceId: session.workspaceId,
          actorUserId: session.user.id,
          entityType: "import_batch",
          entityId: importId,
          action: "import.deleted",
          beforeState: { status: "present" },
          afterState: {
            status: "deleted",
            orphanedTransactionsDeleted: result.orphanedTransactionsDeleted,
          },
          requestId: context.get("requestId"),
        });
      });
      return context.body(null, 204);
    } catch (error) {
      throw mapReconciliationError(error);
    }
  });

  return routes;
}

function previewResponse(preview: StoredImportPreview) {
  return {
    id: preview.id,
    status: preview.status,
    institution: preview.institutionName,
    maskedAccountNumber: preview.maskedAccountNumber,
    statementPeriod: {
      start: preview.statementStartSource,
      end: preview.statementEndSource,
    },
    totals: {
      inflowMinor: preview.declaredInflowMinor,
      outflowMinor: preview.declaredOutflowMinor,
      currency: "NGN" as const,
    },
    transactionCount: preview.transactionCount,
    reconciliation: {
      status: preview.reconciliationStatus,
      declaredInflowMinor: preview.declaredInflowMinor,
      declaredOutflowMinor: preview.declaredOutflowMinor,
      parsedInflowMinor: preview.parsedInflowMinor,
      parsedOutflowMinor: preview.parsedOutflowMinor,
      currency: "NGN" as const,
    },
    parser: {
      key: preview.adapterKey,
      version: preview.adapterVersion,
    },
    requiresConfirmation: preview.reconciliationStatus === "mismatched",
    createdAt: preview.createdAt.toISOString(),
  };
}

function reconciliationResponse(summary: ImportDeduplicationSummary) {
  return {
    ...summary,
    attentionItems: summary.attentionItems.map((item) => ({
      ...item,
      source: { ...item.source, occurredAt: item.source.occurredAt.toISOString() },
      candidate: {
        ...item.candidate,
        occurredAt: item.candidate.occurredAt.toISOString(),
      },
    })),
    commitResult: summary.commitResult
      ? {
          ...summary.commitResult,
          committedAt: summary.commitResult.committedAt.toISOString(),
        }
      : null,
  };
}

function auditSummary(summary: ImportDeduplicationSummary) {
  return {
    status: summary.status,
    counts: summary.counts,
    pendingDecisionCount: summary.pendingDecisionCount,
  };
}

function auditImport(
  audit: AuditLog,
  context: Context<AppEnv>,
  session: {
    workspaceId: string;
    user: { id: string };
  },
  importId: string,
  event: {
    action: string;
    beforeState?: unknown;
    afterState?: unknown;
  },
) {
  audit.record({
    workspaceId: session.workspaceId,
    actorUserId: session.user.id,
    entityType: "import_batch",
    entityId: importId,
    action: event.action,
    ...(event.beforeState === undefined ? {} : { beforeState: event.beforeState }),
    ...(event.afterState === undefined ? {} : { afterState: event.afterState }),
    relatedImportBatchId: importId,
    requestId: context.get("requestId"),
  });
}

function mapImportError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DuplicateImportError) {
    return new AppError(
      "duplicate",
      "DUPLICATE_IMPORT",
      "This exact statement has already been imported.",
      409,
      { details: { existingImportId: error.existingImportId } },
    );
  }
  if (error instanceof StatementParserError) {
    const status = error.code === "PDF_TOO_LARGE" ? 413 : 422;
    return new AppError("parser", error.code, error.message, status);
  }
  return new AppError("import", "IMPORT_FAILED", "The statement could not be imported.", 500);
}

function mapReconciliationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ImportReconciliationError) {
    if (
      error.code === "IMPORT_NOT_FOUND" ||
      error.code === "ACCOUNT_NOT_FOUND" ||
      error.code === "IMPORT_DECISION_NOT_FOUND"
    ) {
      return new AppError(
        error.code === "ACCOUNT_NOT_FOUND" ? "validation" : "import",
        error.code,
        error.message,
        404,
      );
    }
    if (error.code === "IMPORT_DECISION_INVALID") {
      return new AppError("validation", error.code, error.message, 400);
    }
    return new AppError("duplicate", error.code, error.message, 409);
  }
  return new AppError(
    "import",
    "IMPORT_FAILED",
    "The import operation could not be completed.",
    500,
  );
}
