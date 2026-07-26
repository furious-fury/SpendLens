import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  CheckCircle,
  Info,
  MagicWand,
  PencilSimple,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import type {
  ApplyReviewDecision,
  ClassificationAction,
  ReviewApplyScope,
  ReviewGroup,
  TransactionScope,
  TransactionType,
} from "@spendlens/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DecisionEditorState {
  group: ReviewGroup;
  decision: "accept" | "change";
  selectedIds: string[];
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({
    queryKey: ["classification-review"],
    queryFn: api.reviewGroups,
  });
  const categoriesQuery = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const counterpartiesQuery = useQuery({
    queryKey: ["counterparties"],
    queryFn: api.counterparties,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [editor, setEditor] = useState<DecisionEditorState | null>(null);
  const [undoAction, setUndoAction] = useState<{ id: string; count: number } | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["classification-review"] }),
      queryClient.invalidateQueries({ queryKey: ["classification-rules"] }),
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
    ]);
  };
  const ignoreMutation = useMutation({
    mutationFn: (group: ReviewGroup) =>
      api.applyReviewDecision({
        groupKey: group.key,
        decision: "ignore",
        applyScope: "existing_matches",
        rememberForFuture: false,
      }),
    onSuccess: async (result) => {
      setUndoAction({ id: result.actionId, count: result.affectedCount });
      await refresh();
    },
  });
  const undoMutation = useMutation({
    mutationFn: api.undoReviewDecision,
    onSuccess: async () => {
      setUndoAction(null);
      await refresh();
    },
  });

  const groups = groupsQuery.data?.items ?? [];
  const total = groupsQuery.data?.totalTransactions ?? 0;

  function toggleExpanded(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelected(groupKey: string, transactionId: string) {
    setSelected((current) => {
      const next = new Set(current[groupKey] ?? []);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      return { ...current, [groupKey]: next };
    });
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Classification quality</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Review uncertain activity</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Similar transactions are grouped so one clear decision can fix selected activity,
            current matches, or future matches.
          </p>
        </div>
        <div className="rounded-xl border bg-muted/30 px-4 py-3">
          <p className="font-tabular text-2xl font-semibold">{total}</p>
          <p className="text-xs text-muted-foreground">transactions need attention</p>
        </div>
      </header>

      {undoAction && (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Review decision applied</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {undoAction.count} {undoAction.count === 1 ? "transaction was" : "transactions were"}{" "}
              updated. You can reverse the complete action.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={undoMutation.isPending}
            onClick={() => undoMutation.mutate(undoAction.id)}
          >
            <ArrowCounterClockwise />
            {undoMutation.isPending ? "Undoing…" : "Undo"}
          </Button>
        </div>
      )}

      {groupsQuery.isLoading ? (
        <PageState message="Building review groups…" />
      ) : groupsQuery.error ? (
        <PageState tone="danger" message={errorMessage(groupsQuery.error)} />
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="grid min-h-72 place-items-center p-8">
            <div className="max-w-sm text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl bg-success/10 text-success">
                <CheckCircle />
              </span>
              <h2 className="mt-4 font-semibold">Review queue is clear</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                New uncertain imports and rule conflicts will appear here with concise evidence.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const isExpanded = expanded.has(group.key);
            const selectedIds = [...(selected[group.key] ?? new Set<string>())];
            return (
              <Card key={group.key} className={cn(group.hasConflict && "border-attention/40")}>
                <CardHeader className="gap-3">
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {group.hasConflict ? (
                          <Warning className="size-5 text-attention" />
                        ) : (
                          <Sparkle className="size-5 text-primary" />
                        )}
                        <CardTitle className="truncate">{group.label}</CardTitle>
                        <ConfidenceBadge confidence={group.confidence} />
                        <span className="rounded-full border px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                          {group.basis}
                        </span>
                      </div>
                      <CardDescription className="mt-2">
                        {group.transactionCount}{" "}
                        {group.transactionCount === 1 ? "transaction" : "transactions"} ·{" "}
                        {group.totals.map(formatGroupTotal).join(" · ")}
                      </CardDescription>
                    </div>
                    <Button variant="ghost" onClick={() => toggleExpanded(group.key)}>
                      {isExpanded ? <CaretUp /> : <CaretDown />}
                      {isExpanded ? "Hide activity" : "Show activity"}
                    </Button>
                  </div>
                  <div className="rounded-lg border bg-muted/25 p-3">
                    <div className="flex gap-2">
                      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="space-y-1">
                        {group.evidence.map((item) => (
                          <p
                            key={`${item.code}:${item.ruleId ?? ""}`}
                            className="text-xs leading-5"
                          >
                            {item.label}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isExpanded && (
                    <div className="overflow-hidden rounded-xl border">
                      {group.transactions.map((transaction) => (
                        <div
                          key={transaction.id}
                          className="flex items-start gap-3 border-b p-3 last:border-b-0"
                        >
                          <Checkbox
                            aria-label={`Select ${transaction.narration}`}
                            checked={(selected[group.key] ?? new Set()).has(transaction.id)}
                            onCheckedChange={() => toggleSelected(group.key, transaction.id)}
                            className="mt-1"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{transaction.narration}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {new Date(transaction.occurredAt).toLocaleDateString("en-NG")} ·{" "}
                              {transaction.accountName}
                              {transaction.categoryName ? ` · ${transaction.categoryName}` : ""}
                            </p>
                          </div>
                          <p className="font-tabular shrink-0 text-sm">
                            {formatMoney(transaction.amountMinor, transaction.currency)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={!group.suggestion || group.hasConflict}
                      onClick={() =>
                        setEditor({
                          group,
                          decision: "accept",
                          selectedIds,
                        })
                      }
                    >
                      <CheckCircle />
                      Accept all
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEditor({
                          group,
                          decision: "change",
                          selectedIds,
                        })
                      }
                    >
                      <PencilSimple />
                      {selectedIds.length > 0
                        ? `Change ${selectedIds.length} selected`
                        : "Change and apply"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={ignoreMutation.isPending}
                      onClick={() => ignoreMutation.mutate(group)}
                    >
                      Ignore group
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {(ignoreMutation.error || undoMutation.error) && (
        <p className="text-sm text-danger">
          {errorMessage(ignoreMutation.error ?? undoMutation.error)}
        </p>
      )}

      <DecisionEditor
        state={editor}
        categories={categoriesQuery.data?.items ?? []}
        counterparties={counterpartiesQuery.data?.items ?? []}
        onClose={() => setEditor(null)}
        onApplied={async (actionId, count) => {
          setEditor(null);
          setUndoAction({ id: actionId, count });
          await refresh();
        }}
      />
    </div>
  );
}

function DecisionEditor({
  state,
  categories,
  counterparties,
  onClose,
  onApplied,
}: {
  state: DecisionEditorState | null;
  categories: Array<{ id: string; name: string; archivedAt: string | null }>;
  counterparties: Array<{ id: string; displayName: string }>;
  onClose(): void;
  onApplied(actionId: string, count: number): Promise<void>;
}) {
  const [applyScope, setApplyScope] = useState<ReviewApplyScope>("future_matches");
  const [remember, setRemember] = useState(true);
  const [ruleName, setRuleName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [transactionType, setTransactionType] = useState<"" | TransactionType>("");
  const [scope, setScope] = useState<"" | TransactionScope>("");

  useEffect(() => {
    if (!state) return;
    setApplyScope(state.selectedIds.length > 0 ? "selected" : "future_matches");
    setRemember(true);
    setRuleName(`Remember ${state.group.label}`);
    setCategoryId(state.group.suggestion?.categoryId ?? "");
    setCounterpartyId(state.group.suggestion?.counterpartyId ?? "");
    setTransactionType(state.group.suggestion?.transactionType ?? "");
    setScope(state.group.suggestion?.scope ?? "");
  }, [state]);

  const mutation = useMutation({
    mutationFn: (input: ApplyReviewDecision) => api.applyReviewDecision(input),
    onSuccess: (result) => onApplied(result.actionId, result.affectedCount),
  });

  if (!state) {
    return (
      <Sheet open={false} onClose={onClose} title="Review decision">
        <div />
      </Sheet>
    );
  }

  const action: ClassificationAction = {
    ...(categoryId ? { categoryId } : {}),
    ...(counterpartyId ? { counterpartyId } : {}),
    ...(transactionType ? { transactionType } : {}),
    ...(scope ? { scope } : {}),
  };
  const needsAction = state.decision === "change";
  const valid = !needsAction || Object.keys(action).length > 0;

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        state.decision === "accept" ? "Accept suggested classification" : "Change classification"
      }
      description="Choose whether this affects selected activity, all current matches, or future matches too."
    >
      <div className="space-y-6 p-5">
        <Card>
          <CardHeader>
            <CardDescription>{state.group.transactionCount} grouped transactions</CardDescription>
            <CardTitle>{state.group.label}</CardTitle>
          </CardHeader>
        </Card>

        {needsAction ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">No category change</option>
                {categories
                  .filter(({ archivedAt }) => !archivedAt)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Counterparty">
              <Select
                value={counterpartyId}
                onChange={(event) => setCounterpartyId(event.target.value)}
              >
                <option value="">No counterparty change</option>
                {counterparties.map((counterparty) => (
                  <option key={counterparty.id} value={counterparty.id}>
                    {counterparty.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Transaction type">
              <Select
                value={transactionType}
                onChange={(event) =>
                  setTransactionType(event.target.value as typeof transactionType)
                }
              >
                <option value="">No type change</option>
                {[
                  "expense",
                  "income",
                  "transfer",
                  "refund",
                  "fee",
                  "cash_withdrawal",
                  "debt",
                  "unclassified",
                ].map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Scope">
              <Select
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <option value="">No scope change</option>
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </Select>
            </Field>
          </div>
        ) : (
          <div className="rounded-xl border bg-muted/20 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Suggested result
            </p>
            <p className="mt-2 text-sm">{describeSuggestion(state.group, categories)}</p>
          </div>
        )}

        <section>
          <h3 className="text-sm font-semibold">Apply to</h3>
          <div className="mt-3 grid gap-2">
            <ScopeOption
              checked={applyScope === "selected"}
              disabled={state.selectedIds.length === 0}
              title={`Selected only (${state.selectedIds.length})`}
              description="Change only the transactions you checked."
              onSelect={() => setApplyScope("selected")}
            />
            <ScopeOption
              checked={applyScope === "existing_matches"}
              title={`All current matches (${state.group.transactionCount})`}
              description="Apply now without remembering the decision for later imports."
              onSelect={() => setApplyScope("existing_matches")}
            />
            <ScopeOption
              checked={applyScope === "future_matches"}
              title="Current and future matches"
              description="Apply now and create a transparent rule for later imports."
              onSelect={() => setApplyScope("future_matches")}
            />
          </div>
        </section>

        {applyScope === "future_matches" && (
          <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <Checkbox
                aria-label="Remember for future transactions"
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">Remember for future transactions</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Enabled by default. The resulting rule remains editable from Rules.
                </span>
              </span>
            </div>
            {remember && (
              <Field label="Rule name">
                <Input value={ruleName} onChange={(event) => setRuleName(event.target.value)} />
              </Field>
            )}
          </section>
        )}

        {mutation.error && <p className="text-sm text-danger">{errorMessage(mutation.error)}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                groupKey: state.group.key,
                decision: state.decision,
                applyScope,
                ...(applyScope === "selected" ? { transactionIds: state.selectedIds } : {}),
                ...(state.decision === "change" ? { action } : {}),
                rememberForFuture: applyScope === "future_matches" && remember,
                ...(applyScope === "future_matches" && remember && ruleName.trim()
                  ? { ruleName: ruleName.trim() }
                  : {}),
              })
            }
          >
            <MagicWand />
            {mutation.isPending ? "Applying…" : "Apply decision"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function ScopeOption({
  checked,
  disabled,
  title,
  description,
  onSelect,
}: {
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "rounded-xl border p-4 text-left transition-colors disabled:opacity-45",
        checked ? "border-primary bg-primary/5" : "hover:bg-muted/40",
      )}
      onClick={onSelect}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: ReviewGroup["confidence"] }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        confidence === "high" && "bg-success/10 text-success",
        confidence === "medium" && "bg-attention/12 text-attention",
        (confidence === "low" || confidence === "unknown") && "bg-muted text-muted-foreground",
      )}
    >
      {confidence} confidence
    </span>
  );
}

function PageState({ message, tone }: { message: string; tone?: "danger" }) {
  return (
    <div
      className={cn(
        "grid min-h-64 place-items-center rounded-xl border p-8 text-sm text-muted-foreground",
        tone === "danger" && "text-danger",
      )}
    >
      {message}
    </div>
  );
}

function formatGroupTotal(total: ReviewGroup["totals"][number]): string {
  const pieces = [];
  if (total.debitMinor > 0) pieces.push(`${formatMoney(total.debitMinor, total.currency)} out`);
  if (total.creditMinor > 0) pieces.push(`${formatMoney(total.creditMinor, total.currency)} in`);
  return pieces.join(", ");
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amountMinor / 100);
}

function describeSuggestion(
  group: ReviewGroup,
  categories: Array<{ id: string; name: string }>,
): string {
  const suggestion = group.suggestion;
  if (!suggestion) return "No single suggestion is available.";
  const values = [
    suggestion.categoryId
      ? categories.find(({ id }) => id === suggestion.categoryId)?.name
      : undefined,
    suggestion.transactionType?.replaceAll("_", " "),
    suggestion.scope,
  ].filter(Boolean);
  return values.join(" · ") || "Preserve the suggested classification.";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "The action could not be completed.";
}
