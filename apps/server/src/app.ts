import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { apiPaths, type ServiceHealth, ServiceHealthSchema } from "@spendlens/contracts";
import {
  AiProviderStore,
  AuditLog,
  ClassificationEngine,
  ClassificationReview,
  ImportPreviewStore,
  ImportReconciliationStore,
  JobQueue,
  TransactionWorkspace,
  WorkspaceManagement,
} from "@spendlens/db";
import { secureHeaders } from "hono/secure-headers";
import { AiClassificationService } from "./ai/ai-classification-service.js";
import { createAiRoutes } from "./ai/ai-routes.js";
import { AppError } from "./api/app-error.js";
import { createErrorHandler } from "./api/error-handler.js";
import { createInfrastructureRoutes } from "./api/infrastructure-routes.js";
import {
  createJsonLogger,
  type OperationalLogger,
  requestTelemetry,
} from "./api/operational-logger.js";
import type { AppEnv } from "./api/request-context.js";
import { createClassificationRoutes } from "./classification/classification-routes.js";
import { createImportRoutes } from "./imports/import-routes.js";
import { ImportPreviewService } from "./imports/import-service.js";
import { registerSecurityOpenApi } from "./security/security-openapi.js";
import { createSecurityRoutes, requireApiAuthentication } from "./security/security-routes.js";
import type { SecurityService } from "./security/security-service.js";
import { createTransactionRoutes } from "./transactions/transaction-routes.js";

const version = "0.1.0";

function health(status: ServiceHealth["status"]): ServiceHealth {
  return {
    service: "spendlens",
    status,
    timestamp: new Date().toISOString(),
    version,
  };
}

export interface CreateAppOptions {
  security?: SecurityService;
  secureCookies?: boolean;
  jobs?: JobQueue;
  audit?: AuditLog;
  importPreviews?: ImportPreviewService;
  importReconciler?: ImportReconciliationStore;
  transactions?: TransactionWorkspace;
  management?: WorkspaceManagement;
  classification?: ClassificationEngine;
  classificationReview?: ClassificationReview;
  aiProviders?: AiProviderStore;
  aiClassification?: AiClassificationService;
  importTemporaryRoot?: string;
  logger?: OperationalLogger;
}

const healthResponse = {
  200: {
    content: { "application/json": { schema: ServiceHealthSchema } },
    description: "Service health",
  },
} as const;

const liveRoute = createRoute({
  method: "get",
  path: "/health/live",
  tags: ["Health"],
  responses: healthResponse,
});

const readyRoute = createRoute({
  method: "get",
  path: "/health/ready",
  tags: ["Health"],
  responses: healthResponse,
});

export function createApp(options: CreateAppOptions = {}) {
  const logger = options.logger ?? createJsonLogger();
  const errorHandler = createErrorHandler(logger);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook(result) {
      if (!result.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of result.error.issues) {
          const key = issue.path.join(".") || "request";
          fields[key] ??= [];
          fields[key].push(issue.message);
        }
        throw AppError.validation(
          "VALIDATION_FAILED",
          "Check the highlighted fields and try again.",
          fields,
        );
      }
    },
  });

  app.use("*", requestTelemetry(logger));
  app.use("*", secureHeaders());
  app.onError(errorHandler);
  app.notFound((context) =>
    errorHandler(
      new AppError("internal", "ROUTE_NOT_FOUND", "The requested endpoint was not found.", 404),
      context,
    ),
  );

  app.openapi(liveRoute, (context) => context.json(health("ok"), 200));
  app.openapi(readyRoute, (context) => context.json(health("ready"), 200));

  if (options.security) {
    const security = options.security;
    const sqlite = () => {
      const database = security.sqlite;
      if (!database) {
        throw new AppError(
          "database",
          "DATABASE_UNAVAILABLE",
          "The encrypted workspace database is not available.",
          503,
        );
      }
      return database;
    };
    const jobs = options.jobs ?? new JobQueue(sqlite);
    const audit = options.audit ?? new AuditLog(sqlite);
    const importPreviews =
      options.importPreviews ?? new ImportPreviewService(new ImportPreviewStore(sqlite));
    const importReconciler = options.importReconciler ?? new ImportReconciliationStore(sqlite);
    const transactions = options.transactions ?? new TransactionWorkspace(sqlite);
    const management = options.management ?? new WorkspaceManagement(sqlite);
    const classification = options.classification ?? new ClassificationEngine(sqlite);
    const classificationReview =
      options.classificationReview ?? new ClassificationReview(sqlite, classification);
    const aiProviders =
      options.aiProviders ??
      new AiProviderStore({
        sqlite,
        credentialStorage:
          security.keyProviderKind === "keyring" ? "keyring" : "encrypted_database",
        encryptionKey: () => security.aiCredentialKey(),
      });
    const aiClassification =
      options.aiClassification ??
      new AiClassificationService({
        sqlite,
        providers: aiProviders,
        transactions,
      });
    security.registerDatabaseRekeyHook((previousKey, nextKey) =>
      aiProviders.rotateEncryptionKey(previousKey, nextKey),
    );

    app.use("/api/*", requireApiAuthentication(security));
    app.route(
      "/",
      createSecurityRoutes({
        security,
        secureCookies: options.secureCookies ?? false,
      }),
    );
    app.route("/", createInfrastructureRoutes({ jobs, audit, sqlite }));
    app.route(
      "/",
      createImportRoutes({
        previews: importPreviews,
        reconciler: importReconciler,
        classification,
        audit,
        ...(options.importTemporaryRoot ? { temporaryRoot: options.importTemporaryRoot } : {}),
      }),
    );
    app.route(
      "/",
      createTransactionRoutes({
        transactions,
        management,
        audit,
      }),
    );
    app.route(
      "/",
      createClassificationRoutes({
        engine: classification,
        review: classificationReview,
        audit,
      }),
    );
    app.route(
      "/",
      createAiRoutes({
        providers: aiProviders,
        classification: aiClassification,
        jobs,
        audit,
      }),
    );
    app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
      type: "apiKey",
      in: "cookie",
      name: "spendlens_session",
    });
    registerSecurityOpenApi(app);
  }

  app.doc(apiPaths.openApi, {
    openapi: "3.1.0",
    info: {
      title: "SpendLens API",
      version,
      description: "Local-first financial statement intelligence API",
    },
  });

  return app;
}
