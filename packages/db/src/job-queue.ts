import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface EnqueueJobInput {
  workspaceId: string;
  jobType: string;
  idempotencyKey: string;
  payload: unknown;
  maxAttempts?: number;
  availableAt?: Date;
  relatedImportBatchId?: string;
}

export interface JobRecord {
  id: string;
  workspaceId: string;
  jobType: string;
  idempotencyKey: string;
  status: JobStatus;
  payload: unknown;
  result: unknown;
  progressBasisPoints: number;
  progressMessage: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  relatedImportBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
  retryDelayMs?: number;
}

export class JobQueue {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  enqueue(input: EnqueueJobInput): JobRecord {
    const now = this.#clock();
    const id = randomUUID();
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    this.#sqlite()
      .prepare(
        `INSERT INTO jobs (
          id, workspace_id, job_type, idempotency_key, payload, max_attempts,
          available_at, related_import_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, job_type, idempotency_key) DO NOTHING`,
      )
      .run(
        id,
        input.workspaceId,
        input.jobType,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        maxAttempts,
        input.availableAt?.getTime() ?? now,
        input.relatedImportBatchId ?? null,
        now,
        now,
      );
    const job = this.#sqlite()
      .prepare(
        `SELECT * FROM jobs
         WHERE workspace_id = ? AND job_type = ? AND idempotency_key = ?`,
      )
      .get(input.workspaceId, input.jobType, input.idempotencyKey) as JobRow | undefined;
    if (!job) throw new Error("The queued job could not be read.");
    return mapJob(job);
  }

  get(workspaceId: string, jobId: string): JobRecord | null {
    const row = this.#sqlite()
      .prepare("SELECT * FROM jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  getImportJobs(workspaceId: string, importBatchId: string): JobRecord[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT * FROM jobs
         WHERE workspace_id = ? AND related_import_batch_id = ?
         ORDER BY created_at DESC`,
      )
      .all(workspaceId, importBatchId) as JobRow[];
    return rows.map(mapJob);
  }

  recoverAbandoned(): { retried: number; failed: number } {
    const sqlite = this.#sqlite();
    const now = this.#clock();
    return sqlite.transaction(() => {
      const expired = sqlite
        .prepare(
          `SELECT id, attempts, max_attempts FROM jobs
           WHERE status = 'running' AND lease_expires_at <= ?`,
        )
        .all(now) as Array<{ id: string; attempts: number; max_attempts: number }>;
      let retried = 0;
      let failed = 0;
      for (const job of expired) {
        if (job.attempts < job.max_attempts) {
          sqlite
            .prepare(
              `UPDATE jobs SET
                status = 'queued', available_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, error_code = 'JOB_LEASE_EXPIRED',
                error_message = 'The previous worker stopped before completing the job.',
                updated_at = ?
               WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
            )
            .run(now, now, job.id, now);
          retried += 1;
        } else {
          sqlite
            .prepare(
              `UPDATE jobs SET
                status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                completed_at = ?, error_code = 'JOB_LEASE_EXPIRED',
                error_message = 'The job stopped before completion and exhausted its attempts.',
                updated_at = ?
               WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
            )
            .run(now, now, job.id, now);
          failed += 1;
        }
      }
      return { retried, failed };
    })();
  }

  claim(workerId: string, leaseDurationMs = 30_000): JobRecord | null {
    if (!workerId || leaseDurationMs < 1) {
      throw new Error("A worker ID and positive lease duration are required.");
    }
    const now = this.#clock();
    const row = this.#sqlite()
      .prepare(
        `UPDATE jobs SET
          status = 'running',
          lease_owner = ?,
          lease_expires_at = ?,
          started_at = COALESCE(started_at, ?),
          attempts = attempts + 1,
          error_code = NULL,
          error_message = NULL,
          updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued'
             AND available_at <= ?
             AND attempts < max_attempts
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1
         )
         AND status = 'queued'
         RETURNING *`,
      )
      .get(workerId, now + leaseDurationMs, now, now, now) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  heartbeat(jobId: string, workerId: string, leaseDurationMs = 30_000): boolean {
    const now = this.#clock();
    const result = this.#sqlite()
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(now + leaseDurationMs, now, jobId, workerId, now);
    return result.changes === 1;
  }

  updateProgress(
    jobId: string,
    workerId: string,
    progressBasisPoints: number,
    message?: string,
  ): boolean {
    if (
      !Number.isInteger(progressBasisPoints) ||
      progressBasisPoints < 0 ||
      progressBasisPoints > 10_000
    ) {
      throw new Error("Job progress must be an integer between 0 and 10000.");
    }
    const now = this.#clock();
    const result = this.#sqlite()
      .prepare(
        `UPDATE jobs SET progress_basis_points = ?, progress_message = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(progressBasisPoints, message ?? null, now, jobId, workerId, now);
    return result.changes === 1;
  }

