import {
  AnalyticsMetricIdSchema,
  type AnalyticsMetricResult,
  type AnalyticsResult,
  type AnalyticsBreakdownItem,
  type Transaction,
  type TransactionScope,
} from "@spendlens/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { DashboardFiltersValue } from "@/components/dashboard-filters";

export type InsightPath = "/spending" | "/income" | "/cash-flow" | "/behaviour";
export type TrendGrain = "day" | "week" | "month" | "quarter" | "year";

export interface InsightRouteSearch {
  start?: string | undefined;
  end?: string | undefined;
  currency?: string | undefined;
  accounts?: string | undefined;
  scope?: "all" | TransactionScope | undefined;
  compare?: "previous" | "custom" | "none" | undefined;
  compareStart?: string | undefined;
  compareEnd?: string | undefined;
  grain?: TrendGrain | undefined;
  metric?: string | undefined;
  segment?: string | undefined;
  transaction?: string | undefined;
}

export function parseInsightSearch(
  search: Record<string, unknown> | InsightRouteSearch,
): InsightRouteSearch {
  const metric = textValue(search.metric);
  return {
    ...(dateValue(search.start) ? { start: dateValue(search.start) } : {}),
    ...(dateValue(search.end) ? { end: dateValue(search.end) } : {}),
    ...(currencyValue(search.currency) ? { currency: currencyValue(search.currency) } : {}),
    ...(idListValue(search.accounts) ? { accounts: idListValue(search.accounts) } : {}),
    ...(oneOf(search.scope, ["all", "personal", "business"])
      ? { scope: search.scope as InsightRouteSearch["scope"] }
      : {}),
    ...(oneOf(search.compare, ["previous", "custom", "none"])
      ? { compare: search.compare as InsightRouteSearch["compare"] }
      : {}),
    ...(dateValue(search.compareStart) ? { compareStart: dateValue(search.compareStart) } : {}),
    ...(dateValue(search.compareEnd) ? { compareEnd: dateValue(search.compareEnd) } : {}),
    ...(oneOf(search.grain, ["day", "week", "month", "quarter", "year"])
      ? { grain: search.grain as TrendGrain }
      : {}),
    ...(metric && AnalyticsMetricIdSchema.safeParse(metric).success ? { metric } : {}),
    ...(textValue(search.segment) ? { segment: textValue(search.segment) } : {}),
    ...(uuidValue(search.transaction) ? { transaction: uuidValue(search.transaction) } : {}),
  };
}

export function filtersFromInsightSearch(
  search: InsightRouteSearch,
  fallback: DashboardFiltersValue,
  allowedAccountIds: readonly string[],
): DashboardFiltersValue {
  const requestedAccounts = search.accounts?.split(",") ?? [];
  const accountIds = requestedAccounts.filter((id) => allowedAccountIds.includes(id));
  const comparison =
    search.compare === "none"
      ? ({ mode: "none" } as const)
      : search.compare === "custom" &&
          search.compareStart &&
          search.compareEnd &&
          search.compareStart <= search.compareEnd
        ? ({
            mode: "custom",
            startDate: search.compareStart,
            endDate: search.compareEnd,
          } as const)
        : ({ mode: "previous_period" } as const);

  return {
    startDate: search.start ?? fallback.startDate,
    endDate: search.end ?? fallback.endDate,
    currency: search.currency ?? fallback.currency,
    accountIds: accountIds.length > 0 ? accountIds : fallback.accountIds,
    scopes:
      search.scope === "personal" || search.scope === "business" ? [search.scope] : fallback.scopes,
    comparison,
  };
}

export function insightSearchFromFilters(
  filters: DashboardFiltersValue,
  extras: Pick<InsightRouteSearch, "grain" | "metric" | "segment" | "transaction"> = {},
): InsightRouteSearch {
  return {
    start: filters.startDate,
    end: filters.endDate,
    currency: filters.currency,
    accounts: [...filters.accountIds].sort().join(","),
    scope: filters.scopes.length === 2 ? "all" : (filters.scopes[0] ?? "all"),
    compare: filters.comparison.mode === "previous_period" ? "previous" : filters.comparison.mode,
    ...(filters.comparison.mode === "custom"
      ? {
          compareStart: filters.comparison.startDate,
          compareEnd: filters.comparison.endDate,
        }
      : {}),
    grain: extras.grain ?? "month",
    ...(extras.metric ? { metric: extras.metric } : {}),
    ...(extras.segment ? { segment: extras.segment } : {}),
    ...(extras.transaction ? { transaction: extras.transaction } : {}),
  };
}

