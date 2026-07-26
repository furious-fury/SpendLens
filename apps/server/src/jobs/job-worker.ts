import { randomUUID } from "node:crypto";
import type { JobQueue, JobRecord } from "@spendlens/db";

export interface JobContext {
  job: JobRecord;
  reportProgress(progressBasisPoints: number, message?: string): void;
  heartbeat(): void;
  assertActive(): void;
}

export type JobHandler = (payload: unknown, context: JobContext) => Promise<unknown>;

export interface JobWorkerOptions {
  queue: JobQueue;
  handlers: Readonly<Record<string, JobHandler>>;
  workerId?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  isReady?: () => boolean;
  onError?: (error: unknown) => void;
}

export class JobWorker {
  readonly #queue: JobQueue;
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  readonly #workerId: string;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #isReady: () => boolean;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #stopping = false;

  constructor(options: JobWorkerOptions) {
    this.#queue = options.queue;
    this.#handlers = options.handlers;
    this.#workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#isReady = options.isReady ?? (() => true);
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    this.#stopping = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async runOnce(): Promise<JobRecord | null> {
    if (!this.#isReady()) return null;
    this.#queue.recoverAbandoned();
    const job = this.#queue.claim(this.#workerId, this.#leaseDurationMs);
    if (!job) return null;
    const handler = this.#handlers[job.jobType];
    if (!handler) {
      return this.#queue.fail(job.id, this.#workerId, {
        code: "JOB_HANDLER_MISSING",
        message: "No handler is registered for this job type.",
        retryable: false,
      });
    }

    const context: JobContext = {
      job,
      reportProgress: (progressBasisPoints, message) => {
        if (!this.#queue.updateProgress(job.id, this.#workerId, progressBasisPoints, message)) {
          throw new JobLeaseLostError();
        }
      },
      heartbeat: () => {
        if (!this.#queue.heartbeat(job.id, this.#workerId, this.#leaseDurationMs)) {
          throw new JobLeaseLostError();
        }
      },
      assertActive: () => {
        if (!this.#queue.isActiveLease(job.id, this.#workerId)) {
          throw new JobLeaseLostError();
        }
      },
    };

    try {
      const heartbeat = setInterval(
        () => {
          try {
            if (this.#queue.heartbeat(job.id, this.#workerId, this.#leaseDurationMs)) {
              return;
            }
          } catch (error) {
            this.#onError(error);
          }
          clearInterval(heartbeat);
        },
        Math.max(50, Math.floor(this.#leaseDurationMs / 3)),
      );
      heartbeat.unref?.();
      let result: unknown;
      try {
        result = await handler(job.payload, context);
      } finally {
        clearInterval(heartbeat);
      }
      if (!this.#queue.complete(job.id, this.#workerId, result)) {
        throw new JobLeaseLostError();
      }
    } catch (error) {
      if (error instanceof JobLeaseLostError) {
        return this.#queue.get(job.workspaceId, job.id);
      }
      const typedFailure =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        "retryable" in error &&
        typeof error.retryable === "boolean"
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : null;
      this.#queue.fail(job.id, this.#workerId, {
        code: typedFailure?.code ?? "JOB_HANDLER_FAILED",
        message: typedFailure?.message ?? "The background task could not be completed.",
        retryable: typedFailure?.retryable ?? true,
        retryDelayMs: Math.min(30_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)),
      });
    }
    return this.#queue.get(job.workspaceId, job.id);
  }

  #schedule(delay: number): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      try {
        await this.runOnce();
      } catch (error) {
        this.#onError(error);
      } finally {
        this.#schedule(this.#pollIntervalMs);
      }
    }, delay);
    this.#timer.unref?.();
  }
}

class JobLeaseLostError extends Error {
  constructor() {
    super("The job lease is no longer active.");
    this.name = "JobLeaseLostError";
  }
}
