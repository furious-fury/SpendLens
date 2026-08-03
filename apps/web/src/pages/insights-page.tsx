import {
  ArrowClockwise,
  ArrowLineDown,
  ArrowLineUp,
  ArrowsLeftRight,
  Brain,
  ChartBar,
  WarningCircle,
} from "@phosphor-icons/react";
import type { AnalyticsMetricId, AnalyticsQuery } from "@spendlens/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import {
  DashboardFilters,
  datesForLatestTransaction,
  initialDashboardDates,
  type DashboardFiltersValue,
} from "@/components/dashboard-filters";
import { InsightDashboard } from "@/components/insight-dashboard";
import { InsightDrilldown } from "@/components/insight-drilldown";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { INSIGHT_CONFIGS, insightMetricIds } from "@/lib/insight-config";
import {
  filtersFromInsightSearch,
  insightSearchFromFilters,
  type InsightPath,
  type InsightRouteSearch,
  type TrendGrain,
} from "@/lib/insights";
import { cn } from "@/lib/utils";

const insightNavigation = [
  { path: "/spending", label: "Spending", icon: ArrowLineUp },
  { path: "/income", label: "Income", icon: ArrowLineDown },
  { path: "/cash-flow", label: "Cash Flow", icon: ArrowsLeftRight },
  { path: "/behaviour", label: "Behaviour", icon: Brain },
] as const;

export function SpendingPage() {
  return <InsightsPage path="/spending" />;
}

export function IncomePage() {
  return <InsightsPage path="/income" />;
}

export function CashFlowPage() {
  return <InsightsPage path="/cash-flow" />;
}

export function BehaviourPage() {
  return <InsightsPage path="/behaviour" />;
}

