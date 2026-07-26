import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { AiProviderStore, JobQueue, TransactionWorkspace } from "@spendlens/db";
import { AiClassificationService } from "./ai/ai-classification-service.js";
import { AI_CLASSIFICATION_JOB_TYPE } from "./ai/ai-routes.js";
import { createJsonLogger } from "./api/operational-logger.js";
import { createApp } from "./app.js";
import { JobWorker } from "./jobs/job-worker.js";
import { loadSecurityRuntimeConfig } from "./security/runtime-config.js";
import { SecurityService } from "./security/security-service.js";

const port = Number.parseInt(process.env.SPENDLENS_PORT ?? "4545", 10);
const host = process.env.SPENDLENS_HOST ?? "127.0.0.1";
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const securityConfig = loadSecurityRuntimeConfig();

if (host !== "127.0.0.1" && host !== "::1" && !securityConfig.secureCookies) {
  throw new Error(
    "Remote binding requires SPENDLENS_SECURE_COOKIES=true and an HTTPS reverse proxy.",
  );
}

const security = await SecurityService.create({
  filePath: securityConfig.databasePath,
  keyProvider: securityConfig.keyProvider,
  setupTokenPath: securityConfig.setupTokenPath,
});
const logger = createJsonLogger();
const jobs = new JobQueue(() => {
  const database = security.sqlite;
  if (!database) {
    throw new Error("The encrypted workspace database is not available.");
  }
  return database;
});
const sqlite = () => {
  const database = security.sqlite;
  if (!database) {
    throw new Error("The encrypted workspace database is not available.");
  }
  return database;
};
const transactions = new TransactionWorkspace(sqlite);
const aiProviders = new AiProviderStore({
  sqlite,
  credentialStorage: security.keyProviderKind === "keyring" ? "keyring" : "encrypted_database",
  encryptionKey: () => security.aiCredentialKey(),
});
const aiClassification = new AiClassificationService({
  sqlite,
  providers: aiProviders,
  transactions,
});
const worker = new JobWorker({
  queue: jobs,
  handlers: {
    [AI_CLASSIFICATION_JOB_TYPE]: aiClassification.jobHandler(),
  },
  isReady: () => Boolean(security.sqlite),
  onError(error) {
    logger.log({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "worker.loop_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  },
});
worker.start();
const app = createApp({
  security,
  secureCookies: securityConfig.secureCookies,
  jobs,
  transactions,
  aiProviders,
  aiClassification,
  logger,
});

app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ path: `${webRoot}/index.html` }));

const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  () => {
    logger.log({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "server.started",
      host,
      port,
    });
  },
);

server.on("error", (error) => {
  logger.log({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "server.start_failed",
    errorName: error.name,
  });
  process.exitCode = 1;
});

function shutdown(signal: string) {
  logger.log({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "server.stopping",
    signal,
  });
  worker.stop();
  server.close((error) => {
    security.close();
    if (error) {
      logger.log({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "server.stop_failed",
        errorName: error.name,
      });
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