  complete(jobId: string, workerId: string, result?: unknown): boolean {
    const now = this.#clock();
    const update = this.#sqlite()
      .prepare(
        `UPDATE jobs SET
          status = 'succeeded', result = ?, progress_basis_points = 10000,
          lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(result === undefined ? null : JSON.stringify(result), now, now, jobId, workerId, now);
    return update.changes === 1;
  }

  fail(jobId: string, workerId: string, failure: JobFailure): JobRecord | null {
    const sqlite = this.#sqlite();
    const now = this.#clock();
    return sqlite.transaction(() => {
      const current = sqlite
        .prepare(
          `SELECT * FROM jobs
           WHERE id = ? AND status = 'running' AND lease_owner = ?
             AND lease_expires_at > ?`,
        )
        .get(jobId, workerId, now) as JobRow | undefined;
      if (!current) return null;
      const shouldRetry = failure.retryable && current.attempts < current.max_attempts;
      sqlite
        .prepare(
          shouldRetry
            ? `UPDATE jobs SET
                status = 'queued', available_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, error_code = ?, error_message = ?, updated_at = ?
               WHERE id = ? AND status = 'running' AND lease_owner = ?`
            : `UPDATE jobs SET
                status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                completed_at = ?, error_code = ?, error_message = ?, updated_at = ?
               WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          shouldRetry ? now + (failure.retryDelayMs ?? 1_000) : now,
          failure.code,
          failure.message.slice(0, 500),
          now,
          jobId,
          workerId,
        );
      return this.get(current.workspace_id, jobId);
    })();
  }

  cancel(workspaceId: string, jobId: string): JobRecord | null {
    const now = this.#clock();
    this.#sqlite()
      .prepare(
        `UPDATE jobs SET
          status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          cancelled_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status IN ('queued','running')`,
      )
      .run(now, now, now, jobId, workspaceId);
    return this.get(workspaceId, jobId);
  }

  isActiveLease(jobId: string, workerId: string): boolean {
    const row = this.#sqlite()
      .prepare(
        `SELECT 1 FROM jobs
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .get(jobId, workerId, this.#clock());
    return Boolean(row);
  }
}

interface JobRow {
  id: string;
  workspace_id: string;
  job_type: string;
  idempotency_key: string;
  status: JobStatus;
  payload: string;
  result: string | null;
  progress_basis_points: number;
  progress_message: string | null;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  cancelled_at: number | null;
  error_code: string | null;
  error_message: string | null;
  related_import_batch_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    payload: JSON.parse(row.payload),
    result: row.result ? JSON.parse(row.result) : null,
    progressBasisPoints: row.progress_basis_points,
    progressMessage: row.progress_message,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: new Date(row.available_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toDate(row.lease_expires_at),
    startedAt: toDate(row.started_at),
    completedAt: toDate(row.completed_at),
    cancelledAt: toDate(row.cancelled_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    relatedImportBatchId: row.related_import_batch_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toDate(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}
