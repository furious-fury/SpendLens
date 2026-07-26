import type {
  Category,
  Counterparty,
  Transaction,
  TransactionConfidence,
  TransactionReviewState,
  TransactionScope,
} from "@spendlens/contracts";
import {
  ArrowDown,
  ArrowUp,
  ArrowsLeftRight,
  CaretLeft,
  CaretRight,
  Check,
  Funnel,
  MagnifyingGlass,
  NotePencil,
  Plus,
  Scales,
  SlidersHorizontal,
  Tag,
  type Icon,
} from "@phosphor-icons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface TransactionRouteSearch {
  q?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  account?: string | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  flow?: "debit" | "credit" | undefined;
  currency?: string | undefined;
  scope?: TransactionScope | undefined;
  category?: string | undefined;
  counterparty?: string | undefined;
  confidence?: TransactionConfidence | undefined;
  review?: TransactionReviewState | undefined;
  sort?: "occurredAt" | "amount" | "createdAt" | undefined;
  direction?: "asc" | "desc" | undefined;
  cursor?: string | undefined;
}

export function parseTransactionSearch(search: Record<string, unknown>): TransactionRouteSearch {
  return {
    ...(stringValue(search.q) ? { q: stringValue(search.q) } : {}),
    ...(dateValue(search.start) ? { start: dateValue(search.start) } : {}),
    ...(dateValue(search.end) ? { end: dateValue(search.end) } : {}),
    ...(stringValue(search.account) ? { account: stringValue(search.account) } : {}),
    ...(positiveInteger(search.minimum) ? { minimum: positiveInteger(search.minimum) } : {}),
    ...(positiveInteger(search.maximum) ? { maximum: positiveInteger(search.maximum) } : {}),
    ...(oneOf(search.flow, ["debit", "credit"]) ? { flow: search.flow as "debit" | "credit" } : {}),
    ...(currencyValue(search.currency) ? { currency: currencyValue(search.currency) } : {}),
    ...(oneOf(search.scope, ["personal", "business"])
      ? { scope: search.scope as TransactionScope }
      : {}),
    ...(stringValue(search.category) ? { category: stringValue(search.category) } : {}),
    ...(stringValue(search.counterparty) ? { counterparty: stringValue(search.counterparty) } : {}),
    ...(oneOf(search.confidence, ["unknown", "low", "medium", "high", "confirmed"])
      ? { confidence: search.confidence as TransactionConfidence }
      : {}),
    ...(oneOf(search.review, ["unreviewed", "needs_review", "reviewed"])
      ? { review: search.review as TransactionReviewState }
      : {}),
    ...(oneOf(search.sort, ["occurredAt", "amount", "createdAt"])
      ? { sort: search.sort as TransactionRouteSearch["sort"] }
      : {}),
    ...(oneOf(search.direction, ["asc", "desc"])
      ? { direction: search.direction as "asc" | "desc" }
      : {}),
    ...(stringValue(search.cursor) ? { cursor: stringValue(search.cursor) } : {}),
  };
}

const columnHelper = createColumnHelper<Transaction>();

