import { apiPaths, type ServiceHealth } from "@spendlens/contracts";
import { Hono } from "hono";

const version = "0.1.0";

function health(status: ServiceHealth["status"]): ServiceHealth {
  return {
    service: "spendlens",
    status,
    timestamp: new Date().toISOString(),
    version,
  };
}

export function createApp() {
  const app = new Hono();

  app.get(apiPaths.live, (context) => context.json(health("ok")));
  app.get(apiPaths.ready, (context) => context.json(health("ready")));

  return app;
}
