interface AiBucket {
  startedAt: number;
  requests: number;
  units: number;
}

export interface AiRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class AiRateLimiter {
  readonly #buckets = new Map<string, AiBucket>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly windowMilliseconds = 15 * 60 * 1000,
    private readonly maximumRequests = 20,
    private readonly maximumUnits = 2_000,
  ) {}

  consume(workspaceId: string, units = 1): AiRateLimitResult {
    const now = this.clock();
    const current = this.#buckets.get(workspaceId);
    const bucket =
      current && now - current.startedAt < this.windowMilliseconds
        ? current
        : { startedAt: now, requests: 0, units: 0 };
    if (
      bucket.requests + 1 > this.maximumRequests ||
      bucket.units + units > this.maximumUnits
    ) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.startedAt + this.windowMilliseconds - now) / 1000),
        ),
      };
    }
    bucket.requests += 1;
    bucket.units += units;
    this.#buckets.set(workspaceId, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
