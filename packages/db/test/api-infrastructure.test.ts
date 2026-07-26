import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  AuditLog,
  createEncryptedDatabase,
  JobQueue,
  MemoryKeyProvider,
} from "../src/index.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SQLite job queue", () => {
  it("rolls the previous financial schema forward without losing its data", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys=ON");
    applyMigrations(sqlite, "0001_financial_domain");
    sqlite
      .prepare(
        `INSERT INTO workspaces
          (id, name, timezone, created_at, updated_at)
         VALUES ('workspace', 'My finances', 'Africa/Lagos', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO categories (
          id, workspace_id, slug, name, created_at, updated_at
        ) VALUES ('custom-category', 'workspace', 'custom', 'Custom', 1, 1)`,
      )
      .run();

    applyMigrations(sqlite);

    expect(
      sqlite.prepare("SELECT name FROM categories WHERE id = 'custom-category'").get(),
    ).toEqual({ name: "Custom" });
    expect(
      sqlite.prepare("SELECT id FROM _spendlens_migrations WHERE id = '0002_api_jobs_audit'").get(),
    ).toEqual({ id: "0002_api_jobs_audit" });
    expect(
      sqlite
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name IN ('jobs', 'audit_events')`,
        )
        .get(),
    ).toEqual({ count: 2 });
    sqlite.close();
  });

  it("deduplicates enqueue requests and allows only one worker to claim a job", async () => {
    const fixture = await createFixture();
    const queue = new JobQueue(fixture.sqlite, () => 1_000);
    const first = queue.enqueue({
      workspaceId: "workspace",
      jobType: "statement.parse",
      idempotencyKey: "statement-hash",
      payload: { importId: "import-1" },
    });
    const duplicate = queue.enqueue({
      workspaceId: "workspace",
      jobType: "statement.parse",
      idempotencyKey: "statement-hash",
      payload: { importId: "different-payload-is-ignored" },
    });

    expect(duplicate.id).toBe(first.id);
    const workerOne = queue.claim("worker-1", 5_000);
    const workerTwo = queue.claim("worker-2", 5_000);
    expect(workerOne).toMatchObject({ id: first.id, status: "running", attempts: 1 });
    expect(workerTwo).toBeNull();
    expect(queue.complete(first.id, "worker-1", { rows: 222 })).toBe(true);
    expect(queue.get("workspace", first.id)).toMatchObject({
      status: "succeeded",
      progressBasisPoints: 10_000,
      result: { rows: 222 },
    });
    fixture.close();
  });

  it("recovers abandoned leases for retry and safely fails exhausted jobs", async () => {
    const fixture = await createFixture();
    let now = 10_000;
    const queue = new JobQueue(fixture.sqlite, () => now);
    const retryable = queue.enqueue({
      workspaceId: "workspace",
      jobType: "statement.parse",
      idempotencyKey: "retryable",
      payload: {},
      maxAttempts: 2,
    });
    expect(queue.claim("crashed-worker", 100)?.id).toBe(retryable.id);

    now += 101;
    expect(queue.heartbeat(retryable.id, "crashed-worker", 100)).toBe(false);
    expect(queue.updateProgress(retryable.id, "crashed-worker", 5_000)).toBe(false);
    expect(queue.complete(retryable.id, "crashed-worker", {})).toBe(false);
    expect(queue.recoverAbandoned()).toEqual({ retried: 1, failed: 0 });
    expect(queue.get("workspace", retryable.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      errorCode: "JOB_LEASE_EXPIRED",
    });
    expect(queue.claim("replacement-worker", 100)).toMatchObject({
      id: retryable.id,
      attempts: 2,
    });

    now += 101;
    expect(queue.recoverAbandoned()).toEqual({ retried: 0, failed: 1 });
    expect(queue.get("workspace", retryable.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      errorCode: "JOB_LEASE_EXPIRED",
    });
    fixture.close();
  });

  it("tracks progress, retries safe failures, and supports cancellation", async () => {
    const fixture = await createFixture();
    let now = 20_000;
    const queue = new JobQueue(fixture.sqlite, () => now);
    const job = queue.enqueue({
      workspaceId: "workspace",
      jobType: "classification.run",
      idempotencyKey: "batch-1",
      payload: {},
    });
    queue.claim("worker", 1_000);
    expect(queue.updateProgress(job.id, "worker", 4_500, "Classifying")).toBe(true);
    now += 10;
    expect(
      queue.fail(job.id, "worker", {
        code: "PROVIDER_UNAVAILABLE",
        message: "The provider is temporarily unavailable.",
        retryable: true,
        retryDelayMs: 50,
      }),
    ).toMatchObject({ status: "queued", attempts: 1 });

    now += 50;
    expect(queue.claim("worker", 1_000)).toMatchObject({ id: job.id, attempts: 2 });
    expect(queue.cancel("workspace", job.id)).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
      completedAt: expect.any(Date),
    });
    expect(queue.complete(job.id, "worker", {})).toBe(false);
    fixture.close();
  });
});

describe("audit log", () => {
  it("records user-visible changes while redacting private fields", async () => {
    const fixture = await createFixture();
    const audit = new AuditLog(fixture.sqlite, () => 123_456);
    const event = audit.record({
      workspaceId: "workspace",
      entityType: "transaction",
      entityId: "transaction-1",
      action: "transaction.classified",
      beforeState: { category: null, narration: "PRIVATE NARRATION" },
      afterState: {
        category: "Food & Dining",
        accountNumber: "0123456789",
        nested: { providerToken: "sk-private" },
      },
      requestId: "request-123",
    });

    expect(event).toMatchObject({
      action: "transaction.classified",
      beforeState: { category: null, narration: "[REDACTED]" },
      afterState: {
        category: "Food & Dining",
        accountNumber: "[REDACTED]",
        nested: { providerToken: "[REDACTED]" },
      },
      requestId: "request-123",
      createdAt: new Date(123_456),
    });
    expect(audit.listForEntity("workspace", "transaction", "transaction-1")).toEqual([event]);
    expect(JSON.stringify(event)).not.toContain("PRIVATE NARRATION");
    expect(JSON.stringify(event)).not.toContain("0123456789");
    expect(JSON.stringify(event)).not.toContain("sk-private");
    fixture.close();
  });
});

async function createFixture() {
  const directory = join("/tmp", `spendlens-infrastructure-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryPaths.push(directory);
  const database = await createEncryptedDatabase({
    filePath: join(directory, "spendlens.db"),
    keyProvider: new MemoryKeyProvider(),
  });
  database.sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, name, timezone, created_at, updated_at)
       VALUES ('workspace', 'My finances', 'Africa/Lagos', 1, 1)`,
    )
    .run();
  return database;
}
