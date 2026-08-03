import {
  ArrowLineDown,
  ArrowLineUp,
  Check,
  DownloadSimple,
  NotePencil,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  Category,
  Transaction,
  TransactionReviewState,
  TransactionScope,
  TransactionType,
} from "@spendlens/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/dashboard";
import {
  aggregateDailyBreakdown,
  contributionIds,
  refreshAfterInsightCorrection,
  transactionsToCsv,
  type TrendGrain,
} from "@/lib/insights";
import { cn } from "@/lib/utils";
import type { AnalyticsResult } from "@spendlens/contracts";

const PAGE_SIZE = 40;

export function InsightDrilldown({
  grain = "day",
  metricId,
  onClose,
  onSelectTransaction,
  result,
  segmentKey,
  selectedTransactionId,
}: {
  grain?: TrendGrain | undefined;
  metricId?: string | undefined;
  onClose: () => void;
  onSelectTransaction: (transactionId?: string) => void;
  result: AnalyticsResult;
  segmentKey?: string | undefined;
  selectedTransactionId?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const metric = result.metrics.find((item) => item.id === metricId);
  const displayBreakdown = metric?.id.endsWith(".by_day")
    ? aggregateDailyBreakdown(metric.breakdown, grain)
    : metric?.breakdown;
  const segment = segmentKey
    ? displayBreakdown?.find((item) => item.key === segmentKey)
    : undefined;
  const transactionIds = useMemo(
    () => contributionIds(result, metricId, segmentKey, grain),
    [grain, metricId, result, segmentKey],
  );
  const visibleIds = transactionIds.slice(0, visibleCount);
  const transactionQueries = useQueries({
    queries: visibleIds.map((transactionId) => ({
      queryKey: ["transaction", transactionId],
      queryFn: () => api.transaction(transactionId),
      staleTime: 30_000,
    })),
  });
  const transactions = transactionQueries
    .map(({ data }) => data)
    .filter((item): item is Transaction => Boolean(item))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  const loading = transactionQueries.some(({ isPending }) => isPending);
  const failed = transactionQueries.find(({ error }) => error)?.error;
  const selectedId =
    selectedTransactionId && transactionIds.includes(selectedTransactionId)
      ? selectedTransactionId
      : undefined;

  async function exportContributionSet() {
    if (!metric || transactionIds.length === 0) return;
    setExporting(true);
    setExportError(null);
    try {
      const all: Transaction[] = [];
      for (let offset = 0; offset < transactionIds.length; offset += 20) {
        const batch = transactionIds.slice(offset, offset + 20);
        const rows = await Promise.all(
          batch.map((transactionId) =>
            queryClient.fetchQuery({
              queryKey: ["transaction", transactionId],
              queryFn: () => api.transaction(transactionId),
              staleTime: 30_000,
            }),
          ),
        );
        all.push(...rows);
      }
      all.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
      downloadCsv(
        transactionsToCsv(all),
        `spendlens-${metric.id.replaceAll(".", "-")}-${result.query.startDate}-${result.query.endDate}.csv`,
      );
    } catch (caught) {
      setExportError(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Sheet
      open={Boolean(metricId && metric)}
      onClose={onClose}
      title={segment?.label ?? metric?.title ?? "Contributing transactions"}
      {...(metric
        ? {
            description: `${transactionIds.length} contributing transaction${transactionIds.length === 1 ? "" : "s"} · ${result.query.startDate} to ${result.query.endDate}`,
          }
        : {})}
      wide
    >
      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <p className="text-sm text-muted-foreground">{metric?.definition}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Internal transfers are excluded from income and spending unless this metric explicitly
              describes transfers.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={exporting || transactionIds.length === 0}
            onClick={() => void exportContributionSet()}
          >
            <DownloadSimple />
            {exporting ? "Preparing…" : "Export CSV"}
          </Button>
        </div>
        {exportError && (
          <p className="mt-3 flex items-center gap-2 text-sm text-danger">
            <WarningCircle />
            {exportError}
          </p>
        )}
      </div>

      {selectedId ? (
        <TransactionCorrection
          transactionId={selectedId}
          onBack={() => onSelectTransaction(undefined)}
        />
      ) : transactionIds.length === 0 ? (
        <DrawerState message="No transactions contribute to this value in the selected period." />
      ) : failed ? (
        <DrawerState tone="danger" message={errorMessage(failed)} />
      ) : (
        <div className="p-4 sm:p-5">
          <div className="space-y-2" aria-busy={loading}>
            {transactions.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                onClick={() => onSelectTransaction(transaction.id)}
              />
            ))}
            {loading && <DrawerState compact message="Loading contributing transactions…" />}
          </div>
          {visibleCount < transactionIds.length && (
            <Button
              className="mt-4 w-full"
              variant="outline"
              onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
            >
              Load {Math.min(PAGE_SIZE, transactionIds.length - visibleCount)} more
            </Button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function TransactionRow({
  onClick,
  transaction,
}: {
  onClick: () => void;
  transaction: Transaction;
}) {
  const FlowIcon = transaction.direction === "credit" ? ArrowLineDown : ArrowLineUp;
  return (
    <button
      type="button"
      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <FlowIcon aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {transaction.normalizedNarration ??
            transaction.counterparty?.displayName ??
            transaction.source.rawNarration ??
            "Transaction"}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDate(transaction.occurredAt)}</span>
          <span aria-hidden="true">·</span>
          <TransactionTypeBadge transaction={transaction} />
          <span aria-hidden="true">·</span>
          <span>{transaction.category?.name ?? "Unclassified category"}</span>
        </span>
      </span>
      <span className="text-right">
        <span className="block font-tabular text-sm font-semibold">
          {formatMoney(transaction.amountMinor, transaction.currency)}
        </span>
        <span className="mt-1 block text-[11px] capitalize text-muted-foreground">
          {transaction.scope}
        </span>
      </span>
    </button>
  );
}

export function TransactionTypeBadge({ transaction }: { transaction: Transaction }) {
  const label =
    transaction.transactionType === "unclassified"
      ? "Unclassified"
      : transaction.transactionType.replaceAll("_", " ");
  return (
    <span
      className={cn(
        "rounded-full bg-muted px-1.5 py-0.5 capitalize",
        transaction.transactionType === "refund" && "bg-chart-2/12 text-chart-2",
        transaction.transactionType === "transfer" && "bg-primary/10 text-primary",
        transaction.transactionType === "unclassified" && "bg-attention/12 text-attention",
      )}
    >
      {label}
      {transaction.transfer.status === "confirmed" ? " · internal" : ""}
    </span>
  );
}

function TransactionCorrection({
  onBack,
  transactionId,
}: {
  onBack: () => void;
  transactionId: string;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: () => api.transaction(transactionId),
  });
  const categoriesQuery = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const counterpartiesQuery = useQuery({
    queryKey: ["counterparties"],
    queryFn: api.counterparties,
  });
  const transaction = detailQuery.data;
  const [narration, setNarration] = useState("");
  const [scope, setScope] = useState<TransactionScope>("personal");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [transactionType, setTransactionType] = useState<TransactionType>("unclassified");
  const [reviewState, setReviewState] = useState<TransactionReviewState>("unreviewed");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!transaction) return;
    setNarration(transaction.normalizedNarration ?? "");
    setScope(transaction.scope);
    setCategoryId(transaction.category?.id ?? "");
    setCounterpartyId(transaction.counterparty?.id ?? "");
    setTransactionType(transaction.transactionType);
    setReviewState(transaction.reviewState);
    setNote(transaction.note ?? "");
    setSaved(false);
  }, [transaction]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateTransaction(transactionId, {
        normalizedNarration: narration.trim() || null,
        scope,
        categoryId: categoryId || null,
        counterpartyId: counterpartyId || null,
        transactionType,
        reviewState,
        note: note.trim() || null,
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["transaction", transactionId], updated);
      await refreshAfterInsightCorrection(queryClient);
      setSaved(true);
    },
  });

  if (detailQuery.isPending) return <DrawerState message="Loading transaction…" />;
  if (detailQuery.isError || !transaction) {
    return <DrawerState tone="danger" message={errorMessage(detailQuery.error)} />;
  }

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          ← Contribution set
        </Button>
        <span className="font-tabular text-lg font-semibold">
          {formatMoney(transaction.amountMinor, transaction.currency)}
        </span>
      </div>

      <section className="rounded-xl border border-border p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <NotePencil className="text-primary" />
          Clarify this transaction
        </h3>
        <div className="mt-4 grid gap-4">
          <Field label="Description">
            <Input value={narration} onChange={(event) => setNarration(event.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">Unclassified</option>
                {categoryOptions(categoriesQuery.data?.items ?? [])}
              </Select>
            </Field>
            <Field label="Transaction type">
              <Select
                value={transactionType}
                onChange={(event) => setTransactionType(event.target.value as TransactionType)}
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="transfer">Transfer</option>
                <option value="refund">Refund</option>
                <option value="fee">Fee</option>
                <option value="cash_withdrawal">Cash withdrawal</option>
                <option value="debt">Debt</option>
                <option value="unclassified">Unclassified</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scope">
              <Select
                value={scope}
                onChange={(event) => setScope(event.target.value as TransactionScope)}
              >
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </Select>
            </Field>
            <Field label="Review state">
              <Select
                value={reviewState}
                onChange={(event) => setReviewState(event.target.value as TransactionReviewState)}
              >
                <option value="unreviewed">Unreviewed</option>
                <option value="needs_review">Needs review</option>
                <option value="reviewed">Reviewed</option>
              </Select>
            </Field>
          </div>
          <Field label="Counterparty">
            <Select
              value={counterpartyId}
              onChange={(event) => setCounterpartyId(event.target.value)}
            >
              <option value="">No counterparty</option>
              {(counterpartiesQuery.data?.items ?? []).map((counterparty) => (
                <option key={counterparty.id} value={counterparty.id}>
                  {counterparty.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Private note">
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add context for your future self"
            />
          </Field>
          {saveMutation.isError && (
            <p className="text-sm text-danger">{errorMessage(saveMutation.error)}</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {saved && (
              <span className="flex items-center gap-1.5 text-xs text-success" role="status">
                <Check />
                Metrics refreshed
              </span>
            )}
            <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              <Check />
              {saveMutation.isPending ? "Saving…" : "Save and refresh"}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-muted/25 p-4 text-sm">
        <h3 className="font-semibold">Source context</h3>
        <dl className="mt-3 grid gap-2 text-xs">
          <SourceRow label="Raw description" value={transaction.source.rawNarration ?? "—"} />
          <SourceRow label="Reference" value={transaction.sourceReference ?? "—"} />
          <SourceRow label="Account" value={transaction.account.displayName} />
          <SourceRow
            label="Classification"
            value={`${transaction.classificationSource} · ${transaction.confidence}`}
          />
        </dl>
      </section>
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SourceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words capitalize">{value}</dd>
    </div>
  );
}

function categoryOptions(categories: Category[]) {
  return categories
    .filter(({ archivedAt }) => !archivedAt)
    .map((category) => {
      const parent = categories.find(({ id }) => id === category.parentId);
      return (
        <option key={category.id} value={category.id}>
          {parent ? `${parent.name} / ` : ""}
          {category.name}
        </option>
      );
    });
}

function DrawerState({
  compact = false,
  message,
  tone = "neutral",
}: {
  compact?: boolean;
  message: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cn(
        "grid place-items-center p-8 text-sm text-muted-foreground",
        !compact && "min-h-56",
        tone === "danger" && "text-danger",
      )}
      role="status"
    >
      {message}
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "SpendLens could not complete this action.";
}

function downloadCsv(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