export function TransactionsPage() {
  const search = useSearch({ from: "/transactions" });
  const navigate = useNavigate({ from: "/transactions" });
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState(search.q ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [taxonomyOpen, setTaxonomyOpen] = useState(false);

  useEffect(() => setSearchText(search.q ?? ""), [search.q]);

  const transactionQuery = useQuery({
    queryKey: ["transactions", search],
    queryFn: () =>
      api.transactions({
        limit: 40,
        sort: search.sort ?? "occurredAt",
        direction: search.direction ?? "desc",
        ...(search.cursor ? { cursor: search.cursor } : {}),
        ...(search.q ? { search: search.q } : {}),
        ...(search.start ? { startDate: search.start } : {}),
        ...(search.end ? { endDate: search.end } : {}),
        ...(search.account ? { accountId: search.account } : {}),
        ...(search.minimum ? { minimumAmountMinor: search.minimum } : {}),
        ...(search.maximum ? { maximumAmountMinor: search.maximum } : {}),
        ...(search.flow ? { transactionDirection: search.flow } : {}),
        ...(search.currency ? { currency: search.currency } : {}),
        ...(search.scope ? { scope: search.scope } : {}),
        ...(search.category ? { categoryId: search.category } : {}),
        ...(search.counterparty ? { counterpartyId: search.counterparty } : {}),
        ...(search.confidence ? { confidence: search.confidence } : {}),
        ...(search.review ? { reviewState: search.review } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const categoriesQuery = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const counterpartiesQuery = useQuery({
    queryKey: ["counterparties"],
    queryFn: api.counterparties,
  });

  const transactions = transactionQuery.data?.items ?? [];
  const allSelected =
    transactions.length > 0 && transactions.every(({ id }) => selectedIds.has(id));

  const updateSearch = useCallback(
    (patch: Partial<TransactionRouteSearch>, resetCursor = true) => {
      void navigate({
        search: (current) => ({
          ...current,
          ...patch,
          ...(resetCursor ? { cursor: undefined } : {}),
        }),
        replace: true,
      });
      if (resetCursor) setCursorHistory([]);
    },
    [navigate],
  );

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "select",
        header: () => (
          <Checkbox
            aria-label="Select all visible transactions"
            checked={allSelected}
            onCheckedChange={(checked) =>
              setSelectedIds(checked ? new Set(transactions.map(({ id }) => id)) : new Set())
            }
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select ${row.original.normalizedNarration ?? "transaction"}`}
            checked={selectedIds.has(row.original.id)}
            onClick={(event) => event.stopPropagation()}
            onCheckedChange={(checked) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                checked ? next.add(row.original.id) : next.delete(row.original.id);
                return next;
              })
            }
          />
        ),
      }),
      columnHelper.accessor("occurredAt", {
        header: () => (
          <SortButton
            active={search.sort === undefined || search.sort === "occurredAt"}
            direction={search.direction ?? "desc"}
            label="Date"
            onClick={() =>
              updateSearch({
                sort: "occurredAt",
                direction:
                  search.sort === "occurredAt" && search.direction === "desc" ? "asc" : "desc",
              })
            }
          />
        ),
        cell: ({ getValue }) => <DateCell value={getValue()} />,
      }),
      columnHelper.accessor("normalizedNarration", {
        header: "Transaction",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="max-w-[360px] truncate font-medium">
              {row.original.normalizedNarration || row.original.source.rawNarration || "Untitled"}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {row.original.counterparty?.displayName ?? row.original.sourceReference ?? "—"}
            </p>
          </div>
        ),
      }),
      columnHelper.accessor("account.displayName", {
        header: "Account",
        cell: ({ getValue }) => <span className="text-muted-foreground">{getValue()}</span>,
      }),
      columnHelper.accessor("category.name", {
        header: "Category",
        cell: ({ row }) => (
          <CategoryPill
            name={row.original.category?.name ?? "Unclassified"}
            needsReview={row.original.reviewState === "needs_review"}
          />
        ),
      }),
      columnHelper.accessor("scope", {
        header: "Scope",
        cell: ({ getValue }) => (
          <span className="capitalize text-muted-foreground">{getValue()}</span>
        ),
      }),
      columnHelper.accessor("amountMinor", {
        header: () => (
          <div className="flex justify-end">
            <SortButton
              active={search.sort === "amount"}
              direction={search.direction ?? "desc"}
              label="Amount"
              onClick={() =>
                updateSearch({
                  sort: "amount",
                  direction:
                    search.sort === "amount" && search.direction === "desc" ? "asc" : "desc",
                })
              }
            />
          </div>
        ),
        cell: ({ row }) => (
          <p className="font-tabular text-right font-medium">
            {row.original.direction === "debit" ? "−" : "+"}
            {formatMoney(row.original.amountMinor, row.original.currency)}
          </p>
        ),
      }),
    ],
    [allSelected, search.direction, search.sort, selectedIds, transactions, updateSearch],
  );

  const table = useReactTable({
    data: transactions,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const activeFilterCount = [
    search.start,
    search.end,
    search.account,
    search.minimum,
    search.maximum,
    search.flow,
    search.currency,
    search.scope,
    search.category,
    search.counterparty,
    search.confidence,
    search.review,
  ].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <form
              className="relative flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                updateSearch({ q: searchText.trim() || undefined });
              }}
            >
              <MagnifyingGlass className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search narration, reference, category, or counterparty"
                className="pl-9 pr-24"
              />
              <Button type="submit" size="sm" className="absolute right-1 top-1">
                Search
              </Button>
            </form>
            <div className="flex gap-2">
              <Button
                variant={filtersOpen ? "subtle" : "outline"}
                onClick={() => setFiltersOpen((current) => !current)}
              >
                <Funnel />
                Filters
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
              <Button variant="outline" onClick={() => setTaxonomyOpen(true)}>
                <Tag />
                Organize
              </Button>
            </div>
          </div>
          {filtersOpen && (
            <TransactionFilters
              search={search}
              accounts={accountsQuery.data?.items ?? []}
              categories={categoriesQuery.data?.items ?? []}
              counterparties={counterpartiesQuery.data?.items ?? []}
              onChange={updateSearch}
              onClear={() =>
                updateSearch({
                  start: undefined,
                  end: undefined,
                  account: undefined,
                  minimum: undefined,
                  maximum: undefined,
                  flow: undefined,
                  currency: undefined,
                  scope: undefined,
                  category: undefined,
                  counterparty: undefined,
                  confidence: undefined,
                  review: undefined,
                })
              }
            />
          )}
        </CardContent>
      </Card>

      {selectedIds.size > 0 && (
        <BulkToolbar
          count={selectedIds.size}
          categories={categoriesQuery.data?.items ?? []}
          onCancel={() => setSelectedIds(new Set())}
          onApplied={async (changes) => {
            await api.bulkUpdateTransactions({
              transactionIds: [...selectedIds],
              changes,
            });
            setSelectedIds(new Set());
            await queryClient.invalidateQueries({ queryKey: ["transactions"] });
          }}
        />
      )}

      <Card className="overflow-hidden">
        {transactionQuery.isLoading ? (
          <TableState message="Loading transactions…" />
        ) : transactionQuery.error ? (
          <TableState
            tone="danger"
            message={
              transactionQuery.error instanceof Error
                ? transactionQuery.error.message
                : "Transactions could not be loaded."
            }
          />
        ) : transactions.length === 0 ? (
          <TableState message="No transactions match these filters." />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[940px] border-collapse text-sm">
                <thead className="bg-muted/45 text-left text-xs text-muted-foreground">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          className={cn(
                            "h-11 border-b border-border px-4 font-medium",
                            header.id === "select" && "w-12",
                          )}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-b border-border/70 transition-colors last:border-0 hover:bg-muted/35"
                      onClick={() => setSelectedId(row.original.id)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="h-[68px] px-4">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-border md:hidden">
              {transactions.map((transaction) => (
                <button
                  type="button"
                  key={transaction.id}
                  className="flex w-full gap-3 p-4 text-left transition-colors hover:bg-muted/35"
                  onClick={() => setSelectedId(transaction.id)}
                >
                  <Checkbox
                    checked={selectedIds.has(transaction.id)}
                    aria-label={`Select ${transaction.normalizedNarration ?? "transaction"}`}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={(checked) =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        checked ? next.add(transaction.id) : next.delete(transaction.id);
                        return next;
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="truncate text-sm font-medium">
                        {transaction.normalizedNarration ||
                          transaction.source.rawNarration ||
                          "Untitled"}
                      </p>
                      <p className="font-tabular shrink-0 text-sm font-semibold">
                        {transaction.direction === "debit" ? "−" : "+"}
                        {formatMoney(transaction.amountMinor, transaction.currency)}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <DateCell value={transaction.occurredAt} compact />
                      <CategoryPill
                        name={transaction.category?.name ?? "Unclassified"}
                        needsReview={transaction.reviewState === "needs_review"}
                      />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {transactions.length} transaction{transactions.length === 1 ? "" : "s"} on this page
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={cursorHistory.length === 0}
              onClick={() => {
                const history = [...cursorHistory];
                const cursor = history.pop();
                setCursorHistory(history);
                updateSearch({ cursor }, false);
              }}
            >
              <CaretLeft />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!transactionQuery.data?.nextCursor}
              onClick={() => {
                setCursorHistory((current) => [...current, search.cursor]);
                updateSearch({ cursor: transactionQuery.data?.nextCursor ?? undefined }, false);
              }}
            >
              Next
              <CaretRight />
            </Button>
          </div>
        </div>
      </Card>

      <TransactionDetail
        transactionId={selectedId}
        categories={categoriesQuery.data?.items ?? []}
        counterparties={counterpartiesQuery.data?.items ?? []}
        visibleTransactions={transactions}
        onClose={() => setSelectedId(null)}
      />
      <TaxonomyManager open={taxonomyOpen} onClose={() => setTaxonomyOpen(false)} />
    </div>
  );
}

function TransactionFilters({
  accounts,
  categories,
  counterparties,
  onChange,
  onClear,
  search,
}: {
  accounts: Array<{ id: string; displayName: string; archivedAt: string | null }>;
  categories: Category[];
  counterparties: Counterparty[];
  onChange: (patch: Partial<TransactionRouteSearch>) => void;
  onClear: () => void;
  search: TransactionRouteSearch;
}) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterField label="From">
          <Input
            type="date"
            value={search.start ?? ""}
            onChange={(event) => onChange({ start: event.target.value || undefined })}
          />
        </FilterField>
        <FilterField label="To">
          <Input
            type="date"
            value={search.end ?? ""}
            onChange={(event) => onChange({ end: event.target.value || undefined })}
          />
        </FilterField>
        <FilterField label="Account">
          <Select
            value={search.account ?? ""}
            onChange={(event) => onChange({ account: event.target.value || undefined })}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName}
                {account.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Direction">
          <Select
            value={search.flow ?? ""}
            onChange={(event) =>
              onChange({
                flow: (event.target.value || undefined) as "debit" | "credit" | undefined,
              })
            }
          >
            <option value="">All directions</option>
            <option value="debit">Outflow</option>
            <option value="credit">Inflow</option>
          </Select>
        </FilterField>
        <FilterField label="Minimum amount">
          <Input
            inputMode="decimal"
            placeholder="₦0.00"
            value={search.minimum ? minorToInput(search.minimum) : ""}
            onChange={(event) =>
              onChange({ minimum: parseMoneyInput(event.target.value) || undefined })
            }
          />
        </FilterField>
        <FilterField label="Maximum amount">
          <Input
            inputMode="decimal"
            placeholder="No maximum"
            value={search.maximum ? minorToInput(search.maximum) : ""}
            onChange={(event) =>
              onChange({ maximum: parseMoneyInput(event.target.value) || undefined })
            }
          />
        </FilterField>
        <FilterField label="Currency">
          <Input
            maxLength={3}
            placeholder="NGN"
            value={search.currency ?? ""}
            onChange={(event) =>
              onChange({ currency: event.target.value.toUpperCase() || undefined })
            }
          />
        </FilterField>
        <FilterField label="Scope">
          <Select
            value={search.scope ?? ""}
            onChange={(event) =>
              onChange({
                scope: (event.target.value || undefined) as TransactionScope | undefined,
              })
            }
          >
            <option value="">All scopes</option>
            <option value="personal">Personal</option>
            <option value="business">Business</option>
          </Select>
        </FilterField>
        <FilterField label="Category">
          <Select
            value={search.category ?? ""}
            onChange={(event) => onChange({ category: event.target.value || undefined })}
          >
            <option value="">All categories</option>
            {categoryOptions(categories)}
          </Select>
        </FilterField>
        <FilterField label="Counterparty">
          <Select
            value={search.counterparty ?? ""}
            onChange={(event) => onChange({ counterparty: event.target.value || undefined })}
          >
            <option value="">All counterparties</option>
            {counterparties.map((counterparty) => (
              <option key={counterparty.id} value={counterparty.id}>
                {counterparty.displayName}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Confidence">
          <Select
            value={search.confidence ?? ""}
            onChange={(event) =>
              onChange({
                confidence: (event.target.value || undefined) as TransactionConfidence | undefined,
              })
            }
          >
            <option value="">All confidence levels</option>
            <option value="unknown">Unknown</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="confirmed">Confirmed</option>
          </Select>
        </FilterField>
        <FilterField label="Review state">
          <Select
            value={search.review ?? ""}
            onChange={(event) =>
              onChange({
                review: (event.target.value || undefined) as TransactionReviewState | undefined,
              })
            }
          >
            <option value="">All review states</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="needs_review">Needs review</option>
            <option value="reviewed">Reviewed</option>
          </Select>
        </FilterField>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}

function BulkToolbar({
  categories,
  count,
  onApplied,
  onCancel,
}: {
  categories: Category[];
  count: number;
  onApplied: (changes: {
    scope?: TransactionScope;
    categoryId?: string | null;
    reviewState?: TransactionReviewState;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [field, setField] = useState<"category" | "scope" | "review">("category");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function apply() {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      if (field === "category") await onApplied({ categoryId: value });
      if (field === "scope") await onApplied({ scope: value as TransactionScope });
      if (field === "review") {
        await onApplied({ reviewState: value as TransactionReviewState });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/7 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <p className="shrink-0 text-sm font-medium">{count} selected</p>
        <Select
          className="lg:w-40"
          value={field}
          onChange={(event) => {
            setField(event.target.value as typeof field);
            setValue("");
          }}
        >
          <option value="category">Set category</option>
          <option value="scope">Set scope</option>
          <option value="review">Set review state</option>
        </Select>
        <Select
          className="lg:max-w-xs"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">Choose a value</option>
          {field === "category" && categoryOptions(categories)}
          {field === "scope" && (
            <>
              <option value="personal">Personal</option>
              <option value="business">Business</option>
            </>
          )}
          {field === "review" && (
            <>
              <option value="unreviewed">Unreviewed</option>
              <option value="needs_review">Needs review</option>
              <option value="reviewed">Reviewed</option>
            </>
          )}
        </Select>
        <div className="flex gap-2 lg:ml-auto">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!value || saving} onClick={() => void apply()}>
            {saving ? "Applying…" : "Apply safely"}
          </Button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function TransactionDetail({
  categories,
  counterparties,
  onClose,
  transactionId,
  visibleTransactions,
}: {
  categories: Category[];
  counterparties: Counterparty[];
  onClose: () => void;
  transactionId: string | null;
  visibleTransactions: Transaction[];
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: () => api.transaction(transactionId as string),
    enabled: Boolean(transactionId),
  });
  const transaction = detailQuery.data;
  const [narration, setNarration] = useState("");
  const [scope, setScope] = useState<TransactionScope>("personal");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [reviewState, setReviewState] = useState<TransactionReviewState>("unreviewed");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!transaction) return;
    setNarration(transaction.normalizedNarration ?? "");
    setScope(transaction.scope);
    setCategoryId(transaction.category?.id ?? "");
    setCounterpartyId(transaction.counterparty?.id ?? "");
    setReviewState(transaction.reviewState);
    setNote(transaction.note ?? "");
    setError(null);
  }, [transaction]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateTransaction(transactionId as string, {
        normalizedNarration: narration.trim() || null,
        scope,
        categoryId: categoryId || null,
        counterpartyId: counterpartyId || null,
        reviewState,
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      await invalidateTransactionQueries(queryClient, transactionId);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const transferCandidates = transaction
    ? visibleTransactions.filter(
        (candidate) =>
          candidate.id !== transaction.id &&
          candidate.direction !== transaction.direction &&
          candidate.amountMinor === transaction.amountMinor &&
          candidate.currency === transaction.currency &&
          candidate.account.id !== transaction.account.id,
      )
    : [];

  return (
    <Sheet
      open={Boolean(transactionId)}
      onClose={onClose}
      title={transaction?.normalizedNarration || "Transaction detail"}
      description={
        transaction
          ? `${transaction.account.displayName} · ${formatDateTime(transaction.occurredAt)}`
          : "Loading transaction"
      }
    >
      {detailQuery.isLoading ? (
        <TableState message="Loading transaction…" />
      ) : detailQuery.error || !transaction ? (
        <TableState tone="danger" message={errorMessage(detailQuery.error)} />
      ) : (
        <div className="space-y-6 p-5">
          <div className="flex items-end justify-between gap-4 rounded-xl border border-border bg-muted/30 p-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {transaction.direction === "debit" ? "Money out" : "Money in"}
              </p>
              <p className="font-tabular mt-1 text-2xl font-semibold tracking-tight">
                {formatMoney(transaction.amountMinor, transaction.currency)}
              </p>
            </div>
            <CategoryPill
              name={transaction.category?.name ?? "Unclassified"}
              needsReview={transaction.reviewState === "needs_review"}
            />
          </div>

          <section>
            <SectionHeading icon={NotePencil} title="Clarify this transaction" />
            <div className="mt-3 grid gap-4">
              <FilterField label="Description">
                <Input value={narration} onChange={(event) => setNarration(event.target.value)} />
              </FilterField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FilterField label="Category">
                  <Select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
                    <option value="">Unclassified</option>
                    {categoryOptions(categories)}
                  </Select>
                </FilterField>
                <FilterField label="Scope">
                  <Select
                    value={scope}
                    onChange={(event) => setScope(event.target.value as TransactionScope)}
                  >
                    <option value="personal">Personal</option>
                    <option value="business">Business</option>
                  </Select>
                </FilterField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FilterField label="Counterparty">
                  <Select
                    value={counterpartyId}
                    onChange={(event) => setCounterpartyId(event.target.value)}
                  >
                    <option value="">No counterparty</option>
                    {counterparties.map((counterparty) => (
                      <option key={counterparty.id} value={counterparty.id}>
                        {counterparty.displayName}
                      </option>
                    ))}
                  </Select>
                </FilterField>
                <FilterField label="Review state">
                  <Select
                    value={reviewState}
                    onChange={(event) =>
                      setReviewState(event.target.value as TransactionReviewState)
                    }
                  >
                    <option value="unreviewed">Unreviewed</option>
                    <option value="needs_review">Needs review</option>
                    <option value="reviewed">Reviewed</option>
                  </Select>
                </FilterField>
              </div>
              <FilterField label="Private note">
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add context for your future self"
                />
              </FilterField>
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button
                className="justify-self-end"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                <Check />
                {saveMutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </section>

          <SplitEditor transaction={transaction} categories={categories} />

          <section>
            <SectionHeading icon={ArrowsLeftRight} title="Internal transfer" />
            <div className="mt-3 rounded-xl border border-border p-4">
              {transaction.transfer.status === "confirmed" ? (
                <p className="text-sm">
                  Confirmed pair:{" "}
                  <span className="font-mono text-xs">
                    {transaction.transfer.pairedTransactionId}
                  </span>
                </p>
              ) : transferCandidates.length > 0 ? (
                <TransferConfirmation transaction={transaction} candidates={transferCandidates} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No equal and opposite transaction is visible on this page. Adjust filters to find
                  the other side.
                </p>
              )}
            </div>
          </section>

          <section>
            <SectionHeading icon={Scales} title="Original statement values" />
            <div className="mt-3 rounded-xl border border-border bg-muted/25 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Read-only source
              </p>
              <dl className="mt-3 grid gap-3 text-sm">
                <SourceValue label="Narration" value={transaction.source.rawNarration ?? "—"} />
                <SourceValue label="Statement time" value={transaction.source.sourceTimestamp} />
                <SourceValue label="Reference" value={transaction.sourceReference ?? "—"} />
                <SourceValue
                  label="Import provenance"
                  value={`${transaction.source.importIds.length} linked import${transaction.source.importIds.length === 1 ? "" : "s"}`}
                />
              </dl>
            </div>
          </section>

          <section className="rounded-xl border border-border p-4 text-xs text-muted-foreground">
            <p>
              Classification: <span className="capitalize">{transaction.confidence}</span> via{" "}
              {transaction.classificationSource}.
            </p>
            {transaction.classificationExplanation && (
              <p className="mt-1">{transaction.classificationExplanation}</p>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

function SplitEditor({
  categories,
  transaction,
}: {
  categories: Category[];
  transaction: Transaction;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(transaction.splits.length > 0);
  const [rows, setRows] = useState(() => initialSplits(transaction));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRows(initialSplits(transaction)), [transaction]);

  const mutation = useMutation({
    mutationFn: () =>
      api.replaceTransactionSplits(transaction.id, {
        splits: rows.map((row) => ({
          amountMinor: parseMoneyInput(row.amount),
          categoryId: row.categoryId,
          scope: row.scope,
          note: row.note.trim() || null,
        })),
      }),
    onSuccess: async () => {
      setError(null);
      await invalidateTransactionQueries(queryClient, transaction.id);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (!open) {
    return (
      <section>
        <SectionHeading icon={SlidersHorizontal} title="Split transaction" />
        <Button variant="outline" className="mt-3" onClick={() => setOpen(true)}>
          <Plus />
          Split across categories or scopes
        </Button>
      </section>
    );
  }

  const total = rows.reduce((sum, row) => sum + parseMoneyInput(row.amount), 0);
  const balanced = total === transaction.amountMinor && rows.every((row) => row.categoryId);

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <SectionHeading icon={SlidersHorizontal} title="Split transaction" />
        <p
          className={cn(
            "font-tabular text-xs",
            balanced ? "text-success" : "text-muted-foreground",
          )}
        >
          {formatMoney(total, transaction.currency)} /{" "}
          {formatMoney(transaction.amountMinor, transaction.currency)}
        </p>
      </div>
      <div className="mt-3 space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.key}
            className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-2"
          >
            <FilterField label={`Amount ${index + 1}`}>
              <Input
                inputMode="decimal"
                value={row.amount}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.key === row.key ? { ...item, amount: event.target.value } : item,
                    ),
                  )
                }
              />
            </FilterField>
            <FilterField label="Category">
              <Select
                value={row.categoryId}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.key === row.key ? { ...item, categoryId: event.target.value } : item,
                    ),
                  )
                }
              >
                <option value="">Choose category</option>
                {categoryOptions(categories)}
              </Select>
            </FilterField>
            <FilterField label="Scope">
              <Select
                value={row.scope}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.key === row.key
                        ? { ...item, scope: event.target.value as TransactionScope }
                        : item,
                    ),
                  )
                }
              >
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </Select>
            </FilterField>
            <FilterField label="Split note">
              <Input
                value={row.note}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.key === row.key ? { ...item, note: event.target.value } : item,
                    ),
                  )
                }
              />
            </FilterField>
            {rows.length > 2 && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start text-danger"
                onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
              >
                Remove split
              </Button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  key: crypto.randomUUID(),
                  amount: "0.00",
                  categoryId: "",
                  scope: transaction.scope,
                  note: "",
                },
              ])
            }
          >
            <Plus />
            Add split
          </Button>
          <Button
            size="sm"
            disabled={!balanced || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Saving…" : "Save balanced split"}
          </Button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </section>
  );
}

function TransferConfirmation({
  candidates,
  transaction,
}: {
  candidates: Transaction[];
  transaction: Transaction;
}) {
  const queryClient = useQueryClient();
  const [pairedId, setPairedId] = useState(candidates[0]?.id ?? "");
  const mutation = useMutation({
    mutationFn: () => api.confirmTransfer(transaction.id, pairedId),
    onSuccess: async () => {
      await invalidateTransactionQueries(queryClient, transaction.id);
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Confirm both sides to exclude this movement from spending and income.
      </p>
      <Select value={pairedId} onChange={(event) => setPairedId(event.target.value)}>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.account.displayName} · {formatDateTime(candidate.occurredAt)} ·{" "}
            {candidate.normalizedNarration ?? "Untitled"}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        disabled={!pairedId || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <ArrowsLeftRight />
        {mutation.isPending ? "Confirming…" : "Confirm internal transfer"}
      </Button>
      {mutation.error && <p className="text-sm text-danger">{errorMessage(mutation.error)}</p>}
    </div>
  );
}

function TaxonomyManager({ onClose, open }: { onClose: () => void; open: boolean }) {
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
    enabled: open,
  });
  const counterpartiesQuery = useQuery({
    queryKey: ["counterparties"],
    queryFn: api.counterparties,
    enabled: open,
  });
  const categories = categoriesQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];
  const [categoryName, setCategoryName] = useState("");
  const [parentId, setParentId] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const selectedCategory = categories.find(({ id }) => id === selectedCategoryId);
  const selectedCounterparty = counterparties.find(({ id }) => id === selectedCounterpartyId);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["categories"] }),
      queryClient.invalidateQueries({ queryKey: ["counterparties"] }),
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
    ]);
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Categories and counterparties"
      description="Organize normalized values without changing the original statement."
      wide
    >
      <div className="space-y-8 p-5">
        <section>
          <SectionHeading icon={Tag} title="Categories" />
          <form
            className="mt-3 grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!categoryName.trim()) return;
              void run(
                () =>
                  api.createCategory({
                    name: categoryName,
                    parentId: parentId || null,
                  }),
                "Category created.",
              ).then(() => {
                setCategoryName("");
                setParentId("");
              });
            }}
          >
            <FilterField label="New category name">
              <Input
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
              />
            </FilterField>
            <FilterField label="Parent">
              <Select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">Top level</option>
                {categoryOptions(categories)}
              </Select>
            </FilterField>
            <Button className="self-end" disabled={!categoryName.trim()}>
              <Plus />
              Create
            </Button>
          </form>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={cn(
                    "flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-sm last:border-0 hover:bg-muted/40",
                    selectedCategoryId === category.id && "bg-primary/8",
                  )}
                  onClick={() => {
                    setSelectedCategoryId(category.id);
                    setCategoryName(category.name);
                    setParentId(category.parentId ?? "");
                  }}
                >
                  <span>
                    <span className={cn("font-medium", category.archivedAt && "line-through")}>
                      {category.name}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {category.transactionCount}
                    </span>
                  </span>
                  {category.parentId && (
                    <span className="text-xs text-muted-foreground">Nested</span>
                  )}
                </button>
              ))}
            </div>
            <div className="rounded-xl border border-border p-4">
              {selectedCategory ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Edit {selectedCategory.name}</p>
                  <Input
                    value={categoryName}
                    onChange={(event) => setCategoryName(event.target.value)}
                  />
                  <Select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                    <option value="">Top level (promoted)</option>
                    {categoryOptions(categories.filter(({ id }) => id !== selectedCategory.id))}
                  </Select>
                  <Button
                    size="sm"
                    onClick={() =>
                      void run(
                        () =>
                          api.updateCategory(selectedCategory.id, {
                            name: categoryName,
                            parentId: parentId || null,
                          }),
                        parentId ? "Category updated." : "Category promoted.",
                      )
                    }
                  >
                    Save name and nesting
                  </Button>
                  <div className="border-t border-border pt-3">
                    <Label className="text-xs">Merge into</Label>
                    <div className="mt-2 flex gap-2">
                      <Select
                        value={mergeTargetId}
                        onChange={(event) => setMergeTargetId(event.target.value)}
                      >
                        <option value="">Choose target</option>
                        {categoryOptions(
                          categories.filter(
                            ({ id, archivedAt }) => id !== selectedCategory.id && !archivedAt,
                          ),
                        )}
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!mergeTargetId}
                        onClick={() =>
                          void run(
                            () => api.mergeCategory(selectedCategory.id, mergeTargetId),
                            "Categories merged.",
                          )
                        }
                      >
                        Merge
                      </Button>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() =>
                      void run(
                        () =>
                          api.updateCategory(selectedCategory.id, {
                            archived: !selectedCategory.archivedAt,
                          }),
                        selectedCategory.archivedAt ? "Category restored." : "Category archived.",
                      )
                    }
                  >
                    {selectedCategory.archivedAt ? "Restore category" : "Archive category"}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a category to rename, nest, promote, merge, or archive it.
                </p>
              )}
            </div>
          </div>
        </section>

        <section>
          <SectionHeading icon={NotePencil} title="Counterparties" />
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!counterpartyName.trim()) return;
              void run(
                () =>
                  selectedCounterparty
                    ? api.updateCounterparty(selectedCounterparty.id, {
                        displayName: counterpartyName,
                      })
                    : api.createCounterparty({
                        displayName: counterpartyName,
                        kind: "unknown",
                      }),
                selectedCounterparty ? "Counterparty renamed." : "Counterparty created.",
              ).then(() => {
                setCounterpartyName("");
                setSelectedCounterpartyId("");
              });
            }}
          >
            <Input
              value={counterpartyName}
              onChange={(event) => setCounterpartyName(event.target.value)}
              placeholder="Counterparty name"
            />
            <Button disabled={!counterpartyName.trim()}>
              {selectedCounterparty ? "Rename" : "Create"}
            </Button>
          </form>
          <div className="mt-3 flex max-h-52 flex-wrap gap-2 overflow-y-auto">
            {counterparties.map((counterparty) => (
              <button
                type="button"
                key={counterparty.id}
                className={cn(
                  "rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted",
                  selectedCounterpartyId === counterparty.id && "border-primary bg-primary/8",
                )}
                onClick={() => {
                  setSelectedCounterpartyId(counterparty.id);
                  setCounterpartyName(counterparty.displayName);
                }}
              >
                {counterparty.displayName} · {counterparty.transactionCount}
              </button>
            ))}
          </div>
        </section>
        {message && (
          <p
            className={cn(
              "rounded-lg bg-muted p-3 text-sm",
              message.toLocaleLowerCase().includes("could") && "text-danger",
            )}
          >
            {message}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function FilterField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      {children}
    </fieldset>
  );
}

function SortButton({
  active,
  direction,
  label,
  onClick,
}: {
  active: boolean;
  direction: "asc" | "desc";
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="inline-flex items-center gap-1" onClick={onClick}>
      {label}
      {active &&
        (direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}

function DateCell({ compact = false, value }: { compact?: boolean; value: string }) {
  const date = new Date(value);
  return (
    <span className={cn("text-muted-foreground", compact && "text-xs")}>
      {new Intl.DateTimeFormat("en-NG", {
        day: "2-digit",
        month: "short",
        year: compact ? undefined : "numeric",
      }).format(date)}
    </span>
  );
}

function CategoryPill({ name, needsReview }: { name: string; needsReview: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-40 truncate rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground",
        needsReview && "bg-attention/12 text-attention",
      )}
    >
      {name}
    </span>
  );
}

function SectionHeading({ icon: IconComponent, title }: { icon: Icon; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <IconComponent className="size-4 text-primary" />
      {title}
    </h3>
  );
}

function SourceValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function TableState({
  message,
  tone = "neutral",
}: {
  message: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cn(
        "grid min-h-56 place-items-center p-8 text-sm text-muted-foreground",
        tone === "danger" && "text-danger",
      )}
    >
      {message}
    </div>
  );
}

function categoryOptions(categories: Category[]) {
  const active = categories.filter(({ archivedAt }) => !archivedAt);
  return active.map((category) => {
    const parent = categories.find(({ id }) => id === category.parentId);
    return (
      <option key={category.id} value={category.id}>
        {parent ? `${parent.name} / ` : ""}
        {category.name}
      </option>
    );
  });
}

function initialSplits(transaction: Transaction) {
  if (transaction.splits.length > 0) {
    return transaction.splits.map((split) => ({
      key: split.id,
      amount: minorToInput(split.amountMinor),
      categoryId: split.category.id,
      scope: split.scope,
      note: split.note ?? "",
    }));
  }
  const first = Math.ceil(transaction.amountMinor / 2);
  return [
    {
      key: crypto.randomUUID(),
      amount: minorToInput(first),
      categoryId: transaction.category?.id ?? "",
      scope: transaction.scope,
      note: "",
    },
    {
      key: crypto.randomUUID(),
      amount: minorToInput(transaction.amountMinor - first),
      categoryId: "",
      scope: transaction.scope,
      note: "",
    },
  ];
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

function minorToInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

function parseMoneyInput(value: string): number {
  const normalized = value.replaceAll(",", "").trim();
  if (!/^\d*(?:\.\d{0,2})?$/.test(normalized) || !normalized) return 0;
  const [major = "0", fraction = ""] = normalized.split(".");
  return Number(major) * 100 + Number(fraction.padEnd(2, "0"));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function invalidateTransactionQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  transactionId: string | null,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["transactions"] }),
    transactionId
      ? queryClient.invalidateQueries({ queryKey: ["transaction", transactionId] })
      : Promise.resolve(),
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "The action could not be completed.";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function dateValue(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function currencyValue(value: unknown): string | undefined {
  const text = stringValue(value)?.toUpperCase();
  return text && /^[A-Z]{3}$/.test(text) ? text : undefined;
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
