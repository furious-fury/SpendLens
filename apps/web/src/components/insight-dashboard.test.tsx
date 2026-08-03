import type {
  AnalyticsMetricId,
  AnalyticsMetricResult,
  AnalyticsResult,
} from "@spendlens/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightDashboard } from "@/components/insight-dashboard";
import { INSIGHT_CONFIGS, insightMetricIds } from "@/lib/insight-config";

const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

describe("detailed insight presentation", () => {
  it("renders traceable chart values and calculation notes", () => {
    const result = insightResult("/spending");
    const category = result.metrics.find(({ id }) => id === "spending.by_category");
    if (!category) throw new Error("Missing fixture metric");
    category.breakdown = [
      {
        key: "food",
        label: "Food & Dining",
        value: 82_500,
        transactionIds: [TRANSACTION_ID],
      },
    ];

    const markup = renderToStaticMarkup(
      <InsightDashboard
        config={INSIGHT_CONFIGS["/spending"]}
        grain="month"
        result={result}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Category breakdown");
    expect(markup).toContain("Food &amp; Dining");
    expect(markup).toContain("₦825.00");
    expect(markup).toContain("Accessible chart values");
    expect(markup).toContain("How this is calculated");
    expect(markup).toContain("View 1 transaction");
  });

  it("shows unavailable values and published calculation gaps honestly", () => {
    const result = insightResult("/cash-flow");
    const closing = result.metrics.find(({ id }) => id === "balance.closing");
    if (!closing) throw new Error("Missing fixture metric");
    closing.status = "unavailable";
    closing.value = null;
    closing.unavailableReason = "PalmPay does not provide running balances.";
    closing.transactionIds = [];

    const markup = renderToStaticMarkup(
      <InsightDashboard
        config={INSIGHT_CONFIGS["/cash-flow"]}
        grain="month"
        result={result}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Closing balance");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("PalmPay does not provide running balances");
    expect(markup).toContain("Calculation coverage");
    expect(markup).toContain("Average balance");
    expect(markup).toContain("Positive and negative periods");
    expect(markup).toContain("Movement by account");
  });

  it("uses the required Behaviour subtitle", () => {
    expect(INSIGHT_CONFIGS["/behaviour"].subtitle).toBe("Patterns in how and when you move money.");
  });
});

function insightResult(path: keyof typeof INSIGHT_CONFIGS): AnalyticsResult {
  return {
    query: {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      currency: "NGN",
      accountIds: ["11111111-1111-4111-8111-111111111111"],
      scopes: ["personal", "business"],
      excludeInternalTransfers: true,
    },
    metrics: insightMetricIds(INSIGHT_CONFIGS[path]).map(metric),
    cache: {
      hit: false,
      calculatedAt: "2026-07-26T00:00:00.000Z",
    },
  };
}

function metric(id: AnalyticsMetricId): AnalyticsMetricResult {
  return {
    id,
    title:
      id === "balance.closing"
        ? "Closing balance"
        : (id.split(".").at(-1)?.replaceAll("_", " ") ?? id),
    definition: `Calculation note for ${id}.`,
    unit: id.includes("coverage") || id.includes("concentration") ? "basis_points" : "minor_units",
    status: "available",
    value: 10_000,
    unavailableReason: null,
    transactionIds: [TRANSACTION_ID],
    breakdown: [],
    comparison: null,
  };
}
