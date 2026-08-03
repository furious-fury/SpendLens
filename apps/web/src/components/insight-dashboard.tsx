import { ArrowRight, ChartBar, Info, Question, WarningCircle } from "@phosphor-icons/react";
import type {
  AnalyticsBreakdownItem,
  AnalyticsMetricId,
  AnalyticsMetricResult,
  AnalyticsResult,
} from "@spendlens/contracts";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateRange, formatMoney, formatPercentage } from "@/lib/dashboard";
import type { InsightPageConfig } from "@/lib/insight-config";
import { aggregateDailyBreakdown, metricValue, type TrendGrain } from "@/lib/insights";
import { cn } from "@/lib/utils";

const CHART_COLOURS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function InsightDashboard({
  config,
  grain,
  onOpen,
  result,
}: {
  config: InsightPageConfig;
  grain: TrendGrain;
  onOpen: (metricId: AnalyticsMetricId, segmentKey?: string) => void;
  result: AnalyticsResult;
}) {
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Insight summary">
        {config.summaryMetricIds.map((metricId) => (
          <MetricCard
            key={metricId}
            currency={result.query.currency}
            metric={requiredMetric(result, metricId)}
            onOpen={onOpen}
          />
        ))}
      </section>

      {config.charts.length > 0 && (
        <section className="grid gap-5 xl:grid-cols-2" aria-label={`${config.title} charts`}>
          {config.charts.map((chart) => (
            <MetricChart
              key={`${chart.metricId}-${chart.title}`}
              config={chart}
              currency={result.query.currency}
              grain={grain}
              metric={requiredMetric(result, chart.metricId)}
              onOpen={onOpen}
            />
          ))}
        </section>
      )}

      {config.groups.map((group) => (
        <section key={group.title} aria-labelledby={sectionId(group.title)}>
          <div className="mb-3">
            <h2 id={sectionId(group.title)} className="text-base font-semibold tracking-tight">
              {group.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.metricIds.map((metricId) => (
              <MetricDetailCard
                key={metricId}
                currency={result.query.currency}
                metric={requiredMetric(result, metricId)}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}

      <section aria-labelledby="calculation-gaps">
        <Card>
          <CardHeader>
            <CardTitle id="calculation-gaps" className="flex items-center gap-2">
              <Info className="text-primary" />
              Calculation coverage
            </CardTitle>
            <CardDescription>
              SpendLens shows unavailable metrics explicitly instead of filling gaps with guesses.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {config.limitations.map((limitation) => (
              <div
                key={limitation.title}
                className="rounded-xl border border-border bg-muted/20 p-4"
              >
                <p className="flex items-start gap-2 text-sm font-medium">
                  <Question className="mt-0.5 shrink-0 text-muted-foreground" />
                  {limitation.title}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{limitation.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MetricCard({
  currency,
  metric,
  onOpen,
}: {
  currency: string;
  metric: AnalyticsMetricResult;
  onOpen: (metricId: AnalyticsMetricId, segmentKey?: string) => void;
}) {
  const canOpen = metric.transactionIds.length > 0;
  const comparison = metric.comparison;
  return (
    <Card className="relative overflow-hidden">
      <button
        type="button"
        className="block w-full text-left disabled:cursor-default"
        disabled={!canOpen}
        onClick={() => onOpen(metric.id)}
        aria-label={
          canOpen
            ? `${metric.title}: open contributing transactions`
            : `${metric.title}: unavailable`
        }
      >
        <CardHeader className="pb-2">
          <CardDescription>{metric.title}</CardDescription>
          <CardTitle className="font-tabular text-2xl">{metricValue(metric, currency)}</CardTitle>
        </CardHeader>
        <CardContent>
          {metric.status === "unavailable" ? (
            <p className="text-xs leading-5 text-muted-foreground">{metric.unavailableReason}</p>
          ) : comparison ? (
            <>
              <p
                className={cn(
                  "font-tabular text-xs font-medium",
                  comparison.absoluteChange > 0 && "text-success",
                  comparison.absoluteChange < 0 && "text-danger",
                  comparison.absoluteChange === 0 && "text-muted-foreground",
                )}
              >
                {comparisonText(metric, comparison.absoluteChange, currency)}
                {comparison.percentageChange === null
                  ? " · no prior value"
                  : ` · ${formatPercentage(comparison.percentageChange)}%`}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                vs {formatDateRange(comparison.startDate, comparison.endDate)}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {metric.transactionIds.length} contributing transaction
              {metric.transactionIds.length === 1 ? "" : "s"}
            </p>
          )}
        </CardContent>
      </button>
      {canOpen && (
        <ArrowRight className="pointer-events-none absolute right-4 bottom-4 size-4 text-muted-foreground" />
      )}
    </Card>
  );
}

function MetricDetailCard({
  currency,
  metric,
  onOpen,
}: {
  currency: string;
  metric: AnalyticsMetricResult;
  onOpen: (metricId: AnalyticsMetricId, segmentKey?: string) => void;
}) {
  const canOpen = metric.transactionIds.length > 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">{metric.title}</CardTitle>
            <p className="mt-2 font-tabular text-xl font-semibold">
              {metricValue(metric, currency)}
            </p>
          </div>
          <ChartBar className="text-muted-foreground" aria-hidden="true" />
        </div>
      </CardHeader>
      <CardContent>
        {metric.status === "unavailable" ? (
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <WarningCircle className="mt-0.5 shrink-0 text-attention" />
            {metric.unavailableReason}
          </p>
        ) : (
          <>
            <p className="text-xs leading-5 text-muted-foreground">{metric.definition}</p>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary disabled:text-muted-foreground"
              disabled={!canOpen}
              onClick={() => onOpen(metric.id)}
            >
              {canOpen
                ? `View ${metric.transactionIds.length} transaction${metric.transactionIds.length === 1 ? "" : "s"}`
                : "No contributing transactions"}
              {canOpen && <ArrowRight />}
            </button>
          </>
        )}
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            Calculation note
          </summary>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{metric.definition}</p>
        </details>
      </CardContent>
    </Card>
  );
}

function MetricChart({
  config,
  currency,
  grain,
  metric,
  onOpen,
}: {
  config: InsightPageConfig["charts"][number];
  currency: string;
  grain: TrendGrain;
  metric: AnalyticsMetricResult;
  onOpen: (metricId: AnalyticsMetricId, segmentKey?: string) => void;
}) {
  const breakdown = metric.id.endsWith(".by_day")
    ? aggregateDailyBreakdown(metric.breakdown, grain)
    : metric.breakdown;
  const data = breakdown.map((item) => ({
    ...item,
    shortLabel: shorten(item.label),
  }));
  const selectFromChart = (state: unknown) => {
    const key = activeChartKey(state);
    if (key) onOpen(metric.id, key);
  };

  return (
    <Card className="min-w-0">
      <CardHeader className="border-b border-border">
        <CardTitle>{config.title}</CardTitle>
        <CardDescription>{config.description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-5">
        {metric.status === "unavailable" ? (
          <ChartState message={metric.unavailableReason ?? "This metric is unavailable."} />
        ) : data.length === 0 ? (
          <ChartState message="No contributing activity in this period." />
        ) : (
          <figure aria-label={config.title}>
            <div
              className="h-[280px] w-full"
              role="img"
              aria-label={`${config.title}. Select a chart value to inspect its transactions.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                {config.kind === "area" ? (
                  <AreaChart
                    data={data}
                    accessibilityLayer
                    onClick={selectFromChart}
                    margin={{ top: 8, right: 12, left: 4 }}
                  >
                    <defs>
                      <linearGradient id={`fill-${metric.id}`} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
                        <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
                    <XAxis
                      dataKey="shortLabel"
                      axisLine={false}
                      tickLine={false}
                      minTickGap={28}
                      tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      width={58}
                      tickFormatter={(value) => chartValue(metric, Number(value), currency, true)}
                      tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    />
                    <Tooltip content={<ChartTooltip metric={metric} currency={currency} />} />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      fill={`url(#fill-${metric.id})`}
                      activeDot={{ r: 5, strokeWidth: 2 }}
                    />
                  </AreaChart>
                ) : (
                  <BarChart
                    data={data}
                    accessibilityLayer
                    layout="vertical"
                    onClick={selectFromChart}
                    margin={{ left: 8, right: 12 }}
                  >
                    <CartesianGrid
                      horizontal={false}
                      stroke="var(--border)"
                      strokeDasharray="3 5"
                    />
                    <XAxis
                      type="number"
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(value) => chartValue(metric, Number(value), currency, true)}
                      tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="shortLabel"
                      axisLine={false}
                      tickLine={false}
                      width={112}
                      tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    />
                    <Tooltip content={<ChartTooltip metric={metric} currency={currency} />} />
                    <Bar dataKey="value" radius={[0, 5, 5, 0]} maxBarSize={24}>
                      {data.map((item, index) => (
                        <Cell
                          key={item.key}
                          fill={CHART_COLOURS[index % CHART_COLOURS.length] ?? "var(--primary)"}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
            <figcaption className="mt-4 max-h-40 overflow-y-auto rounded-lg border border-border">
              <span className="sr-only">Accessible chart values</span>
              {data.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => onOpen(metric.id, item.key)}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="shrink-0 font-tabular font-medium">
                    {chartValue(metric, item.value, currency)}
                  </span>
                </button>
              ))}
            </figcaption>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                How this is calculated
              </summary>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{metric.definition}</p>
            </details>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

function ChartTooltip({
  active,
  currency,
  metric,
  payload,
}: {
  active?: boolean;
  currency: string;
  metric: AnalyticsMetricResult;
  payload?: Array<{ payload?: AnalyticsBreakdownItem }>;
}) {
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
      <p className="text-xs text-muted-foreground">{item.label}</p>
      <p className="mt-1 font-tabular text-sm font-semibold">
        {chartValue(metric, item.value, currency)}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {item.transactionIds.length} transaction{item.transactionIds.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function ChartState({ message }: { message: string }) {
  return (
    <div className="grid min-h-[280px] place-items-center rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function chartValue(
  metric: AnalyticsMetricResult,
  value: number,
  currency: string,
  compact = false,
): string {
  if (metric.unit === "minor_units") {
    return formatMoney(value, currency, { compact });
  }
  if (metric.unit === "basis_points") return `${(value / 100).toFixed(compact ? 0 : 2)}%`;
  if (metric.unit === "ratio") return `${value.toFixed(2)}×`;
  return new Intl.NumberFormat("en-NG", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

function comparisonText(metric: AnalyticsMetricResult, change: number, currency: string): string {
  if (metric.unit === "minor_units") return formatMoney(change, currency, { sign: true });
  if (metric.unit === "basis_points") {
    return `${change >= 0 ? "+" : ""}${(change / 100).toFixed(2)} pp`;
  }
  return new Intl.NumberFormat("en-NG", {
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(change);
}

function requiredMetric(result: AnalyticsResult, metricId: AnalyticsMetricId) {
  const metric = result.metrics.find(({ id }) => id === metricId);
  if (!metric) throw new Error(`Insight response is missing ${metricId}.`);
  return metric;
}

function activeChartKey(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const payload = (state as { activePayload?: Array<{ payload?: { key?: unknown } }> })
    .activePayload;
  const key = payload?.[0]?.payload?.key;
  return typeof key === "string" ? key : undefined;
}

function shorten(value: string) {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}

function sectionId(value: string) {
  return `insight-${value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}
