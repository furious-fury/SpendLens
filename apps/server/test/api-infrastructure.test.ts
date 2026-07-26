import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apiPaths, ApiErrorSchema, ImportProgressSchema, JobSchema } from "@spendlens/contracts";
import { AuditLog, JobQueue, MemoryKeyProvider } from "@spendlens/db";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/api/app-error.js";
import { createJsonLogger } from "../src/api/operational-logger.js";
import { JobWorker } from "../src/jobs/job-worker.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../src/security/security-routes.js";
import { SecurityService } from "../src/security/security-service.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("OpenAPI and structured API behavior", () => {
  it("documents validated security, job, and import-progress endpoints", async () => {
    const fixture = await initializedFixture();
    const response = await fixture.app.request(apiPaths.openApi);
    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths).toHaveProperty("/api/security/login");
    expect(document.paths).toHaveProperty("/api/jobs/{jobId}");
    expect(document.paths).toHaveProperty("/api/imports/{importId}/progress");

    const invalid = await fixture.app.request("/api/jobs/not-a-uuid", {
      headers: fixture.authHeaders(),
    });
    expect(invalid.status).toBe(400);
    expect(ApiErrorSchema.parse(await invalid.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      family: "validation",
      requestId: expect.any(String),
    });
    fixture.close();
  });

  it("returns job and import progress using the documented response schemas", async () => {
    const fixture = await initializedFixture();
    insertImport(fixture);
    const job = fixture.jobs.enqueue({
      workspaceId: fixture.workspaceId,
      jobType: "statement.parse",
      idempotencyKey: "statement-1",
      payload: { importId: fixture.importId },
      relatedImportBatchId: fixture.importId,
    });

    const jobResponse = await fixture.app.request(apiPaths.job(job.id), {
      headers: fixture.authHeaders(),
    });
    expect(jobResponse.status).toBe(200);
    expect(JobSchema.parse(await jobResponse.json())).toMatchObject({
      id: job.id,
      status: "queued",
      progressBasisPoints: 0,
    });

    const importResponse = await fixture.app.request(apiPaths.importProgress(fixture.importId), {
      headers: fixture.authHeaders(),
    });
    expect(importResponse.status).toBe(200);
    expect(ImportProgressSchema.parse(await importResponse.json())).toMatchObject({
      importId: fixture.importId,
      status: "pending",
      jobs: [{ id: job.id }],
    });
    fixture.close();
  });

  it("adds a stable request ID to authentication and routing errors", async () => {
    const fixture = await initializedFixture();
    fixture.app.get("/api/test-sensitive-error", () => {
      throw new AppError("provider", "PROVIDER_UNAVAILABLE", "The provider is unavailable.", 503, {
        details: {
          provider: "example",
          providerToken: "sk-private",
          accountNumber: "0123456789",
        },
      });
    });
    const unauthenticated = await fixture.app.request(apiPaths.job(crypto.randomUUID()), {
      headers: { "x-request-id": "request-fixed-123" },
    });
    const authError = ApiErrorSchema.parse(await unauthenticated.json());
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("x-request-id")).toBe("request-fixed-123");
    expect(authError.error).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      family: "authentication",
      requestId: "request-fixed-123",
    });

    const missing = await fixture.app.request("/does-not-exist");
    expect(ApiErrorSchema.parse(await missing.json()).error).toMatchObject({
      code: "ROUTE_NOT_FOUND",
      requestId: expect.any(String),
    });

    const safeDetails = await fixture.app.request("/api/test-sensitive-error", {
      headers: fixture.authHeaders(),
    });
    expect(ApiErrorSchema.parse(await safeDetails.json()).error.details).toEqual({
      provider: "example",
      providerToken: "[REDACTED]",
      accountNumber: "[REDACTED]",
    });
    fixture.close();
  });
});

