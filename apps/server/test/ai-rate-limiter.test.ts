import { describe, expect, it } from "vitest";
import { AiRateLimiter } from "../src/ai/ai-rate-limiter.js";

describe("AI rate limiter", () => {
  it("limits request count and transaction units per workspace", () => {
    let now = 1_000;
    const limiter = new AiRateLimiter(() => now, 60_000, 2, 3);

    expect(limiter.consume("workspace", 2).allowed).toBe(true);
    expect(limiter.consume("workspace", 1).allowed).toBe(true);
    expect(limiter.consume("workspace", 1)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(limiter.consume("workspace", 3).allowed).toBe(true);
  });
});
