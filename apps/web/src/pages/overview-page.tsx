import {
  ArrowClockwise,
  ArrowsLeftRight,
  FileArrowDown,
  WarningCircle,
} from "@phosphor-icons/react";
import type { AnalyticsMetricId, AnalyticsQuery } from "@spendlens/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DashboardFilters,
  type DashboardFiltersValue,
  datesForLatestTransaction,
  initialDashboardDates,
} from "@/components/dashboard-filters";
import { OverviewDashboard } from "@/components/overview-dashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";

const OVERVIEW_METRICS = [
  "cashflow.total_inflow",
  "cashflow.total_outflow",
  "cashflow.net",
  "cashflow.cumulative",
  "cashflow.transaction_count",
  "cashflow.largest_outflow",
  "balance.closing",
  "spending.by_category",
  "spending.unusual",
  "spending.recurring",
  "quality.classification_coverage",
  "quality.review_queue",
  "quality.duplicate_sources",
] satisfies AnalyticsMetricId[];

function initialFilters(): DashboardFiltersValue {
  return {
    ...initialDashboardDates(),
    currency: "NGN",
    accountIds: [],
    scopes: ["personal", "business"],
    comparison: { mode: "previous_period" },
  };
}

export function OverviewPage() {
  const [filters, setFilters] = useState<DashboardFiltersValue>(initialFilters);
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
  });
  const latestTransactionQuery = useQuery({
    queryKey: ["transactions", "latest-overview"],
    queryFn: () => api.transactions({ limit: 1, sort: "occurredAt", direction: "desc" }),
  });
  const accounts = accountsQuery.data?.items.filter(({ archivedAt }) => archivedAt === null) ?? [];

  useEffect(() => {
    if (filtersInitialized || !accountsQuery.data || latestTransactionQuery.isPending) {
      return;
    }
    const latest = latestTransactionQuery.data?.items[0];
    const selectedAccounts = accountsQuery.data.items.filter(
      ({ archivedAt }) => archivedAt === null,
    );
    setFilters((current) => ({
      ...current,
      ...(latest ? datesForLatestTransaction(latest.occurredAt) : {}),
      accountIds: selectedAccounts.map(({ id }) => id),
      currency: latest?.currency ?? selectedAccounts[0]?.baseCurrency ?? current.currency,
    }));
    setFiltersInitialized(true);
  }, [
    accountsQuery.data,
    filtersInitialized,
    latestTransactionQuery.data,
    latestTransactionQuery.isPending,
  ]);

  const queryInput: AnalyticsQuery = {
    ...filters,
    metricIds: OVERVIEW_METRICS,
    excludeInternalTransfers: true,
    useCache: true,
  };
  const validRange =
    filters.startDate.length === 10 &&
    filters.endDate.length === 10 &&
    filters.startDate <= filters.endDate;
  const analyticsQuery = useQuery({
    queryKey: ["analytics", "overview", queryInput],
    queryFn: () => api.analytics(queryInput),
    enabled:
      filtersInitialized && accounts.length > 0 && filters.accountIds.length > 0 && validRange,
    placeholderData: (previous) => previous,
  });

  if (accountsQuery.isPending || latestTransactionQuery.isPending || !filtersInitialized) {
    return <DashboardSkeleton />;
  }

  if (accountsQuery.isError || latestTransactionQuery.isError) {
    return (
      <DashboardError
        message="SpendLens could not load your accounts and latest activity."
        onRetry={() => {
          void accountsQuery.refetch();
          void latestTransactionQuery.refetch();
        }}
      />
    );
  }

  if (accounts.length === 0) {
    return (
      <DashboardEmpty
        title="No financial accounts yet"
        description="Import a statement or add an account to start building your private financial overview."
      />
    );
  }

  const hasTransactions = (latestTransactionQuery.data?.items.length ?? 0) > 0;

  return (
    <div className="space-y-5">
      <DashboardFilters
        accounts={accounts}
        value={filters}
        onChange={setFilters}
        disabled={analyticsQuery.isPending}
      />

      {!validRange && (
        <p className="rounded-lg border border-danger/25 bg-danger/8 px-4 py-3 text-sm text-danger">
          The dashboard start date must not be after the end date.
        </p>
      )}

      {!hasTransactions ? (
        <DashboardEmpty
          title="No financial history yet"
          description="Import a PalmPay statement to calculate cash flow, spending patterns, and classification quality."
        />
      ) : analyticsQuery.isPending ? (
        <DashboardContentSkeleton />
      ) : analyticsQuery.isError ? (
        <DashboardError
          message={
            analyticsQuery.error instanceof Error
              ? analyticsQuery.error.message
              : "SpendLens could not calculate this overview."
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
              <ArrowClockwise className="size-3 animate-spin" aria-hidden="true" />
              Updating
            </div>
          )}
          <OverviewDashboard result={analyticsQuery.data} />
        </div>
      ) : null}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading dashboard" aria-busy="true">
      <div className="h-[150px] animate-pulse rounded-xl border border-border bg-muted/40 sm:h-[86px]" />
      <DashboardContentSkeleton />
    </div>
  );
}

function DashboardContentSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Calculating dashboard" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {["inflow", "outflow", "net", "balance"].map((key) => (
          <div
            key={key}
            className="h-36 animate-pulse rounded-xl border border-border bg-muted/40"
          />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)]">
        <div className="h-[370px] animate-pulse rounded-xl border border-border bg-muted/40" />
        <div className="h-[370px] animate-pulse rounded-xl border border-border bg-muted/40" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        {["categories", "unusual", "recurring"].map((key) => (
          <div
            key={key}
            className="h-64 animate-pulse rounded-xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}

function DashboardEmpty({ description, title }: { description: string; title: string }) {
  return (
    <Card>
      <CardContent className="grid min-h-[420px] place-items-center p-6">
        <div className="max-w-md text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
            <ArrowsLeftRight className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          <Button asChild className="mt-5">
            <Link to="/imports">
              <FileArrowDown />
              Import a statement
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-danger/25">
      <CardContent className="grid min-h-72 place-items-center p-6">
        <div className="max-w-md text-center">
          <WarningCircle className="mx-auto size-7 text-danger" aria-hidden="true" />
          <h2 className="mt-3 font-semibold">Overview unavailable</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
          <Button type="button" variant="outline" className="mt-5" onClick={onRetry}>
            <ArrowClockwise />
            Try again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
