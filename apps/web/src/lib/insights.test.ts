import {
  AnalyticsMetricIdSchema,
  type AnalyticsMetricResult,
  type AnalyticsResult,
  type Transaction,
} from "@spendlens/contracts";
import { describe, expect, it, vi } from "vitest";
import { ALL_INSIGHT_METRIC_IDS, INSIGHT_CONFIGS } from "@/lib/insight-config";
import {
  contributionIds,
  aggregateDailyBreakdown,
  filtersFromInsightSearch,
  insightSearchFromFilters,
  metricValue,
  parseInsightSearch,
  refreshAfterInsightCorrection,
  transactionsToCsv,
} from "@/lib/insights";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

describe("insight URL state", () => {
  it("parses supported values and discards malformed state", () => {
    expect(
      parseInsightSearch({
        start: "2026-06-01",
        end: "not-a-date",
        currency: "NGN",
        accounts: ACCOUNT_ID,
        scope: "business",
        compare: "custom",
        compareStart: "2026-05-01",
        compareEnd: "2026-05-31",
        grain: "week",
        metric: "spending.by_category",
        transaction: TRANSACTION_ID,
      }),
    ).toEqual({
      start: "2026-06-01",
      currency: "NGN",
      accounts: ACCOUNT_ID,
      scope: "business",
      compare: "custom",
      compareStart: "2026-05-01",
      compareEnd: "2026-05-31",
      grain: "week",
      metric: "spending.by_category",
      transaction: TRANSACTION_ID,
    });
  });

  it("round-trips exact custom filters", () => {
    const filters = filtersFromInsightSearch(
      {
        start: "2026-06-01",
        end: "2026-06-30",
        currency: "NGN",
        accounts: ACCOUNT_ID,
        scope: "personal",
        compare: "custom",
        compareStart: "2026-04-01",
        compareEnd: "2026-04-30",
      },
      {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        currency: "USD",
        accountIds: [ACCOUNT_ID],
        scopes: ["personal", "business"],
        comparison: { mode: "none" },
      },
      [ACCOUNT_ID],
    );

    expect(insightSearchFromFilters(filters)).toMatchObject({
      start: "2026-06-01",
      end: "2026-06-30",
      currency: "NGN",
      accounts: ACCOUNT_ID,
      scope: "personal",
      compare: "custom",
      compareStart: "2026-04-01",
      compareEnd: "2026-04-30",
    });
  });

  it("round-trips drawer and selected transaction state for browser history", () => {
    const serialized = insightSearchFromFilters(
      {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        currency: "NGN",
        accountIds: [ACCOUNT_ID],
        scopes: ["personal", "business"],
        comparison: { mode: "previous_period" },
      },
      {
        metric: "spending.by_category",
        segment: "food",
        transaction: TRANSACTION_ID,
      },
    );

    expect(parseInsightSearch(serialized)).toMatchObject({
      metric: "spending.by_category",
      segment: "food",
      transaction: TRANSACTION_ID,
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });
});

describe("insight drill-down helpers", () => {
  it("rolls daily values into exact calendar periods without losing provenance", () => {
    const items = [
      {
        key: "2026-06-01",
        label: "2026-06-01",
        value: 1_000,
        transactionIds: [TRANSACTION_ID],
      },
      {
        key: "2026-06-07",
        label: "2026-06-07",
        value: -400,
        transactionIds: ["33333333-3333-4333-8333-333333333333"],
      },
      {
        key: "2026-06-08",
        label: "2026-06-08",
        value: 2_000,
        transactionIds: ["44444444-4444-4444-8444-444444444444"],
      },
    ];

    expect(aggregateDailyBreakdown(items, "week")).toMatchObject([
      { key: "2026-06-01", value: 600, transactionIds: expect.arrayContaining([TRANSACTION_ID]) },
      { key: "2026-06-08", value: 2_000 },
    ]);
    expect(aggregateDailyBreakdown(items, "month")).toMatchObject([
      { key: "2026-06", label: "Jun 2026", value: 2_600 },
    ]);
    expect(
      contributionIds(
        {
          metrics: [
            {
              id: "spending.by_day",
              breakdown: items,
              transactionIds: items.flatMap(({ transactionIds }) => transactionIds),
            },
          ],
        } as AnalyticsResult,
        "spending.by_day",
        "2026-06",
        "month",
      ),
    ).toHaveLength(3);
  });

  it("resolves the exact selected contribution set", () => {
    const result = {
      metrics: [
        {
          id: "spending.by_category",
          transactionIds: [TRANSACTION_ID],
          breakdown: [
            {
              key: "food",
              label: "Food",
              value: 5000,
              transactionIds: [TRANSACTION_ID],
            },
          ],
        },
      ],
    } as AnalyticsResult;
    expect(contributionIds(result, "spending.by_category", "food")).toEqual([TRANSACTION_ID]);
    expect(contributionIds(result, "spending.by_category")).toEqual([TRANSACTION_ID]);
  });

  it("formats metric units without treating basis points as currency", () => {
    const metric = (unit: AnalyticsMetricResult["unit"], value: number) =>
      ({ status: "available", unit, value }) as AnalyticsMetricResult;
    expect(metricValue(metric("basis_points", 2783), "NGN")).toBe("27.83%");
    expect(metricValue(metric("ratio", 1.475), "NGN")).toBe("1.48×");
    expect(metricValue(metric("days", 12), "NGN")).toBe("12 days");
  });

  it("exports safe CSV with raw minor units and escaped descriptions", () => {
    const transaction = {
      occurredAt: "2026-06-12T10:00:00.000Z",
      normalizedNarration: 'Lunch, "team"',
      source: { rawNarration: null },
      counterparty: { displayName: "Cafe" },
      category: null,
      transactionType: "expense",
      direction: "debit",
      amountMinor: 125000,
      currency: "NGN",
      scope: "business",
      reviewState: "reviewed",
      account: { displayName: "PalmPay" },
      sourceReference: "PP-1",
    } as Transaction;

    const csv = transactionsToCsv([transaction]);
    expect(csv).toContain('"Lunch, ""team"""');
    expect(csv).toContain(",125000,NGN,business,reviewed,PalmPay,PP-1");
  });

  it("refreshes analytics and related workspaces after an inline correction", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await refreshAfterInsightCorrection({ invalidateQueries } as never);

    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["classification-review"] });
  });
});

describe("insight metric coverage", () => {
  it("publishes every registered metric on at least one detailed page", () => {
    expect(new Set(ALL_INSIGHT_METRIC_IDS)).toEqual(new Set(AnalyticsMetricIdSchema.options));
  });

  it("documents calculation gaps instead of silently omitting them", () => {
    for (const config of Object.values(INSIGHT_CONFIGS)) {
      expect(config.limitations.length).toBeGreaterThan(0);
      expect(config.limitations.every(({ reason }) => reason.length > 30)).toBe(true);
    }
  });
});
