import { createHash, randomUUID } from "node:crypto";
import type {
  AnalyticsBreakdownItem,
  AnalyticsMetricDefinition,
  AnalyticsMetricId,
  AnalyticsMetricResult,
  AnalyticsQuery,
  AnalyticsResult,
} from "@spendlens/contracts";
import {
  AnalyticsMetricIdSchema,
  AnalyticsQuerySchema,
  AnalyticsResultSchema,
} from "@spendlens/contracts";
import type Database from "better-sqlite3";
import { localDateRangeToUtc } from "./time.js";

export type AnalyticsErrorCode =
  | "ANALYTICS_ACCOUNT_NOT_FOUND"
  | "ANALYTICS_ACCOUNT_CURRENCY_MISMATCH"
  | "ANALYTICS_QUERY_INVALID";

export class AnalyticsError extends Error {
  constructor(
    readonly code: AnalyticsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsError";
  }
}

interface Allocation {
  transactionId: string;
  accountId: string;
  accountName: string;
  occurredAt: number;
  direction: "debit" | "credit";
  transactionType:
    | "expense"
    | "income"
    | "transfer"
    | "refund"
    | "fee"
    | "cash_withdrawal"
    | "debt"
    | "unclassified";
  amountMinor: number;
  scope: "personal" | "business";
  categoryId: string | null;
  categoryName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  narration: string | null;
  confidence: "unknown" | "low" | "medium" | "high" | "confirmed";
  reviewState: "unreviewed" | "needs_review" | "reviewed";
  internalTransfer: boolean;
  categoryIsIncome: boolean;
  categoryIsExpense: boolean;
  categoryIsEssential: boolean;
  categoryIsDiscretionary: boolean;
  categoryIsRefund: boolean;
  categoryIsFee: boolean;
  categoryIsCashWithdrawal: boolean;
  duplicateSourceCount: number;
  reconciliationStatus: "matched" | "mismatched" | "unknown";
  balanceAfterMinor: number | null;
}

interface PeriodContext {
  startDate: string;
  endDate: string;
  startAt: number;
  endAt: number;
  timeZone: string;
  query: AnalyticsQuery;
  allocations: Allocation[];
}

interface CalculatedMetric {
  status: "available" | "unavailable";
  value: number | null;
  unavailableReason: string | null;
  transactionIds: string[];
  breakdown: AnalyticsBreakdownItem[];
}

interface MetricRegistration {
  definition: AnalyticsMetricDefinition;
  calculate(context: PeriodContext): CalculatedMetric;
}

interface AllocationRow {
  transaction_id: string;
  account_id: string;
  account_name: string;
  occurred_at_utc: number;
  direction: "debit" | "credit";
  transaction_type: Allocation["transactionType"];
  amount_minor: number;
  scope: Allocation["scope"];
  category_id: string | null;
  category_name: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  normalized_narration: string | null;
  confidence_level: Allocation["confidence"];
  review_state: Allocation["reviewState"];
  transfer_pairing_status: string;
  paired_transaction_id: string | null;
  is_income: number | null;
  is_expense: number | null;
  is_essential: number | null;
  is_discretionary: number | null;
  is_refund: number | null;
  is_fee: number | null;
  is_cash_withdrawal: number | null;
  duplicate_source_count: number;
  reconciliation_status: "matched" | "mismatched" | "unknown";
  balance_after_minor: number | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

function definition(
  id: AnalyticsMetricId,
  title: string,
  metricDefinition: string,
  unit: AnalyticsMetricDefinition["unit"],
  supportedDimensions: AnalyticsMetricDefinition["supportedDimensions"] = ["total"],
  requiredFields = ["amount", "direction", "occurredAt"],
): AnalyticsMetricDefinition {
  return {
    id,
    title,
    definition: metricDefinition,
    unit,
    supportedDimensions,
    requiredFields,
  };
}

function available(
  value: number,
  allocations: readonly Allocation[],
  breakdown: AnalyticsBreakdownItem[] = [],
): CalculatedMetric {
  return {
    status: "available",
    value,
    unavailableReason: null,
    transactionIds: ids(allocations),
    breakdown,
  };
}

function unavailable(reason: string): CalculatedMetric {
  return {
    status: "unavailable",
    value: null,
    unavailableReason: reason,
    transactionIds: [],
    breakdown: [],
  };
}

function ids(allocations: readonly Allocation[]): string[] {
  return [...new Set(allocations.map((row) => row.transactionId))].sort();
}

function uniqueTransactions(allocations: readonly Allocation[]): Allocation[] {
  const transactions = new Map<string, Allocation>();
  for (const row of allocations) {
    const existing = transactions.get(row.transactionId);
    if (existing) {
      existing.amountMinor += row.amountMinor;
    } else {
      transactions.set(row.transactionId, { ...row });
    }
  }
  return [...transactions.values()];
}

function movementRows(context: PeriodContext): Allocation[] {
  return context.allocations.filter(
    (row) => !context.query.excludeInternalTransfers || !row.internalTransfer,
  );
}

function spendingRows(context: PeriodContext): Allocation[] {
  return context.allocations.filter(
    (row) =>
      row.direction === "debit" &&
      !row.internalTransfer &&
      !isRefund(row) &&
      row.transactionType !== "transfer",
  );
}

function incomeRows(context: PeriodContext): Allocation[] {
  return context.allocations.filter(
    (row) =>
      row.direction === "credit" &&
      !row.internalTransfer &&
      !isRefund(row) &&
      row.transactionType !== "transfer" &&
      (row.transactionType === "income" || row.categoryIsIncome),
  );
}

function isRefund(row: Allocation): boolean {
  return row.transactionType === "refund" || row.categoryIsRefund;
}

function isReversal(row: Allocation): boolean {
  return isRefund(row) && /\b(reversal|reversed|revert(?:ed)?)\b/i.test(row.narration ?? "");
}

function sum(rows: readonly Allocation[]): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}

