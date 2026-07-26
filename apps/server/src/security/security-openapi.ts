import {
  ApiErrorSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  RekeyRequestSchema,
  RekeyResponseSchema,
  SecuritySessionSchema,
  SecurityStateSchema,
  SetupCompleteRequestSchema,
  SetupPreparedSchema,
  SetupRequestSchema,
} from "@spendlens/contracts";
import type { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../api/request-context.js";

function jsonBody(schema: z.ZodType) {
  return {
    content: { "application/json": { schema } },
    required: true,
  };
}

const errors = {
  400: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Invalid request",
  },
  401: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Authentication failed",
  },
  403: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Request forbidden",
  },
  409: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Request conflicts with current state",
  },
  429: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Rate limited",
  },
  500: {
    content: { "application/json": { schema: ApiErrorSchema } },
    description: "Internal operation failure",
  },
} as const;

export function registerSecurityOpenApi(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/security/state",
    tags: ["Security"],
    responses: {
      200: {
        content: { "application/json": { schema: SecurityStateSchema } },
        description: "Current workspace and authentication state",
      },
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/api/security/setup",
    tags: ["Security"],
    request: { body: jsonBody(SetupRequestSchema) },
    responses: {
      201: {
        content: { "application/json": { schema: SetupPreparedSchema } },
        description: "Encrypted workspace prepared",
      },
      ...errors,
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/api/security/setup/complete",
    tags: ["Security"],
    request: { body: jsonBody(SetupCompleteRequestSchema) },
    responses: {
      200: {
        content: { "application/json": { schema: SecuritySessionSchema } },
        description: "Setup completed and authenticated",
      },
      ...errors,
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/api/security/login",
    tags: ["Security"],
    request: { body: jsonBody(LoginRequestSchema) },
    responses: {
      200: {
        content: { "application/json": { schema: SecuritySessionSchema } },
        description: "Authenticated session",
      },
      ...errors,
    },
  });
  for (const [path, description] of [
    ["/api/security/logout", "Revoke the current session"],
    ["/api/security/sessions/revoke", "Revoke every user session"],
  ] as const) {
    app.openAPIRegistry.registerPath({
      method: "post",
      path,
      tags: ["Security"],
      security: [{ sessionCookie: [] }],
      responses: {
        204: { description },
        ...errors,
      },
    });
  }
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/api/security/password",
    tags: ["Security"],
    security: [{ sessionCookie: [] }],
    request: { body: jsonBody(ChangePasswordRequestSchema) },
    responses: {
      200: {
        content: { "application/json": { schema: SecuritySessionSchema } },
        description: "Password changed and replacement session created",
      },
      ...errors,
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/api/security/database/rekey",
    tags: ["Security"],
    security: [{ sessionCookie: [] }],
    request: { body: jsonBody(RekeyRequestSchema) },
    responses: {
      200: {
        content: { "application/json": { schema: RekeyResponseSchema } },
        description: "Database re-keyed with replacement recovery material",
      },
      ...errors,
    },
  });
}
