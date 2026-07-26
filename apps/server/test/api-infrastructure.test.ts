import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AccountSchema,
  apiPaths,
  ApiErrorSchema,
  BulkTransactionResultSchema,
  CategorySchema,
  ImportDeduplicationSummarySchema,
  ImportPreviewSchema,
  ImportProgressSchema,
  JobSchema,
  TransactionListSchema,
  TransactionSchema,
} from "@spendlens/contracts";
import { AuditLog, JobQueue, MemoryKeyProvider } from "@spendlens/db";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/api/app-error.js";
import { createJsonLogger } from "../src/api/operational-logger.js";
import { JobWorker } from "../src/jobs/job-worker.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../src/security/security-routes.js";
import { SecurityService } from "../src/security/security-service.js";
import { createSanitizedPalmPayPdf } from "./palmpay-fixture.js";

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
    expect(document.paths).toHaveProperty("/api/imports/previews");
    expect(document.paths).toHaveProperty("/api/imports/previews/{importId}/reconcile");
    expect(document.paths).toHaveProperty("/api/imports/previews/{importId}/decisions");
    expect(document.paths).toHaveProperty("/api/imports/previews/{importId}/commit");
    expect(document.paths).toHaveProperty("/api/imports/{importId}");
    expect(document.paths).toHaveProperty("/api/imports/{importId}/progress");
    expect(document.paths).toHaveProperty("/api/transactions");
    expect(document.paths).toHaveProperty("/api/transactions/bulk");
    expect(document.paths).toHaveProperty("/api/transactions/{transactionId}");
    expect(document.paths).toHaveProperty("/api/transactions/{transactionId}/splits");
    expect(document.paths).toHaveProperty("/api/transactions/{transactionId}/transfer");
    expect(document.paths).toHaveProperty("/api/accounts");
    expect(document.paths).toHaveProperty("/api/accounts/{accountId}/identifiers");
    expect(document.paths).toHaveProperty("/api/categories");
    expect(document.paths).toHaveProperty("/api/categories/{categoryId}/merge");
    expect(document.paths).toHaveProperty("/api/counterparties");

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

  it("creates an authenticated PalmPay preview without retaining the source PDF", async () => {
    const logLines: string[] = [];
    const fixture = await initializedFixture(createJsonLogger((line) => logLines.push(line)));
    const bytes = await createSanitizedPalmPayPdf();
    const headers = fixture.authHeaders(true);
    headers.set("content-type", "application/pdf");
    headers.set("x-spendlens-filename", "sanitized.pdf");
    const response = await fixture.app.request(apiPaths.importPreviews, {
      method: "POST",
      headers,
      body: bytes,
    });
    const preview = ImportPreviewSchema.parse(await response.json());

    expect(response.status).toBe(201);
    expect(preview).toMatchObject({
      institution: "PalmPay",
      transactionCount: 2,
      reconciliation: { status: "matched" },
      requiresConfirmation: false,
    });
    expect(
      fixture.audit.listForEntity(fixture.workspaceId, "import_batch", preview.id),
    ).toHaveLength(1);
    expect(
      (await readdir(fixture.directory)).filter((name) => name.startsWith("spendlens-upload-")),
    ).toEqual([]);
    expect(logLines.join("\n")).not.toContain("Example Store");
    expect(logLines.join("\n")).not.toContain("fixture-debit-002");

    const stored = await fixture.app.request(apiPaths.importPreview(preview.id), {
      headers: fixture.authHeaders(),
    });
    expect(ImportPreviewSchema.parse(await stored.json())).toEqual(preview);

    const analyzeHeaders = fixture.authHeaders(true);
    analyzeHeaders.set("content-type", "application/json");
    const analyzedResponse = await fixture.app.request(apiPaths.analyzeImport(preview.id), {
      method: "POST",
      headers: analyzeHeaders,
      body: "{}",
    });
    const analyzed = ImportDeduplicationSummarySchema.parse(await analyzedResponse.json());
    expect(analyzedResponse.status).toBe(200);
    expect(analyzed).toMatchObject({
      status: "analyzed",
      willCreateAccount: true,
      counts: {
        new: 2,
        duplicate: 0,
        possibleDuplicate: 0,
        conflict: 0,
      },
      pendingDecisionCount: 0,
    });

    const commitHeaders = fixture.authHeaders(true);
    commitHeaders.set("content-type", "application/json");
    const committedResponse = await fixture.app.request(apiPaths.commitImport(preview.id), {
      method: "POST",
      headers: commitHeaders,
      body: JSON.stringify({ confirmUnreconciled: false }),
    });
    const committed = ImportDeduplicationSummarySchema.parse(await committedResponse.json());
    expect(committed).toMatchObject({
      status: "committed",
      willCreateAccount: false,
      commitResult: {
        canonicalTransactionsCreated: 2,
        duplicateSourcesLinked: 0,
      },
    });
    const retried = await fixture.app.request(apiPaths.commitImport(preview.id), {
      method: "POST",
      headers: commitHeaders,
      body: JSON.stringify({ confirmUnreconciled: false }),
    });
    expect(ImportDeduplicationSummarySchema.parse(await retried.json())).toEqual(committed);
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM transactions").get()).toEqual({
      count: 2,
    });
    expect(
      fixture.audit
        .listForEntity(fixture.workspaceId, "import_batch", preview.id)
        .map((event) => event.action),
    ).toEqual(["import.preview_created", "import.duplicates_analyzed", "import.committed"]);

    const overlapBytes = await createSanitizedPalmPayPdf({
      marker: "overlap fixture version two",
    });
    const overlapHeaders = fixture.authHeaders(true);
    overlapHeaders.set("content-type", "application/pdf");
    const overlapResponse = await fixture.app.request(apiPaths.importPreviews, {
      method: "POST",
      headers: overlapHeaders,
      body: overlapBytes,
    });
    const overlapPreview = ImportPreviewSchema.parse(await overlapResponse.json());
    const overlapAnalyzeHeaders = fixture.authHeaders(true);
    overlapAnalyzeHeaders.set("content-type", "application/json");
    const overlapAnalysisResponse = await fixture.app.request(
      apiPaths.analyzeImport(overlapPreview.id),
      {
        method: "POST",
        headers: overlapAnalyzeHeaders,
        body: "{}",
      },
    );
    expect(
      ImportDeduplicationSummarySchema.parse(await overlapAnalysisResponse.json()),
    ).toMatchObject({
      willCreateAccount: false,
      counts: { new: 0, duplicate: 2 },
    });
    const overlapCommitHeaders = fixture.authHeaders(true);
    overlapCommitHeaders.set("content-type", "application/json");
    const overlapCommit = await fixture.app.request(apiPaths.commitImport(overlapPreview.id), {
      method: "POST",
      headers: overlapCommitHeaders,
      body: JSON.stringify({ confirmUnreconciled: false }),
    });
    expect(ImportDeduplicationSummarySchema.parse(await overlapCommit.json())).toMatchObject({
      commitResult: {
        canonicalTransactionsCreated: 0,
        duplicateSourcesLinked: 2,
      },
    });
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM transactions").get()).toEqual({
      count: 2,
    });
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS count FROM transaction_sources").get(),
    ).toEqual({ count: 4 });

    const fallbackBytes = await createSanitizedPalmPayPdf({
      marker: "fallback fixture version three",
    });
    const fallbackHeaders = fixture.authHeaders(true);
    fallbackHeaders.set("content-type", "application/pdf");
    const fallbackResponse = await fixture.app.request(apiPaths.importPreviews, {
      method: "POST",
      headers: fallbackHeaders,
      body: fallbackBytes,
    });
    const fallbackPreview = ImportPreviewSchema.parse(await fallbackResponse.json());
    fixture.sqlite
      .prepare(
        `UPDATE parsed_source_rows SET
          source_transaction_id = NULL, source_reference = NULL
         WHERE import_batch_id = ?`,
      )
      .run(fallbackPreview.id);
    const fallbackAnalyzeHeaders = fixture.authHeaders(true);
    fallbackAnalyzeHeaders.set("content-type", "application/json");
    const fallbackAnalysisResponse = await fixture.app.request(
      apiPaths.analyzeImport(fallbackPreview.id),
      {
        method: "POST",
        headers: fallbackAnalyzeHeaders,
        body: "{}",
      },
    );
    const fallbackAnalysis = ImportDeduplicationSummarySchema.parse(
      await fallbackAnalysisResponse.json(),
    );
    expect(fallbackAnalysis).toMatchObject({
      counts: { possibleDuplicate: 2 },
      pendingDecisionCount: 2,
    });
    const decisionHeaders = fixture.authHeaders(true);
    decisionHeaders.set("content-type", "application/json");
    const decisionResponse = await fixture.app.request(
      apiPaths.importDecisions(fallbackPreview.id),
      {
        method: "POST",
        headers: decisionHeaders,
        body: JSON.stringify({
          decisions: [
            {
              decisionId: fallbackAnalysis.attentionItems[0]?.decisionId,
              action: "confirm_duplicate",
            },
            {
              decisionId: fallbackAnalysis.attentionItems[1]?.decisionId,
              action: "keep_separate",
            },
          ],
        }),
      },
    );
    expect(ImportDeduplicationSummarySchema.parse(await decisionResponse.json())).toMatchObject({
      pendingDecisionCount: 0,
    });
    const fallbackCommitHeaders = fixture.authHeaders(true);
    fallbackCommitHeaders.set("content-type", "application/json");
    const fallbackCommit = await fixture.app.request(apiPaths.commitImport(fallbackPreview.id), {
      method: "POST",
      headers: fallbackCommitHeaders,
      body: JSON.stringify({ confirmUnreconciled: false }),
    });
    expect(ImportDeduplicationSummarySchema.parse(await fallbackCommit.json())).toMatchObject({
      commitResult: {
        canonicalTransactionsCreated: 1,
        duplicateSourcesLinked: 1,
      },
    });
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM transactions").get()).toEqual({
      count: 3,
    });

    const duplicateHeaders = fixture.authHeaders(true);
    duplicateHeaders.set("content-type", "application/pdf");
    const duplicate = await fixture.app.request(apiPaths.importPreviews, {
      method: "POST",
      headers: duplicateHeaders,
      body: bytes,
    });
    expect(duplicate.status).toBe(409);
    expect(ApiErrorSchema.parse(await duplicate.json()).error.code).toBe("DUPLICATE_IMPORT");
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