function roundedAverage(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] ?? 0)
    : Math.round(((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2);
}

function basisPoints(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000);
}

function grouped(
  rows: readonly Allocation[],
  key: (row: Allocation) => string,
  label: (row: Allocation) => string,
  value: (group: readonly Allocation[]) => number = sum,
): AnalyticsBreakdownItem[] {
  const groups = new Map<string, Allocation[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const existing = groups.get(groupKey) ?? [];
    existing.push(row);
    groups.set(groupKey, existing);
  }
  return [...groups.entries()]
    .map(([groupKey, group]) => ({
      key: groupKey,
      label: label(group[0] as Allocation),
      value: value(group),
      transactionIds: ids(group),
    }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
}

function weekday(context: PeriodContext, occurredAt: number): { key: string; label: string } {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: context.timeZone,
    weekday: "long",
  }).format(new Date(occurredAt));
  const index = WEEKDAYS.indexOf(value);
  return { key: String(index === -1 ? 0 : index), label: value };
}

function localDate(context: PeriodContext, occurredAt: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(occurredAt))
    .filter((part) => part.type !== "literal")
    .reduce(
      (parts, part) => {
        parts[part.type] = part.value;
        return parts;
      },
      {} as Record<string, string>,
    );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function recurringGroups(rows: readonly Allocation[]): Map<string, Allocation[]> {
  const candidates = new Map<string, Allocation[]>();
  for (const row of rows) {
    const groupKey = row.counterpartyId
      ? `counterparty:${row.counterpartyId}`
      : row.narration
        ? `narration:${row.narration.toLocaleLowerCase("en-NG")}`
        : row.categoryId
          ? `category:${row.categoryId}`
          : "unidentified";
    const existing = candidates.get(groupKey) ?? [];
    existing.push(row);
    candidates.set(groupKey, existing);
  }

  const recurring = new Map<string, Allocation[]>();
  for (const [key, group] of candidates) {
    const transactions = uniqueTransactions(group).sort(
      (left, right) => left.occurredAt - right.occurredAt,
    );
    if (transactions.length < 3) continue;
    const intervals = transactions.slice(1).map((row, index) => {
      const previous = transactions[index] as Allocation;
      return (row.occurredAt - previous.occurredAt) / DAY_MS;
    });
    const cadence = median(intervals);
    const isRecurring =
      (cadence >= 5 && cadence <= 9) ||
      (cadence >= 12 && cadence <= 16) ||
      (cadence >= 25 && cadence <= 35);
    if (isRecurring) recurring.set(key, group);
  }
  return recurring;
}

function recurringMetric(rows: readonly Allocation[]): CalculatedMetric {
  const groups = recurringGroups(rows);
  const recurring = [...groups.values()].flat();
  const breakdown = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label:
        group[0]?.counterpartyName ??
        group[0]?.narration ??
        group[0]?.categoryName ??
        "Unidentified recurring activity",
      value: sum(group),
      transactionIds: ids(group),
    }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
  return available(sum(recurring), recurring, breakdown);
}

function unusualRows(rows: readonly Allocation[]): Allocation[] {
  if (rows.length < 4) return [];
  const values = rows.map((row) => row.amountMinor).sort((left, right) => left - right);
  const lower = values.slice(0, Math.floor(values.length / 2));
  const upper = values.slice(Math.ceil(values.length / 2));
  const q1 = median(lower);
  const q3 = median(upper);
  const threshold = q3 + 1.5 * (q3 - q1);
  return rows.filter((row) => row.amountMinor > threshold);
}

function balanceMetric(
  context: PeriodContext,
  kind: "opening" | "closing" | "lowest" | "highest",
): CalculatedMetric {
  if (!context.query.scopes.includes("personal") || !context.query.scopes.includes("business")) {
    return unavailable("Account balances cannot be divided reliably by personal/business scope.");
  }

  const byAccount = new Map<string, Allocation[]>();
  for (const row of uniqueTransactions(context.allocations)) {
    if (row.balanceAfterMinor === null) continue;
    const existing = byAccount.get(row.accountId) ?? [];
    existing.push(row);
    byAccount.set(row.accountId, existing);
  }
  if (byAccount.size !== context.query.accountIds.length) {
    return unavailable(
      "The selected statement data does not provide running balances for every account.",
    );
  }
  if ((kind === "lowest" || kind === "highest") && byAccount.size !== 1) {
    return unavailable(
      "A combined lowest or highest balance is unavailable because account balance timestamps do not align.",
    );
  }

  const contributions: Allocation[] = [];
  const breakdown: AnalyticsBreakdownItem[] = [];
  for (const [accountId, accountRows] of byAccount) {
    const ordered = accountRows.sort((left, right) => left.occurredAt - right.occurredAt);
    let contributing: Allocation[];
    let value: number;
    if (kind === "opening") {
      const first = ordered[0] as Allocation;
      const signedAmount = first.direction === "credit" ? first.amountMinor : -first.amountMinor;
      value = (first.balanceAfterMinor as number) - signedAmount;
      contributing = [first];
    } else if (kind === "closing") {
      const last = ordered.at(-1) as Allocation;
      value = last.balanceAfterMinor as number;
      contributing = [last];
    } else {
      const target = kind === "lowest" ? Math.min : Math.max;
      value = target(...ordered.map((row) => row.balanceAfterMinor as number));
      contributing = ordered.filter((row) => row.balanceAfterMinor === value);
    }
    contributions.push(...contributing);
    breakdown.push({
      key: accountId,
      label: ordered[0]?.accountName ?? accountId,
      value,
      transactionIds: ids(contributing),
    });
  }
  return available(
    breakdown.reduce((total, item) => total + item.value, 0),
    contributions,
    breakdown,
  );
}