function InsightsPage({ path }: { path: InsightPath }) {
  const config = INSIGHT_CONFIGS[path];
  const search = useSearch({ strict: false }) as InsightRouteSearch;
  const grain = search.grain ?? "month";
  const navigate = useNavigate();
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const latestTransactionQuery = useQuery({
    queryKey: ["transactions", "latest-insights"],
    queryFn: () => api.transactions({ limit: 1, sort: "occurredAt", direction: "desc" }),
  });
  const accounts = useMemo(
    () => accountsQuery.data?.items.filter(({ archivedAt }) => archivedAt === null) ?? [],
    [accountsQuery.data],
  );
  const latest = latestTransactionQuery.data?.items[0];
  const fallbackDates = latest
    ? datesForLatestTransaction(latest.occurredAt)
    : initialDashboardDates();
  const fallback: DashboardFiltersValue = {
    ...fallbackDates,
    currency: latest?.currency ?? accounts[0]?.baseCurrency ?? "NGN",
    accountIds: accounts.map(({ id }) => id),
    scopes: ["personal", "business"],
    comparison: { mode: "previous_period" },
  };
  const filters = filtersFromInsightSearch(
    search,
    fallback,
    accounts.map(({ id }) => id),
  );
  const metricIds = insightMetricIds(config);
  const canonicalSearch = insightSearchFromFilters(filters, {
    grain: search.grain,
    metric: search.metric,
    segment: search.segment,
    transaction: search.metric ? search.transaction : undefined,
  });

  useEffect(() => {
    if (!accountsQuery.data || latestTransactionQuery.isPending || accounts.length === 0) return;
    if (sameSearch(search, canonicalSearch)) return;
    void navigate({
      to: path,
      search: canonicalSearch as never,
      replace: true,
    });
  }, [
    accounts.length,
    accountsQuery.data,
    canonicalSearch,
    latestTransactionQuery.isPending,
    navigate,
    path,
    search,
  ]);

  const queryInput: AnalyticsQuery = {
    ...filters,
    metricIds,
    excludeInternalTransfers: true,
    useCache: true,
  };
  const validRange =
    filters.startDate.length === 10 &&
    filters.endDate.length === 10 &&
    filters.startDate <= filters.endDate;
  const analyticsQuery = useQuery({
    queryKey: ["analytics", "insights", path, queryInput],
    queryFn: () => api.analytics(queryInput),
    enabled:
      accountsQuery.isSuccess &&
      latestTransactionQuery.isSuccess &&
      accounts.length > 0 &&
      filters.accountIds.length > 0 &&
      validRange,
    placeholderData: (previous) => previous,
  });

  function updateSearch(
    nextFilters: DashboardFiltersValue,
    extras: Pick<InsightRouteSearch, "grain" | "metric" | "segment" | "transaction"> = {},
    replace = false,
  ) {
    void navigate({
      to: path,
      search: insightSearchFromFilters(nextFilters, {
        grain: extras.grain ?? grain,
        ...extras,
      }) as never,
      replace,
    });
  }

  function openDrilldown(metricId: AnalyticsMetricId, segment?: string) {
    updateSearch(filters, {
      metric: metricId,
      segment,
    });
  }

  if (accountsQuery.isPending || latestTransactionQuery.isPending) {
    return <InsightSkeleton />;
  }

  if (accountsQuery.isError || latestTransactionQuery.isError) {
    return (
      <InsightError
        message="SpendLens could not load your accounts and latest transaction."
        onRetry={() => {
          void accountsQuery.refetch();
          void latestTransactionQuery.refetch();
        }}
      />
    );
  }

  if (accounts.length === 0) {
    return (
      <InsightEmpty
        title="No accounts to analyse"
        description="Import a statement or add an account before opening detailed insights."
      />
    );
  }

  const hasTransactions = Boolean(latest);

  return (
    <div className="space-y-5">
      <InsightTabs path={path} filters={filters} />

      <section className="rounded-xl border border-border bg-card p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
              <ChartBar />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{config.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
          <div className="w-36 space-y-1.5">
            <Label htmlFor={`${path}-grain`} className="text-[11px] text-muted-foreground">
              Trend interval
            </Label>
            <Select
              id={`${path}-grain`}
              value={grain}
              onChange={(event) =>
                updateSearch(filters, { grain: event.target.value as TrendGrain })
              }
            >
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
              <option value="quarter">Quarterly</option>
              <option value="year">Yearly</option>
            </Select>
          </div>
        </div>
      </section>

      <DashboardFilters
        accounts={accounts}
        value={filters}
        onChange={(next) => updateSearch(next)}
        disabled={analyticsQuery.isPending}
      />

      {!validRange && (
        <p className="rounded-lg border border-danger/25 bg-danger/8 px-4 py-3 text-sm text-danger">
          The insight start date must not be after the end date.
        </p>
      )}

      {!hasTransactions ? (
        <InsightEmpty
          title="No financial history yet"
          description="Import a statement to calculate detailed spending, income, cash-flow, and behaviour insights."
        />
      ) : analyticsQuery.isPending ? (
        <InsightContentSkeleton />
      ) : analyticsQuery.isError ? (
        <InsightError
          message={
            analyticsQuery.error instanceof Error
              ? analyticsQuery.error.message
              : "SpendLens could not calculate these insights."
          }
          onRetry={() => void analyticsQuery.refetch()}
        />
      ) : analyticsQuery.data ? (
        <div className="relative">
          {analyticsQuery.isFetching && (
            <div
              className="absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
              role="status"
            >
              <ArrowClockwise className="size-3 animate-spin" />
              Updating metrics
            </div>
          )}
          <InsightDashboard
            config={config}
            grain={grain}
            result={analyticsQuery.data}
            onOpen={openDrilldown}
          />
          <InsightDrilldown
            key={`${search.metric ?? "closed"}:${search.segment ?? "all"}`}
            result={analyticsQuery.data}
            grain={grain}
            metricId={search.metric}
            segmentKey={search.segment}
            selectedTransactionId={search.transaction}
            onClose={() => updateSearch(filters, {}, true)}
            onSelectTransaction={(transaction) =>
              updateSearch(filters, {
                metric: search.metric,
                segment: search.segment,
                transaction,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function InsightTabs({ filters, path }: { filters: DashboardFiltersValue; path: InsightPath }) {
  const search = insightSearchFromFilters(filters);
  return (
    <nav
      className="scrollbar-none flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1"
      aria-label="Insight pages"
    >
      {insightNavigation.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.path}
            to={item.path}
            search={search as never}
            className={cn(
              "flex min-w-max flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              item.path === path && "bg-primary/8 text-primary",
            )}
          >
            <Icon />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function InsightSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading detailed insights">
      <div className="h-12 animate-pulse rounded-xl bg-muted/45" />
      <div className="h-24 animate-pulse rounded-xl bg-muted/45" />
      <InsightContentSkeleton />
    </div>
  );
}

function InsightContentSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Calculating detailed insights">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {["one", "two", "three", "four"].map((key) => (
          <div key={key} className="h-36 animate-pulse rounded-xl bg-muted/45" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="h-96 animate-pulse rounded-xl bg-muted/45" />
        <div className="h-96 animate-pulse rounded-xl bg-muted/45" />
      </div>
    </div>
  );
}

function InsightError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="grid min-h-72 place-items-center p-8 text-center">
        <div>
          <WarningCircle className="mx-auto size-8 text-danger" />
          <p className="mt-3 text-sm">{message}</p>
          <Button className="mt-4" variant="outline" onClick={onRetry}>
            <ArrowClockwise />
            Try again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function InsightEmpty({ description, title }: { description: string; title: string }) {
  return (
    <Card>
      <CardContent className="grid min-h-72 place-items-center p-8 text-center">
        <div className="max-w-md">
          <ChartBar className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-semibold">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function sameSearch(left: InsightRouteSearch, right: InsightRouteSearch) {
  return JSON.stringify(left) === JSON.stringify(right);
}
