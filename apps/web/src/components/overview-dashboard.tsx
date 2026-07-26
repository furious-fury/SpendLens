import {
  ArrowLineDown,
  ArrowLineUp,
  ArrowRight,
  ArrowsLeftRight,
  BookOpenText,
  ChartBar,
  CheckCircle,
  ClockCounterClockwise,
  Copy,
  Question,
  Receipt,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AnalyticsBreakdownItem,
  AnalyticsMetricResult,
  AnalyticsResult,
} from "@spendlens/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  comparisonTone,
  formatDateRange,
  formatMoney,
  formatPercentage,
  metricById,
  qualityLabel,
} from "@/lib/dashboard";
import { cn } from "@/lib/utils";

interface OverviewDashboardProps {
  result: AnalyticsResult;
}

const CATEGORY_COLOURS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function OverviewDashboard({ result }: OverviewDashboardProps) {
  const currency = result.query.currency;
  const inflow = metricById(result, "cashflow.total_inflow");
  const outflow = metricById(result, "cashflow.total_outflow");
  const net = metricById(result, "cashflow.net");
  const closing = metricById(result, "balance.closing");
  const cumulative = metricById(result, "cashflow.cumulative");
  const categories = metricById(result, "spending.by_category");
  const unusual = metricById(result, "spending.unusual");
  const largest = metricById(result, "cashflow.largest_outflow");
  const recurring = metricById(result, "spending.recurring");
  const coverage = metricById(result, "quality.classification_coverage");
  const review = metricById(result, "quality.review_queue");
  const duplicates = metricById(result, "quality.duplicate_sources");

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Cash-flow summary">
        <MetricCard metric={inflow} currency={currency} label="Total inflow" icon={ArrowLineDown} />
        <MetricCard
          metric={outflow}
          currency={currency}
          label="Total outflow"
          icon={ArrowLineUp}
          invertComparison
        />
        <MetricCard metric={net} currency={currency} label="Net cash flow" icon={ArrowsLeftRight} />
        <MetricCard metric={closing} currency={currency} label="Closing balance" icon={Question} />
      </section>

      <section
        className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)]"
        aria-label="Financial charts"
      >
        <CashFlowChart metric={cumulative} currency={currency} />
        <CategoryChart metric={categories} currency={currency} />
      </section>

      <section className="grid gap-5 lg:grid-cols-3" aria-label="Financial highlights">
        <TopCategories metric={categories} currency={currency} />
        <UnusualActivity unusual={unusual} largest={largest} currency={currency} />
        <RecurringSummary metric={recurring} currency={currency} />
      </section>

      <section aria-label="Data quality and review status">
        <QualitySummary coverage={coverage} review={review} duplicates={duplicates} />
      </section>
    </div>
  );
}

export function MetricCard({
  currency,
  icon: Icon,
  invertComparison = false,
  label,
  metric,
}: {
  currency: string;
  icon: typeof ArrowLineDown;
  invertComparison?: boolean;
  label: string;
  metric: AnalyticsMetricResult;
}) {
  const comparison = metric.comparison;
  const direction = comparisonTone((comparison?.absoluteChange ?? 0) * (invertComparison ? -1 : 1));
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 pb-3">
        <div className="min-w-0">
          <CardDescription>{label}</CardDescription>
          {metric.status === "available" && metric.value !== null ? (
            <CardTitle className="mt-2 truncate font-tabular text-2xl">
              {formatMoney(metric.value, currency)}
            </CardTitle>
          ) : (
            <CardTitle className="mt-2 text-xl">Unavailable</CardTitle>
          )}
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
          <Icon className="size-[18px]" weight="regular" aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent>
        {metric.status === "unavailable" ? (
          <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
            <Question className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {metric.unavailableReason}
          </p>
        ) : comparison ? (
          <div className="space-y-1">
            <p
              className={cn(
                "font-tabular text-xs font-medium",
                direction === "positive" && "text-success",
                direction === "negative" && "text-danger",
                direction === "neutral" && "text-muted-foreground",
              )}
            >
              {formatMoney(comparison.absoluteChange, currency, { sign: true })}
              <span className="ml-1.5">
                {comparison.percentageChange === null
                  ? "· no prior value"
                  : `· ${formatPercentage(comparison.percentageChange)}%`}
              </span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              vs {formatDateRange(comparison.startDate, comparison.endDate)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Comparison is turned off</p>
        )}
      </CardContent>
    </Card>
  );
}

