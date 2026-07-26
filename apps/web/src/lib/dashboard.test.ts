import type { AnalyticsMetricResult, AnalyticsResult } from "@spendlens/contracts";
import { describe, expect, it } from "vitest";
import { datesForLatestTransaction, previousPeriod } from "@/components/dashboard-filters";
import {
  comparisonTone,
  formatDateRange,
  formatMoney,
  formatPercentage,
  metricById,
  qualityLabel,
} from "./dashboard";

describe("dashboard periods and formatting", () => {
  it("uses the exact equal-length period immediately before the selection", () => {
    expect(previousPeriod("2026-06-01", "2026-06-30")).toEqual({
      startDate: "2026-05-02",
      endDate: "2026-05-31",
    });
    expect(previousPeriod("2024-03-01", "2024-03-31")).toEqual({
      startDate: "2024-01-30",
      endDate: "2024-02-29",
    });
  });

  it("opens the month containing the latest transaction", () => {
    expect(datesForLatestTransaction("2026-06-18T12:00:00.000Z")).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
  });

  it("formats minor units, signed comparisons, percentages, and date labels", () => {
    expect(formatMoney(1_234_567, "NGN")).toBe("₦12,345.67");
    expect(formatMoney(-12_500, "NGN", { sign: true })).toBe("-₦125.00");
    expect(formatPercentage(31.675)).toBe("+31.68");
    expect(formatDateRange("2026-05-02", "2026-05-31")).toBe("2 May–31 May 2026");
  });
});

describe("dashboard metric semantics", () => {
  it("applies semantic tones only to changes and grades data quality", () => {
    expect(comparisonTone(1)).toBe("positive");
    expect(comparisonTone(-1)).toBe("negative");
    expect(comparisonTone(0)).toBe("neutral");
    expect(qualityLabel(9_500)).toBe("Excellent coverage");
    expect(qualityLabel(8_000)).toBe("Good coverage");
    expect(qualityLabel(5_000)).toBe("Needs attention");
    expect(qualityLabel(2_000)).toBe("Early classification");
  });

  it("fails loudly if an API response omits a required dashboard metric", () => {
    const result = {
      query: {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        currency: "NGN",
        accountIds: [],
        scopes: ["personal"],
        excludeInternalTransfers: true,
      },
      metrics: [metric("cashflow.net", 100)],
      cache: { hit: false, calculatedAt: "2026-07-01T00:00:00.000Z" },
    } as AnalyticsResult;

    expect(metricById(result, "cashflow.net").value).toBe(100);
    expect(() => metricById(result, "balance.closing")).toThrow(
      "Dashboard response is missing balance.closing",
    );
  });
});

function metric(id: AnalyticsMetricResult["id"], value: number): AnalyticsMetricResult {
  return {
    id,
    title: id,
    definition: id,
    unit: "minor_units",
    status: "available",
    value,
    unavailableReason: null,
    transactionIds: [],
    breakdown: [],
    comparison: null,
  };
}
