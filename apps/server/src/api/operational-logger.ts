import { randomUUID } from "node:crypto";
import { sanitizePrivateData } from "@spendlens/db";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./request-context.js";

export interface OperationalLogRecord {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  [key: string]: unknown;
}

export interface OperationalLogger {
  log(record: OperationalLogRecord): void;
}

export function createJsonLogger(
  sink: (line: string) => void = (line) => console.log(line),
): OperationalLogger {
  return {
    log(record) {
      sink(JSON.stringify(sanitizePrivateData(record)));
    },
  };
}

export function requestTelemetry(logger: OperationalLogger): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId = supplied && /^[A-Za-z0-9_-]{8,100}$/.test(supplied) ? supplied : randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.header("X-Request-ID", requestId);

    try {
      await next();
    } finally {
      logger.log({
        timestamp: new Date().toISOString(),
        level: context.res.status >= 500 ? "error" : "info",
        event: "request.completed",
        requestId,
        method: context.req.method,
        path: safePath(context.req.path),
        status: context.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    }
  };
}

function safePath(path: string): string {
  return path
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:id",
    )
    .replace(/\b\d{6,}\b/g, ":number")
    .slice(0, 300);
}