export function CashFlowChart({
  currency,
  metric,
}: {
  currency: string;
  metric: AnalyticsMetricResult;
}) {
  const data = metric.breakdown.map((item) => ({
    date: item.key,
    label: compactDate(item.key),
    value: item.value,
  }));
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b border-border">
        <CardTitle>Cash-flow trend</CardTitle>
        <CardDescription>Cumulative net movement across the selected period.</CardDescription>
      </CardHeader>
      <CardContent className="pt-5">
        {data.length === 0 ? (
          <ChartEmpty message="No cash movement in this period." />
        ) : (
          <figure aria-labelledby="cash-flow-chart-title">
            <span id="cash-flow-chart-title" className="sr-only">
              Cumulative cash-flow chart
            </span>
            <div className="h-[270px] w-full" role="img" aria-label="Cumulative cash flow by day">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} accessibilityLayer margin={{ left: 4, right: 12, top: 8 }}>
                  <defs>
                    <linearGradient id="cashFlowFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    minTickGap={28}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    tickFormatter={(value) =>
                      formatMoney(Number(value), currency, { compact: true })
                    }
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                    contentStyle={{
                      borderColor: "var(--border)",
                      borderRadius: 10,
                      background: "var(--popover)",
                      color: "var(--popover-foreground)",
                      boxShadow: "0 8px 24px rgb(0 0 0 / 0.08)",
                    }}
                    labelFormatter={(_, payload) => payload[0]?.payload.date ?? ""}
                    formatter={(value) => [formatMoney(Number(value), currency), "Net movement"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    fill="url(#cashFlowFill)"
                    activeDot={{ r: 4, strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <figcaption className="sr-only">
              {data.map((item) => `${item.date}: ${formatMoney(item.value, currency)}`).join("; ")}
            </figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

export function CategoryChart({
  currency,
  metric,
}: {
  currency: string;
  metric: AnalyticsMetricResult;
}) {
  const data = metric.breakdown.slice(0, 6).map((item) => ({
    ...item,
    shortLabel: item.label.length > 18 ? `${item.label.slice(0, 16)}…` : item.label,
  }));
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b border-border">
        <CardTitle>Spending by category</CardTitle>
        <CardDescription>Top categories contributing to outflow.</CardDescription>
      </CardHeader>
      <CardContent className="pt-5">
        {data.length === 0 ? (
          <ChartEmpty message="No spending categories in this period." />
        ) : (
          <figure aria-labelledby="category-chart-title">
            <span id="category-chart-title" className="sr-only">
              Spending by category bar chart
            </span>
            <div className="h-[270px] w-full" role="img" aria-label="Spending by category">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  accessibilityLayer
                  layout="vertical"
                  margin={{ left: 6, right: 12 }}
                >
                  <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 5" />
                  <XAxis
                    type="number"
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value) =>
                      formatMoney(Number(value), currency, { compact: true })
                    }
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
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.55 }}
                    contentStyle={{
                      borderColor: "var(--border)",
                      borderRadius: 10,
                      background: "var(--popover)",
                      color: "var(--popover-foreground)",
                    }}
                    formatter={(value) => [formatMoney(Number(value), currency), "Spending"]}
                    labelFormatter={(_, payload) => payload[0]?.payload.label ?? ""}
                  />
                  <Bar dataKey="value" radius={[0, 5, 5, 0]} maxBarSize={24}>
                    {data.map((item, index) => (
                      <Cell
                        key={item.key}
                        fill={CATEGORY_COLOURS[index % CATEGORY_COLOURS.length] ?? "var(--primary)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <figcaption className="sr-only">
              {data.map((item) => `${item.label}: ${formatMoney(item.value, currency)}`).join("; ")}
            </figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

function TopCategories({ currency, metric }: { currency: string; metric: AnalyticsMetricResult }) {
  return (
    <InsightCard
      title="Top categories"
      description="Where spending was concentrated"
      icon={ChartBar}
      empty={metric.breakdown.length === 0}
      emptyMessage="No categorized spending yet."
    >
      <RankedList items={metric.breakdown.slice(0, 5)} currency={currency} />
    </InsightCard>
  );
}

function UnusualActivity({
  currency,
  largest,
  unusual,
}: {
  currency: string;
  largest: AnalyticsMetricResult;
  unusual: AnalyticsMetricResult;
}) {
  const items = unusual.breakdown.slice(0, 4);
  return (
    <InsightCard
      title="Largest & unusual"
      description="Transactions worth a closer look"
      icon={Sparkle}
      empty={items.length === 0 && (largest.value ?? 0) === 0}
      emptyMessage="Nothing unusual was detected."
    >
      {items.length > 0 ? (
        <RankedList items={items} currency={currency} />
      ) : (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">Largest outflow</p>
          <p className="mt-1 font-tabular text-base font-semibold">
            {formatMoney(largest.value ?? 0, currency)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">No statistical outlier detected.</p>
        </div>
      )}
    </InsightCard>
  );
}

function RecurringSummary({
  currency,
  metric,
}: {
  currency: string;
  metric: AnalyticsMetricResult;
}) {
  return (
    <InsightCard
      title="Recurring payments"
      description="Weekly, fortnightly, and monthly patterns"
      icon={ClockCounterClockwise}
      empty={metric.breakdown.length === 0}
      emptyMessage="No recurring spending pattern yet."
    >
      <RankedList items={metric.breakdown.slice(0, 4)} currency={currency} />
    </InsightCard>
  );
}

function InsightCard({
  children,
  description,
  empty,
  emptyMessage,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  description: string;
  empty: boolean;
  emptyMessage: string;
  icon: typeof ChartBar;
  title: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription className="mt-1">{description}</CardDescription>
        </div>
        <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function RankedList({ currency, items }: { currency: string; items: AnalyticsBreakdownItem[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((item, index) => (
        <li key={item.key} className="flex items-center gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
          <span className="shrink-0 font-tabular text-sm font-medium">
            {formatMoney(item.value, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function QualitySummary({
  coverage,
  duplicates,
  review,
}: {
  coverage: AnalyticsMetricResult;
  duplicates: AnalyticsMetricResult;
  review: AnalyticsMetricResult;
}) {
  const coverageValue = coverage.value ?? 0;
  const percentage = Math.max(0, Math.min(100, coverageValue / 100));
  const reviewCount = review.value ?? 0;
  const duplicateCount = duplicates.value ?? 0;
  const needsAttention = reviewCount > 0 || duplicateCount > 0;
  return (
    <Card>
      <CardContent className="grid gap-5 p-5 lg:grid-cols-[minmax(260px,1.2fr)_repeat(2,minmax(150px,.55fr))_auto] lg:items-center">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Classification quality</p>
              <p className="mt-1 text-sm font-semibold">{qualityLabel(coverageValue)}</p>
            </div>
            <span className="font-tabular text-lg font-semibold">{percentage.toFixed(0)}%</span>
          </div>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Classification coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percentage)}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} />
          </div>
        </div>
        <QualityStat
          icon={needsAttention ? WarningCircle : CheckCircle}
          label="Needs review"
          value={reviewCount}
          attention={reviewCount > 0}
        />
        <QualityStat
          icon={Copy}
          label="Possible duplicates"
          value={duplicateCount}
          attention={duplicateCount > 0}
        />
        <Button asChild variant={needsAttention ? "default" : "outline"}>
          <Link to="/review">
            <BookOpenText />
            Open review
            <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function QualityStat({
  attention,
  icon: Icon,
  label,
  value,
}: {
  attention?: boolean;
  icon: typeof Copy;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground",
          attention && "bg-attention/12 text-attention",
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span>
        <span className="block font-tabular text-base font-semibold">{value}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="grid h-[270px] place-items-center rounded-lg border border-dashed border-border">
      <div className="text-center">
        <Receipt className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function compactDate(value: string): string {
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}
