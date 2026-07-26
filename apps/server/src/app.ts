import { apiPaths, type ServiceHealth } from "@spendlens/contracts";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import {
  createSecurityRoutes,
  requireApiAuthentication,
  securityErrorResponse,
} from "./security/security-routes.js";
import type { SecurityService } from "./security/security-service.js";

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
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();

  app.use("*", secureHeaders());
  app.get(apiPaths.live, (context) => context.json(health("ok")));
  app.get(apiPaths.ready, (context) => context.json(health("ready")));

  if (options.security) {
    app.onError(securityErrorResponse);
    app.use("/api/*", requireApiAuthentication(options.security));
    app.route(
      "/",
      createSecurityRoutes({
        security: options.security,
        secureCookies: options.secureCookies ?? false,
      }),
    );
  }

  return app;
}
