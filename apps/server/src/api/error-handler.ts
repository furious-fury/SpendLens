import { ApiErrorSchema } from "@spendlens/contracts";
import { sanitizePrivateData } from "@spendlens/db";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "./app-error.js";
import type { OperationalLogger } from "./operational-logger.js";
import type { AppEnv } from "./request-context.js";

export function createErrorHandler(logger: OperationalLogger) {
  return (error: Error, context: Context<AppEnv>) => {
    const requestId =
      context.get("requestId") || context.req.header("x-request-id") || "request-unknown";
    const appError =
      error instanceof AppError
        ? error
        : new AppError("internal", "INTERNAL_ERROR", "The request could not be completed.", 500);

    if (appError.options.retryAfterSeconds) {
      context.header("Retry-After", appError.options.retryAfterSeconds.toString());
    }
    if (!(error instanceof AppError)) {
      logger.log({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "request.error",
        requestId,
        code: appError.code,
        errorName: error.name,
      });
    }

    const body = ApiErrorSchema.parse({
      error: {
        code: appError.code,
        message: appError.message,
        family: appError.family,
        requestId,
        details: appError.options.details
          ? sanitizePrivateData(appError.options.details)
          : undefined,
        retryAfterSeconds: appError.options.retryAfterSeconds,
        fields: appError.options.fields,
      },
    });
    return context.json(body, appError.status as ContentfulStatusCode);
  };
}