describe("privacy-safe logs and audit events", () => {
  it("records setup mutations separately from operational security events", async () => {
    const fixture = await initializedFixture();
    const events = fixture.audit.listForEntity(
      fixture.workspaceId,
      "workspace",
      fixture.workspaceId,
    );

    expect(events.map((event) => event.action)).toEqual([
      "workspace.created",
      "workspace.setup_completed",
    ]);
    expect(events[0]).toMatchObject({
      actorUserId: fixture.userId,
      afterState: {
        name: "My SpendLens",
        timezone: "Africa/Lagos",
        setupStatus: "recovery-required",
      },
    });
    expect(events[1]).toMatchObject({
      beforeState: { setupStatus: "recovery-required" },
      afterState: { setupStatus: "complete" },
    });
    fixture.close();
  });

  it("never writes request secrets or financial contents to operational logs", async () => {
    const lines: string[] = [];
    const fixture = await initializedFixture(createJsonLogger((line) => lines.push(line)));
    fixture.app.get("/api/test-unexpected-error", () => {
      throw new Error("PRIVATE TRANSFER NARRATION 0123456789 sk-private-key");
    });
    const unexpected = await fixture.app.request("/api/test-unexpected-error", {
      headers: fixture.authHeaders(),
    });
    expect(ApiErrorSchema.parse(await unexpected.json()).error).toMatchObject({
      code: "INTERNAL_ERROR",
      family: "internal",
      requestId: expect.any(String),
    });
    await fixture.app.request(apiPaths.login, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "wrong-password-private-value",
        narration: "PRIVATE TRANSFER NARRATION",
        accountNumber: "0123456789",
        providerToken: "sk-private-key",
      }),
    });
    fixture.logger?.log({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "redaction.probe",
      password: "wrong-password-private-value",
      narration: "PRIVATE TRANSFER NARRATION",
      accountNumber: "0123456789",
      providerToken: "sk-private-key",
      key: Buffer.from("cryptographic-key-material"),
    });

    const captured = lines.join("\n");
    expect(captured).not.toContain("wrong-password-private-value");
    expect(captured).not.toContain("PRIVATE TRANSFER NARRATION");
    expect(captured).not.toContain("0123456789");
    expect(captured).not.toContain("sk-private-key");
    expect(captured).not.toContain("cryptographic-key-material");
    expect(captured).toContain("[REDACTED]");
    fixture.close();
  });

  it("audits a user-visible job cancellation with actor and state change", async () => {
    const fixture = await initializedFixture();
    const job = fixture.jobs.enqueue({
      workspaceId: fixture.workspaceId,
      jobType: "statement.parse",
      idempotencyKey: "cancel-me",
      payload: {},
    });
    const response = await fixture.app.request(apiPaths.cancelJob(job.id), {
      method: "POST",
      headers: fixture.authHeaders(true),
    });
    expect(response.status).toBe(200);

    const events = fixture.audit.listForEntity(fixture.workspaceId, "job", job.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      action: "job.cancelled",
      beforeState: { status: "queued" },
      afterState: { status: "cancelled" },
      relatedJobId: job.id,
      requestId: expect.any(String),
    });
    fixture.close();
  });
});

describe("in-process job worker", () => {
  it("runs idempotent handlers and persists progress and results", async () => {
    const fixture = await initializedFixture();
    const job = fixture.jobs.enqueue({
      workspaceId: fixture.workspaceId,
      jobType: "test.process",
      idempotencyKey: "worker-success",
      payload: { count: 2 },
    });
    const worker = new JobWorker({
      queue: fixture.jobs,
      workerId: "test-worker",
      handlers: {
        "test.process": async (payload, context) => {
          context.reportProgress(5_000, "Halfway");
          context.assertActive();
          return { processed: (payload as { count: number }).count };
        },
      },
    });

    await worker.runOnce();
    expect(fixture.jobs.get(fixture.workspaceId, job.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      progressBasisPoints: 10_000,
      result: { processed: 2 },
    });
    fixture.close();
  });
});

async function initializedFixture(logger = createJsonLogger(() => undefined)) {
  const directory = join("/tmp", `spendlens-api-test-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryPaths.push(directory);
  const databasePath = join(directory, "spendlens.db");
  const setupTokenPath = join(directory, "setup-token");
  const security = await SecurityService.create({
    filePath: databasePath,
    keyProvider: new MemoryKeyProvider(),
    setupTokenPath,
  });
  const setupToken = await readFile(setupTokenPath, "utf8");
  await security.prepareSetup(
    {
      setupToken,
      workspaceName: "My SpendLens",
      displayName: "Fury",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
      timezone: "Africa/Lagos",
    },
    "local",
  );
  const credentials = await security.completeSetup(setupToken, true, "local");
  const sqlite = security.sqlite;
  if (!sqlite) throw new Error("Expected an initialized database.");
  const workspace = sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as {
    id: string;
  };
  const jobs = new JobQueue(sqlite);
  const audit = new AuditLog(sqlite);
  const app = createApp({ security, jobs, audit, logger });
  const importId = crypto.randomUUID();

  return {
    app,
    security,
    jobs,
    audit,
    logger,
    sqlite,
    workspaceId: workspace.id,
    userId: credentials.user.id,
    importId,
    authHeaders(withCsrf = false) {
      const headers = new Headers({
        cookie: `${SESSION_COOKIE}=${credentials.sessionToken}; ${CSRF_COOKIE}=${credentials.csrfToken}`,
      });
      if (withCsrf) headers.set(CSRF_HEADER, credentials.csrfToken);
      return headers;
    },
    close() {
      security.close();
    },
  };
}

function insertImport(fixture: Awaited<ReturnType<typeof initializedFixture>>): void {
  fixture.sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, display_name, account_type,
        base_currency, created_at, updated_at
      ) VALUES (?, ?, 'PalmPay', 'PalmPay wallet', 'wallet', 'NGN', 1, 1)`,
    )
    .run("account-1", fixture.workspaceId);
  fixture.sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, account_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, source_timezone, created_at, updated_at
      ) VALUES (?, ?, 'account-1', 'pdf', 'palmpay', '1', 'statement.pdf', ?,
        'Africa/Lagos', 1, 1)`,
    )
    .run(fixture.importId, fixture.workspaceId, "a".repeat(64));
}
