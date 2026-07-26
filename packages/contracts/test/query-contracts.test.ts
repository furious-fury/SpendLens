import { describe, expect, it } from "vitest";
import {
  DateRangeQuerySchema,
  PaginationQuerySchema,
  StandardListQuerySchema,
} from "../src/index.js";

describe("shared API query contracts", () => {
  it("coerces pagination and applies stable defaults", () => {
    expect(PaginationQuerySchema.parse({ limit: "50" })).toEqual({
      limit: 50,
    });
    expect(StandardListQuerySchema.parse({})).toEqual({
      limit: 25,
      direction: "desc",
    });
  });

  it("rejects unsafe limits, lowercase currencies, and reversed date ranges", () => {
    expect(PaginationQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(StandardListQuerySchema.safeParse({ currency: "ngn" }).success).toBe(false);
    expect(
      DateRangeQuerySchema.safeParse({
        startDate: "2026-07-10",
        endDate: "2026-07-01",
      }).success,
    ).toBe(false);
    expect(
      StandardListQuerySchema.safeParse({
        startDate: "2026-07-10",
        endDate: "2026-07-01",
      }).success,
    ).toBe(false);
  });
});