export function contributionIds(
  result: AnalyticsResult,
  metricId?: string,
  segmentKey?: string,
  grain: TrendGrain = "day",
): string[] {
  if (!metricId) return [];
  const metric = result.metrics.find((item) => item.id === metricId);
  if (!metric) return [];
  if (!segmentKey) return metric.transactionIds;
  const breakdown = metric.id.endsWith(".by_day")
    ? aggregateDailyBreakdown(metric.breakdown, grain)
    : metric.breakdown;
  return breakdown.find((item) => item.key === segmentKey)?.transactionIds ?? [];
}

export function aggregateDailyBreakdown(
  items: readonly AnalyticsBreakdownItem[],
  grain: TrendGrain,
): AnalyticsBreakdownItem[] {
  if (grain === "day") return [...items];
  const groups = new Map<string, AnalyticsBreakdownItem>();
  for (const item of items) {
    const group = dateGroup(item.key, grain);
    if (!group) continue;
    const existing = groups.get(group.key);
    groups.set(group.key, {
      key: group.key,
      label: group.label,
      value: (existing?.value ?? 0) + item.value,
      transactionIds: [
        ...new Set([...(existing?.transactionIds ?? []), ...item.transactionIds]),
      ].sort(),
    });
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function metricValue(metric: AnalyticsMetricResult, currency: string): string {
  if (metric.status === "unavailable" || metric.value === null) return "Unavailable";
  if (metric.unit === "minor_units") {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2,
    }).format(metric.value / 100);
  }
  if (metric.unit === "basis_points") {
    return `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 }).format(metric.value / 100)}%`;
  }
  if (metric.unit === "ratio") {
    return `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 }).format(metric.value)}×`;
  }
  return `${new Intl.NumberFormat("en-NG").format(metric.value)}${metric.unit === "days" ? " days" : ""}`;
}

export function transactionsToCsv(transactions: readonly Transaction[]): string {
  const header = [
    "date",
    "description",
    "counterparty",
    "category",
    "type",
    "direction",
    "amount_minor",
    "currency",
    "scope",
    "review_state",
    "account",
    "source_reference",
  ];
  const rows = transactions.map((transaction) => [
    transaction.occurredAt,
    transaction.normalizedNarration ?? transaction.source.rawNarration ?? "",
    transaction.counterparty?.displayName ?? "",
    transaction.category?.name ?? "Unclassified",
    transaction.transactionType,
    transaction.direction,
    String(transaction.amountMinor),
    transaction.currency,
    transaction.scope,
    transaction.reviewState,
    transaction.account.displayName,
    transaction.sourceReference ?? "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export async function refreshAfterInsightCorrection(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["analytics"] }),
    queryClient.invalidateQueries({ queryKey: ["transactions"] }),
    queryClient.invalidateQueries({ queryKey: ["classification-review"] }),
  ]);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function dateGroup(
  value: string,
  grain: Exclude<TrendGrain, "day">,
): { key: string; label: string } | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (grain === "year") return { key: String(year), label: String(year) };
  if (grain === "quarter") {
    const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
    return { key: `${year}-Q${quarter}`, label: `Q${quarter} ${year}` };
  }
  if (grain === "month") {
    const key = value.slice(0, 7);
    return {
      key,
      label: new Intl.DateTimeFormat("en-NG", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    };
  }
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + mondayOffset);
  const key = monday.toISOString().slice(0, 10);
  return {
    key,
    label: `Week of ${new Intl.DateTimeFormat("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(monday)}`,
  };
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function dateValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function currencyValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text && /^[A-Z]{3}$/.test(text) ? text : undefined;
}

function idListValue(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;
  const ids = text.split(",");
  return ids.every((id) => uuidValue(id)) ? [...new Set(ids)].sort().join(",") : undefined;
}

function uuidValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : undefined;
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
