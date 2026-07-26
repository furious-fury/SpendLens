import type {
  AnalyticsMetricId,
  AnalyticsMetricResult,
  AnalyticsResult,
} from "@spendlens/contracts";

export function metricById(result: AnalyticsResult, id: AnalyticsMetricId): AnalyticsMetricResult {
  const metric = result.metrics.find((item) => item.id === id);
  if (!metric) {
    throw new Error(`Dashboard response is missing ${id}.`);
  }
  return metric;
}

export function formatMoney(
  amountMinor: number,
  currency: string,
  options: { compact?: boolean; sign?: boolean } = {},
): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    notation: options.compact ? "compact" : "standard",
    maximumFractionDigits: options.compact ? 1 : 2,
    minimumFractionDigits: options.compact ? 0 : 2,
    signDisplay: options.sign ? "exceptZero" : "auto",
  }).format(amountMinor / 100);
}

export function formatPercentage(value: number): string {
  return new Intl.NumberFormat("en-NG", {
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(value);
}

export function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const short = (value: Date, includeYear: boolean) =>
    new Intl.DateTimeFormat("en-NG", {
      day: "numeric",
      month: "short",
      ...(includeYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(value);
  if (startDate === endDate) return short(start, true);
  return `${short(start, !sameYear)}–${short(end, true)}`;
}

export function comparisonTone(absoluteChange: number): "positive" | "negative" | "neutral" {
  return absoluteChange > 0 ? "positive" : absoluteChange < 0 ? "negative" : "neutral";
}

export function qualityLabel(coverageBasisPoints: number): string {
  if (coverageBasisPoints >= 9_500) return "Excellent coverage";
  if (coverageBasisPoints >= 8_000) return "Good coverage";
  if (coverageBasisPoints >= 5_000) return "Needs attention";
  return "Early classification";
}
