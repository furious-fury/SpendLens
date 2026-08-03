import type { AnalyticsResult, Transaction, TransactionType } from "@spendlens/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightDrilldown, TransactionTypeBadge } from "@/components/insight-drilldown";

const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

describe("insight transaction drill-down", () => {
  it("uses one full-screen mobile sheet and right-side desktop drawer", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <InsightDrilldown
          result={resultFixture()}
          metricId="spending.by_category"
          onClose={() => undefined}
          onSelectTransaction={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("absolute inset-0");
    expect(markup).toContain("md:left-auto");
    expect(markup).toContain("md:w-[720px]");
    expect(markup).toContain("Export CSV");
    expect(markup).toContain("1 contributing transaction");
  });

  it.each([
    ["refund", "refund", "bg-chart-2/12"],
    ["transfer", "transfer · internal", "bg-primary/10"],
    ["unclassified", "Unclassified", "bg-attention/12"],
  ] as const)("distinguishes %s transactions", (type, label, className) => {
    const markup = renderToStaticMarkup(
      <TransactionTypeBadge transaction={transactionFixture(type)} />,
    );

    expect(markup).toContain(label);
    expect(markup).toContain(className);
  });
});

function resultFixture(): AnalyticsResult {
  return {
    query: {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      currency: "NGN",
      accountIds: ["11111111-1111-4111-8111-111111111111"],
      scopes: ["personal", "business"],
      excludeInternalTransfers: true,
    },
    metrics: [
      {
        id: "spending.by_category",
        title: "Spending by category",
        definition: "Expense allocations grouped by category.",
        unit: "minor_units",
        status: "available",
        value: 50_000,
        unavailableReason: null,
        transactionIds: [TRANSACTION_ID],
        breakdown: [],
        comparison: null,
      },
    ],
    cache: {
      hit: false,
      calculatedAt: "2026-07-26T00:00:00.000Z",
    },
  };
}

function transactionFixture(type: TransactionType): Transaction {
  return {
    transactionType: type,
    transfer: {
      status: type === "transfer" ? "confirmed" : "none",
      pairedTransactionId: type === "transfer" ? TRANSACTION_ID : null,
    },
  } as Transaction;
}
