import type { AnalyticsMetricId } from "@spendlens/contracts";
import type { InsightPath } from "@/lib/insights";

export interface InsightChartConfig {
  metricId: AnalyticsMetricId;
  title: string;
  description: string;
  kind?: "bar" | "area";
}

export interface InsightMetricGroup {
  title: string;
  description: string;
  metricIds: AnalyticsMetricId[];
}

export interface InsightLimitation {
  title: string;
  reason: string;
}

export interface InsightPageConfig {
  path: InsightPath;
  title: string;
  subtitle: string;
  summaryMetricIds: AnalyticsMetricId[];
  charts: InsightChartConfig[];
  groups: InsightMetricGroup[];
  limitations: InsightLimitation[];
}

export const INSIGHT_CONFIGS: Record<InsightPath, InsightPageConfig> = {
  "/spending": {
    path: "/spending",
    title: "Spending",
    subtitle: "Where money went, what repeats, and what deserves a closer look.",
    summaryMetricIds: [
      "spending.by_category",
      "cashflow.average_outflow",
      "cashflow.largest_outflow",
      "spending.concentration",
    ],
    charts: [
      {
        metricId: "spending.by_day",
        title: "Spending trend",
        description: "Classified spending across the selected period.",
        kind: "area",
      },
      {
        metricId: "spending.by_category",
        title: "Category breakdown",
        description: "Classified expenses, including split allocations, grouped by category.",
      },
      {
        metricId: "spending.by_counterparty",
        title: "Top counterparties",
        description: "Recipients and merchants receiving the most money.",
      },
      {
        metricId: "spending.by_weekday",
        title: "Day-of-week pattern",
        description: "Spending grouped in your workspace timezone.",
      },
      {
        metricId: "spending.recurring",
        title: "Recurring spending",
        description: "Weekly, fortnightly, and monthly payment patterns.",
      },
    ],
    groups: [
      {
        title: "Spending structure",
        description: "How classified spending divides between needs and choices.",
        metricIds: [
          "spending.essential",
          "spending.discretionary",
          "spending.fees",
          "spending.cash_withdrawals",
        ],
      },
      {
        title: "Frequency and exceptions",
        description: "Patterns and transactions that may need attention.",
        metricIds: [
          "spending.recurring",
          "spending.variable",
          "spending.unusual",
          "spending.by_counterparty",
          "spending.by_weekday",
        ],
      },
    ],
    limitations: [
      {
        title: "Category averages, medians, frequency, share, and category-specific trends",
        reason:
          "Category totals and their exact transactions are available, but these secondary per-category statistics are not yet calculated separately.",
      },
      {
        title: "Week-of-month and time-of-day spending",
        reason:
          "The current metric registry groups activity by weekday only. No time pattern is inferred when the source timestamp is ambiguous.",
      },
      {
        title: "Likely subscriptions",
        reason:
          "Recurring cadence is shown, but SpendLens does not label a payment as a subscription without stronger merchant evidence.",
      },
    ],
  },
  "/income": {
    path: "/income",
    title: "Income",
    subtitle: "Where money came from, how concentrated it is, and what is genuinely income.",
    summaryMetricIds: [
      "cashflow.total_inflow",
      "cashflow.average_inflow",
      "cashflow.largest_inflow",
      "income.irregular",
    ],
    charts: [
      {
        metricId: "income.by_day",
        title: "Income trend",
        description: "Confirmed income across the selected period.",
        kind: "area",
      },
      {
        metricId: "income.by_source",
        title: "Income sources",
        description: "Credits confirmed as income, grouped by source or counterparty.",
      },
      {
        metricId: "income.by_weekday",
        title: "Income timing",
        description: "When classified income arrived during the week.",
      },
      {
        metricId: "income.recurring",
        title: "Recurring income",
        description: "Income sources with a repeatable weekly, fortnightly, or monthly cadence.",
      },
    ],
    groups: [
      {
        title: "Reliability",
        description: "How repeatable and concentrated confirmed income appears.",
        metricIds: [
          "income.recurring",
          "income.irregular",
          "income.concentration",
          "income.variability",
          "income.by_weekday",
        ],
      },
      {
        title: "Credits that are not income",
        description: "Kept separate so refunds and corrections do not inflate earnings.",
        metricIds: ["adjustments.refunds", "adjustments.reversals"],
      },
    ],
    limitations: [
      {
        title: "Income by category",
        reason:
          "Income sources and irregular income are traceable, but an income-category aggregate is not registered yet.",
      },
      {
        title: "Median, minimum, and income-only maximum",
        reason:
          "Average and largest credit are available. Other income-only transaction statistics are not separately calculated.",
      },
    ],
  },
  "/cash-flow": {
    path: "/cash-flow",
    title: "Cash Flow",
    subtitle: "Inflows, outflows, net movement, transfers, and available balance facts.",
    summaryMetricIds: [
      "cashflow.total_inflow",
      "cashflow.total_outflow",
      "cashflow.net",
      "cashflow.inflow_outflow_ratio",
    ],
    charts: [
      {
        metricId: "cashflow.cumulative",
        title: "Cumulative movement",
        description: "Running net cash movement by local calendar day.",
        kind: "area",
      },
      {
        metricId: "cashflow.by_day",
        title: "Positive and negative periods",
        description: "Net movement above or below zero for the selected trend interval.",
      },
      {
        metricId: "cashflow.by_account",
        title: "Movement by account",
        description: "Net movement grouped by selected source account.",
      },
    ],
    groups: [
      {
        title: "Transaction movement",
        description: "Direct cash-flow statistics across the selected accounts.",
        metricIds: [
          "cashflow.average_inflow",
          "cashflow.average_outflow",
          "cashflow.median_transaction",
          "cashflow.largest_inflow",
          "cashflow.largest_outflow",
          "cashflow.transaction_count",
          "cashflow.by_account",
        ],
      },
      {
        title: "Transfer movement",
        description: "Internal transfers remain excluded from income and spending by default.",
        metricIds: ["transfers.internal", "transfers.external"],
      },
      {
        title: "Available balance facts",
        description: "Shown only when every selected source supplies trustworthy running balances.",
        metricIds: ["balance.opening", "balance.closing", "balance.lowest", "balance.highest"],
      },
    ],
    limitations: [
      {
        title: "Minimum inflow and outflow",
        reason:
          "Largest and average movements are available; minimum movement is not a separate registered metric.",
      },
      {
        title: "Average balance",
        reason:
          "PalmPay statements do not provide the running balances needed for a defensible time-weighted average.",
      },
    ],
  },
  "/behaviour": {
    path: "/behaviour",
    title: "Behaviour",
    subtitle: "Patterns in how and when you move money.",
    summaryMetricIds: [
      "savings.estimated_rate",
      "behaviour.no_spend_days",
      "behaviour.weekend_share",
      "behaviour.average_daily_activity",
    ],
    charts: [
      {
        metricId: "behaviour.activity_by_weekday",
        title: "Activity by weekday",
        description: "Distinct transactions grouped by weekday.",
      },
      {
        metricId: "behaviour.activity_by_day",
        title: "Busiest transaction days",
        description: "Daily transaction frequency across the selected period.",
      },
      {
        metricId: "behaviour.account_usage",
        title: "Account usage",
        description: "How transaction activity is distributed across selected accounts.",
      },
      {
        metricId: "quality.confidence_distribution",
        title: "Classification confidence",
        description: "How much of the selected activity has strong classification evidence.",
      },
      {
        metricId: "quality.reconciliation",
        title: "Import reconciliation",
        description: "Transactions grouped by their source statement reconciliation status.",
      },
    ],
    groups: [
      {
        title: "Movement patterns",
        description: "Descriptive patterns without goals, scores, or financial advice.",
        metricIds: [
          "behaviour.change",
          "behaviour.expense_income_ratio",
          "behaviour.savings_transfers",
          "spending.recurring",
          "spending.variable",
          "spending.unusual",
          "spending.essential",
          "spending.discretionary",
        ],
      },
      {
        title: "Data quality",
        description: "The reliability context behind every dashboard and insight.",
        metricIds: [
          "quality.classification_coverage",
          "quality.confidence_distribution",
          "quality.review_queue",
          "quality.reconciliation",
          "quality.duplicate_sources",
        ],
      },
    ],
    limitations: [
      {
        title: "Recurring-versus-variable ratio",
        reason:
          "Recurring and variable totals are traceable, but their ratio is not a separate registered metric.",
      },
      {
        title: "Classification counts, values, and source attribution",
        reason:
          "Coverage, confidence, and review status are available. Manual/rule/history/AI totals are not yet separate aggregates.",
      },
    ],
  },
};

export function insightMetricIds(config: InsightPageConfig): AnalyticsMetricId[] {
  return [
    ...new Set([
      ...config.summaryMetricIds,
      ...config.charts.map(({ metricId }) => metricId),
      ...config.groups.flatMap(({ metricIds }) => metricIds),
    ]),
  ];
}

export const ALL_INSIGHT_METRIC_IDS = [
  ...new Set(Object.values(INSIGHT_CONFIGS).flatMap(insightMetricIds)),
] satisfies AnalyticsMetricId[];
