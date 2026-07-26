import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AnalyticsQuerySchema,
  AnalyticsRegistrySchema,
  AnalyticsResultSchema,
  ApiErrorSchema,
} from "@spendlens/contracts";
import { type AnalyticsEngine, AnalyticsError } from "@spendlens/db";
import { AppError } from "../api/app-error.js";
import type { AppEnv } from "../api/request-context.js";

const errorResponse = {
  content: { "application/json": { schema: ApiErrorSchema } },
  description: "Structured API error",
} as const;

const registryRoute = createRoute({
  method: "get",
  path: "/api/analytics/metrics/registry",
  tags: ["Analytics"],
  responses: {
    200: {
      content: { "application/json": { schema: AnalyticsRegistrySchema } },
      description: "Traceable financial metric registry",
    },
    401: errorResponse,
  },
});

const queryRoute = createRoute({
  method: "post",
  path: "/api/analytics/metrics/query",
  tags: ["Analytics"],
  request: {
    body: { content: { "application/json": { schema: AnalyticsQuerySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AnalyticsResultSchema } },
      description: "Calculated metrics with transaction-level provenance",
    },
    400: errorResponse,
    401: errorResponse,
  },
});

export function createAnalyticsRoutes(engine: AnalyticsEngine) {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(registryRoute, (context) => context.json({ items: engine.registry() }, 200));
  routes.openapi(queryRoute, (context) => {
    try {
      return context.json(
        engine.query(context.get("session").workspaceId, context.req.valid("json")),
        200,
      );
    } catch (error) {
      throw mapAnalyticsError(error);
    }
  });

  return routes;
}

function mapAnalyticsError(error: unknown): AppError {
  if (error instanceof AnalyticsError) {
    return new AppError("validation", error.code, error.message, 400);
  }
  throw error;
}
