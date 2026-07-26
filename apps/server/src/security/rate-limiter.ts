interface AttemptBucket {
  attempts: number;
  windowStartedAt: number;
  blockedUntil: number | null;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class LoginRateLimiter {
  readonly #buckets = new Map<string, AttemptBucket>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly maximumAttempts = 5,
    private readonly windowMilliseconds = 15 * 60 * 1000,
    private readonly blockMilliseconds = 15 * 60 * 1000,
  ) {}

  check(key: string): RateLimitResult {
    const bucket = this.#buckets.get(key);
    const now = this.clock();
    if (!bucket) {
      return { allowed: true };
    }

    if (bucket.blockedUntil && bucket.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)),
      };
    }

    if (now - bucket.windowStartedAt >= this.windowMilliseconds) {
      this.#buckets.delete(key);
    }

    return { allowed: true };
  }

  recordFailure(key: string): RateLimitResult {
    const now = this.clock();
    const current = this.#buckets.get(key);
    const bucket =
      current && now - current.windowStartedAt < this.windowMilliseconds
        ? current
        : { attempts: 0, windowStartedAt: now, blockedUntil: null };

    bucket.attempts += 1;
    if (bucket.attempts >= this.maximumAttempts) {
      bucket.blockedUntil = now + this.blockMilliseconds;
    }
    this.#buckets.set(key, bucket);
    return this.check(key);
  }

  reset(key: string): void {
    this.#buckets.delete(key);
  }
}