describe("transaction workspace API", () => {
  it("lists, filters, edits, splits, and bulk-updates transactions without changing raw rows", async () => {
    const fixture = await initializedFixture();
    const accountResponse = await fixture.app.request(apiPaths.accounts, {
      method: "POST",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        institutionName: "PalmPay",
        institutionCode: "palmpay",
        displayName: "PalmPay wallet",
        accountType: "wallet",
        baseCurrency: "NGN",
        isOwned: true,
      }),
    });
    const account = AccountSchema.parse(await accountResponse.json());
    const categoryResponse = await fixture.app.request(apiPaths.categories, {
      method: "POST",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        name: "Client transport",
        flags: { isExpense: true },
      }),
    });
    const category = CategorySchema.parse(await categoryResponse.json());
    const firstId = insertApiTransaction(fixture, account.id, {
      amountMinor: 12_500,
      narration: "Normalized transfer",
      rawNarration: "RAW PALMPAY TRANSFER VALUE",
    });
    const secondId = insertApiTransaction(fixture, account.id, {
      amountMinor: 8_000,
      narration: "Second transaction",
      occurredAt: Date.UTC(2026, 5, 18),
    });

    const listResponse = await fixture.app.request(
      `${apiPaths.transactions}?search=raw%20palmpay&minimumAmountMinor=10000&scope=personal`,
      { headers: fixture.authHeaders() },
    );
    const list = TransactionListSchema.parse(await listResponse.json());
    expect(list.items.map(({ id }) => id)).toEqual([firstId]);
    expect(list.items[0]?.source.rawNarration).toBe("RAW PALMPAY TRANSFER VALUE");

    const updateResponse = await fixture.app.request(apiPaths.transaction(firstId), {
      method: "PATCH",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        normalizedNarration: "Taxi to client",
        categoryId: category.id,
        scope: "business",
        reviewState: "reviewed",
        note: "June client visit",
      }),
    });
    const updated = TransactionSchema.parse(await updateResponse.json());
    expect(updated).toMatchObject({
      normalizedNarration: "Taxi to client",
      category: { id: category.id },
      scope: "business",
      note: "June client visit",
      source: { rawNarration: "RAW PALMPAY TRANSFER VALUE" },
    });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT raw_narration AS rawNarration
           FROM parsed_source_rows
           WHERE raw_narration = 'RAW PALMPAY TRANSFER VALUE'`,
        )
        .get(),
    ).toEqual({ rawNarration: "RAW PALMPAY TRANSFER VALUE" });

    const invalidSplit = await fixture.app.request(apiPaths.transactionSplits(firstId), {
      method: "PUT",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        splits: [
          { amountMinor: 6_000, categoryId: category.id, scope: "business" },
          { amountMinor: 6_499, categoryId: category.id, scope: "personal" },
        ],
      }),
    });
    expect(invalidSplit.status).toBe(400);

    const splitResponse = await fixture.app.request(apiPaths.transactionSplits(firstId), {
      method: "PUT",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        splits: [
          { amountMinor: 6_000, categoryId: category.id, scope: "business" },
          { amountMinor: 6_500, categoryId: category.id, scope: "personal" },
        ],
      }),
    });
    expect(TransactionSchema.parse(await splitResponse.json()).splits).toMatchObject([
      { amountMinor: 6_000, scope: "business" },
      { amountMinor: 6_500, scope: "personal" },
    ]);

    const bulkResponse = await fixture.app.request(apiPaths.bulkTransactions, {
      method: "PATCH",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        transactionIds: [firstId, secondId],
        changes: { categoryId: category.id, reviewState: "reviewed" },
      }),
    });
    expect(BulkTransactionResultSchema.parse(await bulkResponse.json())).toEqual({
      updatedCount: 2,
      transactionIds: [firstId, secondId],
    });
    expect(
      fixture.audit
        .listForEntity(fixture.workspaceId, "transaction", firstId)
        .map(({ action }) => action),
    ).toEqual(["transaction.updated", "transaction.splits_replaced"]);
    expect(
      fixture.audit
        .listForEntity(fixture.workspaceId, "transaction_bulk", fixture.workspaceId)
        .map(({ action }) => action),
    ).toEqual(["transaction.bulk_updated"]);
    fixture.close();
  });

  it("registers owned identifiers safely and confirms both sides of an internal transfer", async () => {
    const fixture = await initializedFixture();
    const createAccount = async (displayName: string) => {
      const response = await fixture.app.request(apiPaths.accounts, {
        method: "POST",
        headers: jsonHeaders(fixture),
        body: JSON.stringify({
          institutionName: displayName,
          institutionCode: displayName.toLocaleLowerCase(),
          displayName,
          accountType: "wallet",
          baseCurrency: "NGN",
          isOwned: true,
        }),
      });
      return AccountSchema.parse(await response.json());
    };
    const wallet = await createAccount("Wallet");
    const savings = await createAccount("Savings");
    const identifierResponse = await fixture.app.request(apiPaths.accountIdentifier(wallet.id), {
      method: "POST",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({
        institutionCode: "palmpay",
        accountNumber: "8123456789",
      }),
    });
    expect(AccountSchema.parse(await identifierResponse.json()).maskedAccountNumber).toBe(
      "•••• 6789",
    );
    const storedIdentifier = fixture.sqlite
      .prepare(
        `SELECT account_number_fingerprint AS fingerprint,
                masked_account_number AS masked
         FROM owned_account_identifiers`,
      )
      .get() as { fingerprint: string; masked: string };
    expect(storedIdentifier).toMatchObject({
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      masked: "•••• 6789",
    });
    expect(JSON.stringify(storedIdentifier)).not.toContain("8123456789");

    const debitId = insertApiTransaction(fixture, wallet.id, {
      direction: "debit",
      amountMinor: 50_000,
      narration: "Move to savings",
    });
    const creditId = insertApiTransaction(fixture, savings.id, {
      direction: "credit",
      amountMinor: 50_000,
      narration: "Move from wallet",
    });
    const transferResponse = await fixture.app.request(apiPaths.transactionTransfer(debitId), {
      method: "POST",
      headers: jsonHeaders(fixture),
      body: JSON.stringify({ pairedTransactionId: creditId }),
    });
    expect(TransactionSchema.parse(await transferResponse.json())).toMatchObject({
      transactionType: "transfer",
      transfer: { status: "confirmed", pairedTransactionId: creditId },
    });
    const pairedResponse = await fixture.app.request(apiPaths.transaction(creditId), {
      headers: fixture.authHeaders(),
    });
    expect(TransactionSchema.parse(await pairedResponse.json())).toMatchObject({
      transactionType: "transfer",
      transfer: { status: "confirmed", pairedTransactionId: debitId },
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
  const app = createApp({
    security,
    jobs,
    audit,
    logger,
    importTemporaryRoot: directory,
  });
  const importId = crypto.randomUUID();

  return {
    app,
    security,
    jobs,
    audit,
    logger,
    sqlite,
    directory,
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

function jsonHeaders(fixture: Awaited<ReturnType<typeof initializedFixture>>): Headers {
  const headers = fixture.authHeaders(true);
  headers.set("content-type", "application/json");
  return headers;
}

function insertApiTransaction(
  fixture: Awaited<ReturnType<typeof initializedFixture>>,
  accountId: string,
  input: {
    amountMinor: number;
    narration: string;
    occurredAt?: number;
    direction?: "debit" | "credit";
    rawNarration?: string;
  },
): string {
  const transactionId = crypto.randomUUID();
  const occurredAt = input.occurredAt ?? Date.UTC(2026, 5, 17, 11);
  fixture.sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, transaction_type, amount_minor, currency,
        normalized_narration, scope, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '2026-06-17 12:00:00', 'Africa/Lagos', ?,
                'unclassified', ?, 'NGN', ?, 'personal', ?, ?)`,
    )
    .run(
      transactionId,
      fixture.workspaceId,
      accountId,
      occurredAt,
      input.direction ?? "debit",
      input.amountMinor,
      input.narration,
      occurredAt,
      occurredAt,
    );
  if (input.rawNarration) {
    const importId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    fixture.sqlite
      .prepare(
        `INSERT INTO import_batches (
          id, workspace_id, account_id, source_type, adapter_key, adapter_version,
          source_filename, file_fingerprint, status, source_timezone, created_at, updated_at
        ) VALUES (?, ?, ?, 'pdf', 'fixture', '1', 'fixture.pdf', ?,
                  'committed', 'Africa/Lagos', 1, 1)`,
      )
      .run(
        importId,
        fixture.workspaceId,
        accountId,
        crypto.randomUUID().replaceAll("-", "").repeat(2),
      );
    fixture.sqlite
      .prepare(
        `INSERT INTO parsed_source_rows (
          id, import_batch_id, source_row_index, source_timestamp, source_timezone,
          occurred_at_utc, direction, amount_minor, currency, raw_narration,
          row_fingerprint, raw_fields, created_at
        ) VALUES (?, ?, 0, '2026-06-17 12:00:00', 'Africa/Lagos', ?, ?, ?, 'NGN',
                  ?, ?, '{}', 1)`,
      )
      .run(
        sourceId,
        importId,
        occurredAt,
        input.direction ?? "debit",
        input.amountMinor,
        input.rawNarration,
        crypto.randomUUID().replaceAll("-", "").repeat(2),
      );
    fixture.sqlite
      .prepare(
        `INSERT INTO transaction_sources (
          transaction_id, parsed_source_row_id, import_batch_id,
          link_type, match_confidence, created_at
        ) VALUES (?, ?, ?, 'original', 'strong', 1)`,
      )
      .run(transactionId, sourceId, importId);
  }
  return transactionId;
}
