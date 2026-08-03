import { describe, expect, it } from "vitest";
import {
  AnalyticsMetricIdSchema,
  AnalyticsQuerySchema,
  AnalyticsResultSchema,
} from "../src/index.js";

const ACCOUNT_ONE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_TWO = "22222222-2222-4222-8222-222222222222";

describe("analytics contracts", () => {
  it("requires an explicit date range, currency, accounts, and scopes", () => {
    expect(() => AnalyticsQuerySchema.parse({})).toThrow();
    expect(() =>
      AnalyticsQuerySchema.parse({
        startDate: "2026-06-30",
        endDate: "2026-06-01",
        currency: "NGN",
        accountIds: [ACCOUNT_ONE],
        scopes: ["personal"],
      }),
    ).toThrow("startDate must not be after endDate");
    expect(() =>
      AnalyticsQuerySchema.parse({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        currency: "NGN",
        accountIds: [],
        scopes: [],
      }),
    ).toThrow();
  });

  it("normalizes repeated selectors and defaults to a previous-period comparison", () => {
    const query = AnalyticsQuerySchema.parse({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      currency: "NGN",
      accountIds: [ACCOUNT_TWO, ACCOUNT_ONE, ACCOUNT_TWO],
      scopes: ["personal", "business", "personal"],
      metricIds: ["cashflow.net", "cashflow.net"],
    });

    expect(query).toMatchObject({
      accountIds: [ACCOUNT_ONE, ACCOUNT_TWO],
      scopes: ["business", "personal"],
      metricIds: ["cashflow.net"],
      comparison: { mode: "previous_period" },
      excludeInternalTransfers: true,
      useCache: true,
    });
  });

  it("keeps the registry and response metric identifiers closed and finite", () => {
    expect(AnalyticsMetricIdSchema.options).toHaveLength(55);
    expect(() => AnalyticsMetricIdSchema.parse("cashflow.imaginary")).toThrow();
    expect(() =>
      AnalyticsResultSchema.parse({
        query: {
          startDate: "2026-06-01",
          endDate: "2026-06-30",
          currency: "NGN",
          accountIds: [ACCOUNT_ONE],
          scopes: ["personal"],
          excludeInternalTransfers: true,
        },
        metrics: [
          {
            id: "cashflow.net",
            title: "Net cash flow",
            definition: "Inflow less outflow.",
            unit: "minor_units",
            status: "available",
            value: Number.POSITIVE_INFINITY,
            unavailableReason: null,
            transactionIds: [],
            breakdown: [],
            comparison: null,
          },
        ],
        cache: { hit: false, calculatedAt: new Date().toISOString() },
      }),
    ).toThrow();
  });
});