function metric(
  metricDefinition: AnalyticsMetricDefinition,
  calculate: MetricRegistration["calculate"],
): MetricRegistration {
  return { definition: metricDefinition, calculate };
}

const REGISTRY: MetricRegistration[] = [
  metric(
    definition(
      "cashflow.total_inflow",
      "Total inflow",
      "All credits into the selected accounts, excluding confirmed internal transfers by default.",
      "minor_units",
    ),
    (context) => {
      const rows = movementRows(context).filter((row) => row.direction === "credit");
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "cashflow.total_outflow",
      "Total outflow",
      "All debits from the selected accounts, excluding confirmed internal transfers by default.",
      "minor_units",
    ),
    (context) => {
      const rows = movementRows(context).filter((row) => row.direction === "debit");
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "cashflow.net",
      "Net cash flow",
      "Total inflow minus total outflow for the selected period.",
      "minor_units",
    ),
    (context) => {
      const rows = movementRows(context);
      const value = rows.reduce(
        (total, row) => total + (row.direction === "credit" ? row.amountMinor : -row.amountMinor),
        0,
      );
      return available(value, rows);
    },
  ),
  metric(
    definition(
      "cashflow.average_inflow",
      "Average inflow",
      "Mean value of credit transactions in the selected period.",
      "minor_units",
    ),
    (context) => {
      const rows = uniqueTransactions(
        movementRows(context).filter((row) => row.direction === "credit"),
      );
      return available(roundedAverage(rows.map((row) => row.amountMinor)), rows);
    },
  ),
  metric(
    definition(
      "cashflow.average_outflow",
      "Average outflow",
      "Mean value of debit transactions in the selected period.",
      "minor_units",
    ),
    (context) => {
      const rows = uniqueTransactions(
        movementRows(context).filter((row) => row.direction === "debit"),
      );
      return available(roundedAverage(rows.map((row) => row.amountMinor)), rows);
    },
  ),
  metric(
    definition(
      "cashflow.median_transaction",
      "Median transaction",
      "Median transaction amount across inflows and outflows.",
      "minor_units",
    ),
    (context) => {
      const rows = uniqueTransactions(movementRows(context));
      return available(median(rows.map((row) => row.amountMinor)), rows);
    },
  ),
  metric(
    definition(
      "cashflow.largest_inflow",
      "Largest inflow",
      "Largest individual credit in the period.",
      "minor_units",
      ["transaction"],
    ),
    (context) => {
      const rows = uniqueTransactions(
        movementRows(context).filter((row) => row.direction === "credit"),
      );
      const value = Math.max(0, ...rows.map((row) => row.amountMinor));
      const contributors = rows.filter((row) => row.amountMinor === value);
      return available(value, contributors);
    },
  ),
  metric(
    definition(
      "cashflow.largest_outflow",
      "Largest outflow",
      "Largest individual debit in the period.",
      "minor_units",
      ["transaction"],
    ),
    (context) => {
      const rows = uniqueTransactions(
        movementRows(context).filter((row) => row.direction === "debit"),
      );
      const value = Math.max(0, ...rows.map((row) => row.amountMinor));
      const contributors = rows.filter((row) => row.amountMinor === value);
      return available(value, contributors);
    },
  ),
  metric(
    definition(
      "cashflow.inflow_outflow_ratio",
      "Inflow to outflow ratio",
      "Total inflow divided by total outflow.",
      "ratio",
    ),
    (context) => {
      const rows = movementRows(context);
      const inflow = sum(rows.filter((row) => row.direction === "credit"));
      const outflow = sum(rows.filter((row) => row.direction === "debit"));
      return outflow === 0
        ? unavailable("The ratio is unavailable because total outflow is zero.")
        : available(inflow / outflow, rows);
    },
  ),
  metric(
    definition(
      "cashflow.cumulative",
      "Cumulative cash flow",
      "Running net movement grouped by local calendar day.",
      "minor_units",
      ["day"],
    ),
    (context) => {
      const rows = movementRows(context);
      const daily = grouped(
        rows,
        (row) => localDate(context, row.occurredAt),
        (row) => localDate(context, row.occurredAt),
        (group) =>
          group.reduce(
            (total, row) =>
              total + (row.direction === "credit" ? row.amountMinor : -row.amountMinor),
            0,
          ),
      ).sort((left, right) => left.key.localeCompare(right.key));
      let cumulative = 0;
      const breakdown = daily.map((item) => {
        cumulative += item.value;
        return { ...item, value: cumulative };
      });
      return available(cumulative, rows, breakdown);
    },
  ),
  metric(
    definition(
      "cashflow.transaction_count",
      "Transaction count",
      "Number of distinct cash movements in the selected period.",
      "count",
    ),
    (context) => {
      const rows = uniqueTransactions(movementRows(context));
      return available(rows.length, rows);
    },
  ),
  metric(
    definition(
      "spending.by_category",
      "Spending by category",
      "Expense allocations grouped by category; active split allocations replace the parent category.",
      "minor_units",
      ["category"],
      ["amount", "direction", "category", "split allocations"],
    ),
    (context) => {
      const rows = spendingRows(context);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => row.categoryId ?? "unclassified",
          (row) => row.categoryName ?? "Unclassified",
        ),
      );
    },
  ),
  metric(
    definition(
      "spending.by_counterparty",
      "Spending by counterparty",
      "Expense allocations grouped by identified recipient or merchant.",
      "minor_units",
      ["counterparty"],
      ["amount", "direction", "counterparty"],
    ),
    (context) => {
      const rows = spendingRows(context);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => row.counterpartyId ?? "unidentified",
          (row) => row.counterpartyName ?? "Unidentified",
        ),
      );
    },
  ),
  metric(
    definition(
      "spending.fees",
      "Fees",
      "Debits classified as fees or assigned to a fee category.",
      "minor_units",
      ["transaction"],
      ["amount", "direction", "transactionType", "category"],
    ),
    (context) => {
      const rows = spendingRows(context).filter(
        (row) => row.transactionType === "fee" || row.categoryIsFee,
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "spending.cash_withdrawals",
      "Cash withdrawals",
      "Debits classified as cash withdrawals or assigned to a withdrawal category.",
      "minor_units",
      ["transaction"],
      ["amount", "direction", "transactionType", "category"],
    ),
    (context) => {
      const rows = spendingRows(context).filter(
        (row) => row.transactionType === "cash_withdrawal" || row.categoryIsCashWithdrawal,
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "spending.recurring",
      "Recurring spending",
      "Spending patterns with at least three matching payments on weekly, fortnightly, or monthly cadence.",
      "minor_units",
      ["counterparty", "transaction"],
      ["amount", "occurredAt", "counterparty", "narration"],
    ),
    (context) => recurringMetric(spendingRows(context)),
  ),
  metric(
    definition(
      "spending.by_weekday",
      "Spending by weekday",
      "Expense allocations grouped by weekday in the workspace timezone.",
      "minor_units",
      ["weekday"],
    ),
    (context) => {
      const rows = spendingRows(context);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => weekday(context, row.occurredAt).key,
          (row) => weekday(context, row.occurredAt).label,
        ).sort((left, right) => Number(left.key) - Number(right.key)),
      );
    },
  ),
  metric(
    definition(
      "spending.concentration",
      "Spending concentration",
      "Share of spending attributable to the three largest counterparties.",
      "basis_points",
      ["counterparty"],
      ["amount", "counterparty"],
    ),
    (context) => {
      const rows = spendingRows(context);
      const breakdown = grouped(
        rows,
        (row) => row.counterpartyId ?? "unidentified",
        (row) => row.counterpartyName ?? "Unidentified",
      );
      return available(
        basisPoints(
          breakdown.slice(0, 3).reduce((total, item) => total + item.value, 0),
          sum(rows),
        ) ?? 0,
        rows,
        breakdown,
      );
    },
  ),
  metric(
    definition(
      "spending.unusual",
      "Unusual spending",
      "Expenses above the upper Tukey fence (Q3 + 1.5 × interquartile range).",
      "minor_units",
      ["transaction"],
    ),
    (context) => {
      const rows = unusualRows(spendingRows(context));
      return available(
        sum(rows),
        rows,
        rows
          .map((row) => ({
            key: row.transactionId,
            label: row.narration ?? row.counterpartyName ?? "Unusual transaction",
            value: row.amountMinor,
            transactionIds: [row.transactionId],
          }))
          .sort((left, right) => right.value - left.value),
      );
    },
  ),
  metric(
    definition(
      "income.by_source",
      "Income by source",
      "Income credits grouped by identified sender or source.",
      "minor_units",
      ["counterparty"],
      ["amount", "direction", "transactionType", "counterparty"],
    ),
    (context) => {
      const rows = incomeRows(context);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => row.counterpartyId ?? "unidentified",
          (row) => row.counterpartyName ?? "Unidentified",
        ),
      );
    },
  ),
  metric(
    definition(
      "income.recurring",
      "Recurring income",
      "Income patterns with at least three matching credits on weekly, fortnightly, or monthly cadence.",
      "minor_units",
      ["counterparty", "transaction"],
      ["amount", "occurredAt", "counterparty", "narration"],
    ),
    (context) => recurringMetric(incomeRows(context)),
  ),
  metric(
    definition(
      "income.by_weekday",
      "Income by weekday",
      "Income credits grouped by weekday in the workspace timezone.",
      "minor_units",
      ["weekday"],
    ),
    (context) => {
      const rows = incomeRows(context);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => weekday(context, row.occurredAt).key,
          (row) => weekday(context, row.occurredAt).label,
        ).sort((left, right) => Number(left.key) - Number(right.key)),
      );
    },
  ),
  metric(
    definition(
      "income.concentration",
      "Income concentration",
      "Share of income attributable to the three largest sources.",
      "basis_points",
      ["counterparty"],
      ["amount", "counterparty"],
    ),
    (context) => {
      const rows = incomeRows(context);
      const breakdown = grouped(
        rows,
        (row) => row.counterpartyId ?? "unidentified",
        (row) => row.counterpartyName ?? "Unidentified",
      );
      return available(
        basisPoints(
          breakdown.slice(0, 3).reduce((total, item) => total + item.value, 0),
          sum(rows),
        ) ?? 0,
        rows,
        breakdown,
      );
    },
  ),
  metric(
    definition(
      "income.variability",
      "Income variability",
      "Coefficient of variation of monthly income totals, expressed in basis points.",
      "basis_points",
      ["day"],
      ["amount", "occurredAt", "transactionType"],
    ),
    (context) => {
      const rows = incomeRows(context);
      if (rows.length === 0) return unavailable("Income variability needs at least one income.");
      const months = grouped(
        rows,
        (row) => localDate(context, row.occurredAt).slice(0, 7),
        (row) => localDate(context, row.occurredAt).slice(0, 7),
      );
      const mean = months.reduce((total, item) => total + item.value, 0) / months.length;
      const variance =
        months.reduce((total, item) => total + (item.value - mean) ** 2, 0) / months.length;
      const coefficient = mean === 0 ? 0 : Math.round((Math.sqrt(variance) / mean) * 10_000);
      return available(coefficient, rows, months);
    },
  ),
  metric(
    definition(
      "savings.estimated_rate",
      "Estimated savings rate",
      "Income minus classified spending as a share of income; transfers and refunds are excluded.",
      "basis_points",
      ["total"],
      ["amount", "direction", "transactionType"],
    ),
    (context) => {
      const incomes = incomeRows(context);
      const spending = spendingRows(context);
      const income = sum(incomes);
      if (income === 0) {
        return unavailable("A savings-rate estimate needs classified income in the period.");
      }
      return available(Math.round(((income - sum(spending)) / income) * 10_000), [
        ...incomes,
        ...spending,
      ]);
    },
  ),
  metric(
    definition(
      "spending.essential",
      "Essential spending",
      "Expense allocations assigned to categories marked essential.",
      "minor_units",
      ["category"],
      ["amount", "category.isEssential"],
    ),
    (context) => {
      const rows = spendingRows(context).filter((row) => row.categoryIsEssential);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => row.categoryId ?? "unclassified",
          (row) => row.categoryName ?? "Unclassified",
        ),
      );
    },
  ),
  metric(
    definition(
      "spending.discretionary",
      "Discretionary spending",
      "Expense allocations assigned to categories marked discretionary.",
      "minor_units",
      ["category"],
      ["amount", "category.isDiscretionary"],
    ),
    (context) => {
      const rows = spendingRows(context).filter((row) => row.categoryIsDiscretionary);
      return available(
        sum(rows),
        rows,
        grouped(
          rows,
          (row) => row.categoryId ?? "unclassified",
          (row) => row.categoryName ?? "Unclassified",
        ),
      );
    },
  ),
  metric(
    definition(
      "behaviour.no_spend_days",
      "No-spend days",
      "Calendar days with no classified spending in the selected accounts and scopes.",
      "days",
      ["day"],
      ["occurredAt", "direction", "transactionType"],
    ),
    (context) => {
      const rows = spendingRows(context);
      const spendingDays = new Set(rows.map((row) => localDate(context, row.occurredAt)));
      const totalDays = Math.round((context.endAt - context.startAt) / DAY_MS);
      return available(Math.max(0, totalDays - spendingDays.size), rows);
    },
  ),
  metric(
    definition(
      "behaviour.activity_by_weekday",
      "Activity by weekday",
      "Distinct transactions grouped by weekday in the workspace timezone.",
      "count",
      ["weekday"],
      ["occurredAt"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations);
      return available(
        rows.length,
        rows,
        grouped(
          rows,
          (row) => weekday(context, row.occurredAt).key,
          (row) => weekday(context, row.occurredAt).label,
          (group) => uniqueTransactions(group).length,
        ).sort((left, right) => Number(left.key) - Number(right.key)),
      );
    },
  ),
  metric(
    definition(
      "behaviour.weekend_share",
      "Weekend activity share",
      "Share of distinct transactions occurring on Saturday or Sunday.",
      "basis_points",
      ["weekday"],
      ["occurredAt"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations);
      const weekends = rows.filter((row) =>
        ["0", "6"].includes(weekday(context, row.occurredAt).key),
      );
      return available(basisPoints(weekends.length, rows.length) ?? 0, rows);
    },
  ),
  metric(
    definition(
      "behaviour.change",
      "Spending behaviour change",
      "Current classified spending; the attached period comparison quantifies the change.",
      "minor_units",
      ["total"],
    ),
    (context) => {
      const rows = spendingRows(context);
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "quality.classification_coverage",
      "Classification coverage",
      "Share of distinct transactions with a non-unclassified type or category.",
      "basis_points",
      ["total"],
      ["transactionType", "category"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations);
      const classified = rows.filter(
        (row) => row.transactionType !== "unclassified" || row.categoryId !== null,
      );
      return available(basisPoints(classified.length, rows.length) ?? 0, rows);
    },
  ),
  metric(
    definition(
      "quality.confidence_distribution",
      "Classification confidence",
      "Distinct transactions grouped by current confidence level.",
      "count",
      ["confidence"],
      ["confidence"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations);
      return available(
        rows.length,
        rows,
        grouped(
          rows,
          (row) => row.confidence,
          (row) => row.confidence[0]?.toUpperCase() + row.confidence.slice(1),
          (group) => uniqueTransactions(group).length,
        ),
      );
    },
  ),
  metric(
    definition(
      "quality.review_queue",
      "Needs review",
      "Number of distinct transactions currently marked as needing review.",
      "count",
      ["review_state"],
      ["reviewState"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations).filter(
        (row) => row.reviewState === "needs_review",
      );
      return available(rows.length, rows);
    },
  ),
  metric(
    definition(
      "quality.reconciliation",
      "Reconciliation quality",
      "Imported transactions grouped by matched, mismatched, or unknown statement reconciliation.",
      "count",
      ["reconciliation_status"],
      ["import reconciliation"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations);
      return available(
        rows.length,
        rows,
        grouped(
          rows,
          (row) => row.reconciliationStatus,
          (row) => row.reconciliationStatus[0]?.toUpperCase() + row.reconciliationStatus.slice(1),
          (group) => uniqueTransactions(group).length,
        ),
      );
    },
  ),
  metric(
    definition(
      "quality.duplicate_sources",
      "Duplicate source rows",
      "Source rows linked as duplicates of existing canonical transactions.",
      "count",
      ["transaction"],
      ["transaction source link"],
    ),
    (context) => {
      const rows = uniqueTransactions(context.allocations).filter(
        (row) => row.duplicateSourceCount > 0,
      );
      return available(
        rows.reduce((total, row) => total + row.duplicateSourceCount, 0),
        rows,
        rows.map((row) => ({
          key: row.transactionId,
          label: row.narration ?? "Canonical transaction",
          value: row.duplicateSourceCount,
          transactionIds: [row.transactionId],
        })),
      );
    },
  ),
  metric(
    definition(
      "adjustments.refunds",
      "Refunds",
      "Refund credits excluding narrations explicitly identified as reversals.",
      "minor_units",
      ["transaction"],
      ["amount", "transactionType", "category"],
    ),
    (context) => {
      const rows = context.allocations.filter(
        (row) => row.direction === "credit" && isRefund(row) && !isReversal(row),
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "adjustments.reversals",
      "Reversals",
      "Refund-classified credits whose narration explicitly indicates a reversal.",
      "minor_units",
      ["transaction"],
      ["amount", "transactionType", "category", "narration"],
    ),
    (context) => {
      const rows = context.allocations.filter(
        (row) => row.direction === "credit" && isReversal(row),
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "transfers.internal",
      "Internal transfer volume",
      "Confirmed transfers between owned accounts, counted once on the debit side.",
      "minor_units",
      ["transaction"],
      ["amount", "direction", "transfer pairing"],
    ),
    (context) => {
      const rows = context.allocations.filter(
        (row) => row.internalTransfer && row.direction === "debit",
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "transfers.external",
      "External transfer movement",
      "Transfer-classified movements not confirmed as transfers between owned accounts.",
      "minor_units",
      ["transaction"],
      ["amount", "transactionType", "transfer pairing"],
    ),
    (context) => {
      const rows = context.allocations.filter(
        (row) => row.transactionType === "transfer" && !row.internalTransfer,
      );
      return available(sum(rows), rows);
    },
  ),
  metric(
    definition(
      "balance.opening",
      "Opening balance",
      "Balance immediately before the first selected transaction, when running balances are available.",
      "minor_units",
      ["total"],
      ["balanceAfter", "amount", "direction"],
    ),
    (context) => balanceMetric(context, "opening"),
  ),
  metric(
    definition(
      "balance.closing",
      "Closing balance",
      "Latest running balance in the selected period, when available for every account.",
      "minor_units",
      ["total"],
      ["balanceAfter"],
    ),
    (context) => balanceMetric(context, "closing"),
  ),
  metric(
    definition(
      "balance.lowest",
      "Lowest balance",
      "Lowest running balance for a single selected account.",
      "minor_units",
      ["transaction"],
      ["balanceAfter"],
    ),
    (context) => balanceMetric(context, "lowest"),
  ),
  metric(
    definition(
      "balance.highest",
      "Highest balance",
      "Highest running balance for a single selected account.",
      "minor_units",
      ["transaction"],
      ["balanceAfter"],
    ),
    (context) => balanceMetric(context, "highest"),
  ),
];

const REGISTRY_BY_ID = new Map(
  REGISTRY.map((registration) => [registration.definition.id, registration]),
);

export const analyticsMetricRegistry: readonly AnalyticsMetricDefinition[] = REGISTRY.map(
  ({ definition: metricDefinition }) => Object.freeze({ ...metricDefinition }),
);

export class AnalyticsEngine {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  registry(): AnalyticsMetricDefinition[] {
    return analyticsMetricRegistry.map((item) => ({
      ...item,
      requiredFields: [...item.requiredFields],
      supportedDimensions: [...item.supportedDimensions],
    }));
  }

  query(workspaceId: string, input: unknown): AnalyticsResult {
    let query: AnalyticsQuery;
    try {
      query = AnalyticsQuerySchema.parse(input);
    } catch (error) {
      throw new AnalyticsError(
        "ANALYTICS_QUERY_INVALID",
        error instanceof Error ? error.message : "The analytics query is invalid.",
      );
    }

    const sqlite = this.#sqlite();
    const timeZone = this.#workspaceTimeZone(sqlite, workspaceId);
    this.#assertAccounts(sqlite, workspaceId, query.accountIds);
    this.#consumeInvalidations(sqlite, workspaceId);
    const metricIds = query.metricIds ?? AnalyticsMetricIdSchema.options;
    const queryHash = this.#queryHash(query, metricIds);

    if (query.useCache) {
      const cached = sqlite
        .prepare(
          `SELECT response
             FROM analytics_metric_cache
            WHERE workspace_id = ? AND query_hash = ?`,
        )
        .get(workspaceId, queryHash) as { response: string } | undefined;
      if (cached) {
        const response = AnalyticsResultSchema.parse(JSON.parse(cached.response));
        return { ...response, cache: { ...response.cache, hit: true } };
      }
    }

    const current = this.#context(sqlite, workspaceId, timeZone, query);
    const comparisonRange = comparisonDates(query);
    const previous = comparisonRange
      ? this.#context(sqlite, workspaceId, timeZone, {
          ...query,
          startDate: comparisonRange.startDate,
          endDate: comparisonRange.endDate,
          comparison: { mode: "none" },
          useCache: false,
        })
      : null;

    const metrics = metricIds.map((id): AnalyticsMetricResult => {
      const registration = REGISTRY_BY_ID.get(id);
      if (!registration) {
        throw new AnalyticsError("ANALYTICS_QUERY_INVALID", `Unknown analytics metric: ${id}.`);
      }
      const calculated = registration.calculate(current);
      const previousCalculated = previous ? registration.calculate(previous) : null;
      const comparison =
        calculated.status === "available" &&
        calculated.value !== null &&
        previousCalculated?.status === "available" &&
        previousCalculated.value !== null &&
        comparisonRange
          ? {
              startDate: comparisonRange.startDate,
              endDate: comparisonRange.endDate,
              value: previousCalculated.value,
              absoluteChange: calculated.value - previousCalculated.value,
              percentageChange:
                previousCalculated.value === 0
                  ? null
                  : round(
                      ((calculated.value - previousCalculated.value) /
                        Math.abs(previousCalculated.value)) *
                        100,
                      2,
                    ),
              transactionIds: previousCalculated.transactionIds,
            }
          : null;
      return {
        id,
        title: registration.definition.title,
        definition: registration.definition.definition,
        unit: registration.definition.unit,
        ...calculated,
        comparison,
      };
    });

    const calculatedAt = new Date(this.#clock()).toISOString();
    const response = AnalyticsResultSchema.parse({
      query: {
        startDate: query.startDate,
        endDate: query.endDate,
        currency: query.currency,
        accountIds: query.accountIds,
        scopes: query.scopes,
        excludeInternalTransfers: query.excludeInternalTransfers,
      },
      metrics,
      cache: { hit: false, calculatedAt },
    });

    if (query.useCache) {
      sqlite
        .prepare(
          `INSERT INTO analytics_metric_cache (
             id, workspace_id, query_hash, start_at, end_at, currency,
             account_ids, scopes, response, calculated_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, query_hash) DO UPDATE SET
             response = excluded.response,
             calculated_at = excluded.calculated_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          randomUUID(),
          workspaceId,
          queryHash,
          current.startAt,
          current.endAt,
          query.currency,
          JSON.stringify(query.accountIds),
          JSON.stringify(query.scopes),
          JSON.stringify(response),
          Date.parse(calculatedAt),
          Date.parse(calculatedAt),
          Date.parse(calculatedAt),
        );
    }
    return response;
  }

  #workspaceTimeZone(sqlite: Database.Database, workspaceId: string): string {
    const row = sqlite.prepare("SELECT timezone FROM workspaces WHERE id = ?").get(workspaceId) as
      | { timezone: string }
      | undefined;
    if (!row) {
      throw new AnalyticsError("ANALYTICS_QUERY_INVALID", "The workspace was not found.");
    }
    return row.timezone;
  }

  #assertAccounts(
    sqlite: Database.Database,
    workspaceId: string,
    accountIds: readonly string[],
  ): void {
    const placeholders = accountIds.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT id FROM accounts
          WHERE workspace_id = ? AND id IN (${placeholders})`,
      )
      .all(workspaceId, ...accountIds) as Array<{ id: string }>;
    if (rows.length !== accountIds.length) {
      throw new AnalyticsError(
        "ANALYTICS_ACCOUNT_NOT_FOUND",
        "One or more selected accounts do not belong to this workspace.",
      );
    }
  }

  #context(
    sqlite: Database.Database,
    workspaceId: string,
    timeZone: string,
    query: AnalyticsQuery,
  ): PeriodContext {
    const range = localDateRangeToUtc(query.startDate, query.endDate, timeZone);
    const accountPlaceholders = query.accountIds.map(() => "?").join(",");
    const scopePlaceholders = query.scopes.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT
           t.id AS transaction_id,
           t.account_id,
           a.display_name AS account_name,
           t.occurred_at_utc,
           t.direction,
           t.transaction_type,
           COALESCE(s.amount_minor, t.amount_minor) AS amount_minor,
           COALESCE(s.scope, t.scope) AS scope,
           COALESCE(sc.id, pc.id) AS category_id,
           COALESCE(sc.name, pc.name) AS category_name,
           t.counterparty_id,
           cp.display_name AS counterparty_name,
           t.normalized_narration,
           t.confidence_level,
           t.review_state,
           t.transfer_pairing_status,
           t.paired_transaction_id,
           COALESCE(sc.is_income, pc.is_income, 0) AS is_income,
           COALESCE(sc.is_expense, pc.is_expense, 0) AS is_expense,
           COALESCE(sc.is_essential, pc.is_essential, 0) AS is_essential,
           COALESCE(sc.is_discretionary, pc.is_discretionary, 0) AS is_discretionary,
           COALESCE(sc.is_refund, pc.is_refund, 0) AS is_refund,
           COALESCE(sc.is_fee, pc.is_fee, 0) AS is_fee,
           COALESCE(sc.is_cash_withdrawal, pc.is_cash_withdrawal, 0) AS is_cash_withdrawal,
           (
             SELECT count(*)
               FROM transaction_sources duplicate_source
              WHERE duplicate_source.transaction_id = t.id
                AND duplicate_source.link_type = 'duplicate'
           ) AS duplicate_source_count,
           CASE
             WHEN EXISTS (
               SELECT 1
                 FROM transaction_sources source
                 JOIN import_batches batch ON batch.id = source.import_batch_id
                WHERE source.transaction_id = t.id
                  AND batch.reconciliation_status = 'mismatched'
             ) THEN 'mismatched'
             WHEN EXISTS (
               SELECT 1
                 FROM transaction_sources source
                 JOIN import_batches batch ON batch.id = source.import_batch_id
                WHERE source.transaction_id = t.id
                  AND batch.reconciliation_status = 'matched'
             ) THEN 'matched'
             ELSE 'unknown'
           END AS reconciliation_status,
           (
             SELECT parsed.balance_after_minor
               FROM transaction_sources balance_source
               JOIN parsed_source_rows parsed ON parsed.id = balance_source.parsed_source_row_id
              WHERE balance_source.transaction_id = t.id
                AND parsed.balance_after_minor IS NOT NULL
              ORDER BY CASE balance_source.link_type WHEN 'original' THEN 0 ELSE 1 END,
                       parsed.source_row_index
              LIMIT 1
           ) AS balance_after_minor
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN transaction_split_sets split_set
           ON split_set.transaction_id = t.id AND split_set.status = 'active'
         LEFT JOIN transaction_splits s ON s.split_set_id = split_set.id
         LEFT JOIN categories sc ON sc.id = s.category_id
         LEFT JOIN categories pc ON pc.id = t.category_id
         LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
        WHERE t.workspace_id = ?
          AND t.account_id IN (${accountPlaceholders})
          AND t.currency = ?
          AND t.occurred_at_utc >= ?
          AND t.occurred_at_utc < ?
          AND COALESCE(s.scope, t.scope) IN (${scopePlaceholders})
        ORDER BY t.occurred_at_utc, t.id, COALESCE(s.sort_order, 0)`,
      )
      .all(
        workspaceId,
        ...query.accountIds,
        query.currency,
        range.startUtc.getTime(),
        range.endUtcExclusive.getTime(),
        ...query.scopes,
      ) as AllocationRow[];

    return {
      startDate: query.startDate,
      endDate: query.endDate,
      startAt: range.startUtc.getTime(),
      endAt: range.endUtcExclusive.getTime(),
      timeZone,
      query,
      allocations: rows.map((row) => ({
        transactionId: row.transaction_id,
        accountId: row.account_id,
        accountName: row.account_name,
        occurredAt: row.occurred_at_utc,
        direction: row.direction,
        transactionType: row.transaction_type,
        amountMinor: row.amount_minor,
        scope: row.scope,
        categoryId: row.category_id,
        categoryName: row.category_name,
        counterpartyId: row.counterparty_id,
        counterpartyName: row.counterparty_name,
        narration: row.normalized_narration,
        confidence: row.confidence_level,
        reviewState: row.review_state,
        internalTransfer:
          row.transfer_pairing_status === "confirmed" && row.paired_transaction_id !== null,
        categoryIsIncome: row.is_income === 1,
        categoryIsExpense: row.is_expense === 1,
        categoryIsEssential: row.is_essential === 1,
        categoryIsDiscretionary: row.is_discretionary === 1,
        categoryIsRefund: row.is_refund === 1,
        categoryIsFee: row.is_fee === 1,
        categoryIsCashWithdrawal: row.is_cash_withdrawal === 1,
        duplicateSourceCount: row.duplicate_source_count,
        reconciliationStatus: row.reconciliation_status,
        balanceAfterMinor: row.balance_after_minor,
      })),
    };
  }

  #queryHash(query: AnalyticsQuery, metricIds: readonly AnalyticsMetricId[]): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          ...query,
          metricIds,
          useCache: undefined,
        }),
      )
      .digest("hex");
  }

  #consumeInvalidations(sqlite: Database.Database, workspaceId: string): void {
    const pending = sqlite
      .prepare(
        `SELECT id, start_at, end_at
           FROM metric_invalidations
          WHERE workspace_id = ? AND consumed_at IS NULL
          ORDER BY created_at, id`,
      )
      .all(workspaceId) as Array<{
      id: string;
      start_at: number | null;
      end_at: number | null;
    }>;
    if (pending.length === 0) return;

    sqlite.transaction(() => {
      for (const invalidation of pending) {
        if (invalidation.start_at === null || invalidation.end_at === null) {
          sqlite
            .prepare("DELETE FROM analytics_metric_cache WHERE workspace_id = ?")
            .run(workspaceId);
        } else {
          sqlite
            .prepare(
              `DELETE FROM analytics_metric_cache
                WHERE workspace_id = ?
                  AND start_at <= ?
                  AND end_at > ?`,
            )
            .run(workspaceId, invalidation.end_at, invalidation.start_at);
        }
        sqlite
          .prepare("UPDATE metric_invalidations SET consumed_at = ? WHERE id = ?")
          .run(this.#clock(), invalidation.id);
      }
    })();
  }
}

function comparisonDates(query: AnalyticsQuery): { startDate: string; endDate: string } | null {
  if (query.comparison.mode === "none") return null;
  if (query.comparison.mode === "custom") {
    return {
      startDate: query.comparison.startDate,
      endDate: query.comparison.endDate,
    };
  }
  const start = Date.parse(`${query.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${query.endDate}T00:00:00.000Z`);
  const dayCount = Math.round((end - start) / DAY_MS) + 1;
  return {
    startDate: isoDate(start - dayCount * DAY_MS),
    endDate: isoDate(start - DAY_MS),
  };
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
