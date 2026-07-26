import { ApiErrorSchema, ImportPreviewSchema } from "@spendlens/contracts";
import type { AuditLog, StoredImportPreview } from "@spendlens/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "../api/app-error.js";
import type { AppEnv } from "../api/request-context.js";
import { DuplicateImportError, type ImportPreviewService } from "./import-service.js";
import { StatementParserError } from "./parser-types.js";
import { receiveSecurePdf } from "./secure-upload.js";

export interface ImportRoutesOptions {
  previews: ImportPreviewService;
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
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    413: errorResponse,
    422: errorResponse,
    500: errorResponse,
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
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
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
