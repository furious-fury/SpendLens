import { ArrowLineDown } from "@phosphor-icons/react";
import type { AnalyticsMetricResult } from "@spendlens/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardFilters } from "./dashboard-filters";
import { CashFlowChart, CategoryChart, MetricCard } from "./overview-dashboard";

describe("overview accessibility and unavailable states", () => {
  it("renders every required filter and the exact custom comparison dates", () => {
    const markup = renderToStaticMarkup(
      <DashboardFilters
        accounts={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            institutionName: "PalmPay",
            institutionCode: "palmpay",
            displayName: "PalmPay wallet",
            accountType: "wallet",
            baseCurrency: "NGN",
            maskedAccountNumber: null,
            isOwned: true,
            archivedAt: null,
            transactionCount: 3,
          },
        ]}
        value={{
          startDate: "2026-06-01",
          endDate: "2026-06-30",
          currency: "NGN",
          accountIds: ["11111111-1111-4111-8111-111111111111"],
          scopes: ["personal", "business"],
          comparison: {
            mode: "custom",
            startDate: "2026-05-02",
            endDate: "2026-05-31",
          },
        }}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Dashboard filters"');
    expect(markup).toContain('aria-label="Dashboard start date"');
    expect(markup).toContain('aria-label="Dashboard currency"');
    expect(markup).toContain('aria-label="Transaction scope"');
    expect(markup).toContain('aria-label="Comparison period"');
    expect(markup).toContain('value="2026-05-02"');
    expect(markup).toContain('value="2026-05-31"');
    expect(markup).toContain("KPI changes use these exact dates");
  });

  it("describes unavailable balance data without implying a zero balance", () => {
    const markup = renderToStaticMarkup(
      <MetricCard
        currency="NGN"
        label="Closing balance"
        icon={ArrowLineDown}
        metric={{
          ...metric("balance.closing", null),
          status: "unavailable",
          unavailableReason: "The PalmPay statement does not provide running balances.",
        }}
      />,
    );

    expect(markup).toContain("Closing balance");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("does not provide running balances");
    expect(markup).not.toContain("₦0.00");
  });

  it("provides accessible chart labels and text equivalents", () => {
    const cumulative = {
      ...metric("cashflow.cumulative", 15_000),
      breakdown: [
        {
          key: "2026-06-01",
          label: "2026-06-01",
          value: 15_000,
          transactionIds: [],
        },
      ],
    };
    const categories = {
      ...metric("spending.by_category", 8_000),
      breakdown: [
        {
          key: "food",
          label: "Food & Dining",
          value: 8_000,
          transactionIds: [],
        },
      ],
    };
    const cashFlowMarkup = renderToStaticMarkup(
      <CashFlowChart currency="NGN" metric={cumulative} />,
    );
    const categoryMarkup = renderToStaticMarkup(
      <CategoryChart currency="NGN" metric={categories} />,
    );

    expect(cashFlowMarkup).toContain('aria-label="Cumulative cash flow by day"');
    expect(cashFlowMarkup).toContain("2026-06-01: ₦150.00");
    expect(categoryMarkup).toContain('aria-label="Spending by category"');
    expect(categoryMarkup).toContain("Food &amp; Dining: ₦80.00");
  });

  it("keeps the amount neutral and applies semantic colour to its comparison", () => {
    const markup = renderToStaticMarkup(
      <MetricCard
        currency="NGN"
        label="Total inflow"
        icon={ArrowLineDown}
        metric={{
          ...metric("cashflow.total_inflow", 250_000),
          comparison: {
            startDate: "2026-05-02",
            endDate: "2026-05-31",
            value: 200_000,
            absoluteChange: 50_000,
            percentageChange: 25,
            transactionIds: [],
          },
        }}
      />,
    );

    expect(markup).toContain("₦2,500.00");
    expect(markup).toContain("text-success");
    expect(markup).toContain("vs 2 May–31 May 2026");
  });
});

function metric(id: AnalyticsMetricResult["id"], value: number | null): AnalyticsMetricResult {
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
