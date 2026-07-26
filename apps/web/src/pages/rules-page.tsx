import {
  ArrowDown,
  ArrowUp,
  Eye,
  FloppyDisk,
  Info,
  MagicWand,
  PencilSimple,
  Plus,
  Power,
  Trash,
  X,
} from "@phosphor-icons/react";
import type {
  ClassificationCondition,
  ClassificationPreview,
  ClassificationRule,
  ClassificationRuleDraft,
  ClassificationRuleKind,
  TransactionScope,
  TransactionType,
} from "@spendlens/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

type RuleField = ClassificationCondition["field"];
type RuleOperator = ClassificationCondition["operator"];

interface ConditionForm {
  key: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  minimum: string;
  maximum: string;
}

interface RuleForm {
  name: string;
  kind: ClassificationRuleKind;
  priority: string;
  enabled: boolean;
  conditions: ConditionForm[];
  categoryId: string;
  counterpartyId: string;
  transactionType: "" | TransactionType;
  scope: "" | TransactionScope;
}

const fieldLabels: Record<RuleField, string> = {
  narration: "Narration",
  direction: "Direction",
  amount_minor: "Amount",
  currency: "Currency",
  account_id: "Account ID",
  institution_name: "Institution",
  counterparty_id: "Counterparty ID",
  transaction_type: "Transaction type",
  scope: "Scope",
};

const operatorLabels: Record<RuleOperator, string> = {
  equals: "Equals",
  contains: "Contains",
  starts_with: "Starts with",
  ends_with: "Ends with",
  one_of: "Is one of",
  pattern: "Safe wildcard pattern",
  greater_than: "Greater than",
  greater_than_or_equal: "At least",
  less_than: "Less than",
  less_than_or_equal: "At most",
  amount_range: "Amount range",
};

const stringOperators: RuleOperator[] = [
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "one_of",
  "pattern",
];
const amountOperators: RuleOperator[] = [
  "equals",
  "one_of",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "amount_range",
];

export function RulesPage() {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({
    queryKey: ["classification-rules"],
    queryFn: api.classificationRules,
  });
  const categoriesQuery = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const counterpartiesQuery = useQuery({
    queryKey: ["counterparties"],
    queryFn: api.counterparties,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const rules = rulesQuery.data?.items ?? [];

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["classification-rules"] }),
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      queryClient.invalidateQueries({ queryKey: ["classification-review"] }),
    ]);
  };

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateClassificationRule(id, { enabled }),
    onSuccess: refresh,
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteClassificationRule,
    onSuccess: async () => {
      setEditingId(null);
      await refresh();
    },
  });
  const reorderMutation = useMutation({
    mutationFn: api.reorderClassificationRules,
    onSuccess: refresh,
  });

  function edit(rule: ClassificationRule) {
    setEditingId(rule.id);
    setEditorOpen(true);
  }

  function create() {
    setEditingId(null);
    setEditorOpen(true);
  }

  function move(ruleId: string, offset: -1 | 1) {
    const index = rules.findIndex(({ id }) => id === ruleId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= rules.length) return;
    const ordered = rules.map(({ id }) => id);
    const [moved] = ordered.splice(index, 1);
    if (!moved) return;
    ordered.splice(target, 0, moved);
    reorderMutation.mutate(ordered);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Classification memory</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Rules</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Inspect exactly why SpendLens classifies known activity. Priority wins first, then
            specificity; equally ranked disagreements are sent to Review.
          </p>
        </div>
        <Button onClick={create}>
          <Plus />
          New rule
        </Button>
      </header>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex gap-3">
          <Info className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium">Transparent and deterministic</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Exact and counterparty rules are high confidence. Bank rules are medium confidence,
              while wildcard patterns are treated cautiously. Confirmed manual decisions always
              remain authoritative.
            </p>
          </div>
        </div>
      </div>

      {rulesQuery.isLoading ? (
        <PageState message="Loading rules…" />
      ) : rulesQuery.error ? (
        <PageState tone="danger" message={errorMessage(rulesQuery.error)} />
      ) : rules.length === 0 ? (
        <Card>
          <CardContent className="grid min-h-72 place-items-center p-8">
            <div className="max-w-sm text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
                <MagicWand />
              </span>
              <h2 className="mt-4 font-semibold">No remembered decisions yet</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                Create a rule here, or teach SpendLens from the grouped review queue.
              </p>
              <Button className="mt-5" onClick={create}>
                <Plus />
                Create the first rule
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule, index) => (
            <Card key={rule.id} className={cn(!rule.enabled && "opacity-65")}>
              <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 gap-3">
                  <span className="font-tabular grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-medium">{rule.name}</h2>
                      <RuleBadge>{rule.kind}</RuleBadge>
                      <RuleBadge>{rule.enabled ? "Enabled" : "Disabled"}</RuleBadge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {describeRule(rule)} · {rule.matchCount} current{" "}
                      {rule.matchCount === 1 ? "match" : "matches"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Priority {rule.priority} · Specificity {rule.specificity}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${rule.name} up`}
                    disabled={index === 0 || reorderMutation.isPending}
                    onClick={() => move(rule.id, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${rule.name} down`}
                    disabled={index === rules.length - 1 || reorderMutation.isPending}
                    onClick={() => move(rule.id, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="outline"
                    disabled={toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled })}
                  >
                    <Power />
                    {rule.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="outline" onClick={() => edit(rule)}>
                    <PencilSimple />
                    Edit
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${rule.name}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete “${rule.name}”? Existing matches will be recalculated.`,
                        )
                      ) {
                        deleteMutation.mutate(rule.id);
                      }
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(toggleMutation.error || deleteMutation.error || reorderMutation.error) && (
        <p className="text-sm text-danger">
          {errorMessage(toggleMutation.error ?? deleteMutation.error ?? reorderMutation.error)}
        </p>
      )}

      <RuleEditor
        open={editorOpen}
        rule={rules.find(({ id }) => id === editingId) ?? null}
        categories={categoriesQuery.data?.items ?? []}
        counterparties={counterpartiesQuery.data?.items ?? []}
        onClose={() => setEditorOpen(false)}
        onSaved={async () => {
          setEditorOpen(false);
          await refresh();
        }}
      />
    </div>
  );
}

function RuleEditor({
  open,
  rule,
  categories,
  counterparties,
  onClose,
  onSaved,
}: {
  open: boolean;
  rule: ClassificationRule | null;
  categories: Array<{ id: string; name: string; archivedAt: string | null }>;
  counterparties: Array<{ id: string; displayName: string }>;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [form, setForm] = useState<RuleForm>(() => emptyRuleForm());
  const [preview, setPreview] = useState<ClassificationPreview | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(rule ? formFromRule(rule) : emptyRuleForm());
    setPreview(null);
    setFormError(null);
  }, [open, rule]);

  const draft = useMemo(() => {
    try {
      return draftFromForm(form);
    } catch {
      return null;
    }
  }, [form]);

  const previewMutation = useMutation({
    mutationFn: () => {
      const value = draftFromForm(form);
      return api.previewClassificationRule({ ...value, ...(rule ? { ruleId: rule.id } : {}) });
    },
    onSuccess: (result) => {
      setFormError(null);
      setPreview(result);
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveMutation = useMutation({
    mutationFn: () => {
      const value = draftFromForm(form);
      return rule
        ? api.updateClassificationRule(rule.id, value)
        : api.createClassificationRule(value);
    },
    onSuccess: onSaved,
    onError: (error) => setFormError(errorMessage(error)),
  });

  function updateCondition(key: string, changes: Partial<ConditionForm>) {
    setForm((current) => ({
      ...current,
      conditions: current.conditions.map((condition) =>
        condition.key === key ? { ...condition, ...changes } : condition,
      ),
    }));
    setPreview(null);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={rule ? "Edit classification rule" : "Create classification rule"}
      description="Rules use structured conditions. Wildcard patterns support * and ? without raw regular expressions."
    >
      <div className="space-y-6 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rule name">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Rule type">
            <Select
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as ClassificationRuleKind })
              }
            >
              <option value="exact">Exact</option>
              <option value="pattern">Pattern</option>
              <option value="counterparty">Counterparty mapping</option>
              <option value="bank">Bank rule</option>
            </Select>
          </Field>
          <Field label="Priority">
            <Input
              type="number"
              min={-1000}
              max={1000}
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <div className="flex h-9 items-center gap-3 rounded-lg border px-3 text-sm">
              <Checkbox
                aria-label="Enable rule immediately"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm({ ...form, enabled: checked === true })}
              />
              Enable immediately
            </div>
          </div>
        </div>

        <section>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">When all conditions match</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Add narrow conditions to increase specificity.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setForm({
                  ...form,
                  conditions: [...form.conditions, emptyCondition()],
                })
              }
            >
              <Plus />
              Condition
            </Button>
          </div>
          <div className="mt-3 space-y-3">
            {form.conditions.map((condition) => (
              <div key={condition.key} className="rounded-xl border p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Select
                    aria-label="Condition field"
                    value={condition.field}
                    onChange={(event) => {
                      const field = event.target.value as RuleField;
                      updateCondition(condition.key, {
                        field,
                        operator: field === "amount_minor" ? "amount_range" : "equals",
                      });
                    }}
                  >
                    {(Object.keys(fieldLabels) as RuleField[]).map((field) => (
                      <option key={field} value={field}>
                        {fieldLabels[field]}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="Condition operator"
                    value={condition.operator}
                    onChange={(event) =>
                      updateCondition(condition.key, {
                        operator: event.target.value as RuleOperator,
                      })
                    }
                  >
                    {(condition.field === "amount_minor" ? amountOperators : stringOperators).map(
                      (operator) => (
                        <option key={operator} value={operator}>
                          {operatorLabels[operator]}
                        </option>
                      ),
                    )}
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove condition"
                    disabled={form.conditions.length === 1}
                    onClick={() =>
                      setForm({
                        ...form,
                        conditions: form.conditions.filter(({ key }) => key !== condition.key),
                      })
                    }
                  >
                    <X />
                  </Button>
                </div>
                <div className="mt-3">
                  {condition.operator === "amount_range" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        inputMode="decimal"
                        placeholder="Minimum amount"
                        value={condition.minimum}
                        onChange={(event) =>
                          updateCondition(condition.key, { minimum: event.target.value })
                        }
                      />
                      <Input
                        inputMode="decimal"
                        placeholder="Maximum amount"
                        value={condition.maximum}
                        onChange={(event) =>
                          updateCondition(condition.key, { maximum: event.target.value })
                        }
                      />
                    </div>
                  ) : (
                    <Input
                      value={condition.value}
                      placeholder={
                        condition.operator === "one_of"
                          ? "Comma-separated values"
                          : condition.operator === "pattern"
                            ? "Example: *transfer*chidi*"
                            : "Match value"
                      }
                      onChange={(event) =>
                        updateCondition(condition.key, { value: event.target.value })
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold">Then apply</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            At least one action is required. Leave fields blank to preserve their current value.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select
                value={form.categoryId}
                onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
              >
                <option value="">Keep current category</option>
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
                value={form.counterpartyId}
                onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}
              >
                <option value="">Keep current counterparty</option>
                {counterparties.map((counterparty) => (
                  <option key={counterparty.id} value={counterparty.id}>
                    {counterparty.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Transaction type">
              <Select
                value={form.transactionType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    transactionType: event.target.value as RuleForm["transactionType"],
                  })
                }
              >
                <option value="">Keep current type</option>
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
                value={form.scope}
                onChange={(event) =>
                  setForm({ ...form, scope: event.target.value as RuleForm["scope"] })
                }
              >
                <option value="">Keep current scope</option>
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </Select>
            </Field>
          </div>
        </section>

        {formError && <p className="text-sm text-danger">{formError}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!draft || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            <Eye />
            {previewMutation.isPending ? "Checking…" : "Preview matches"}
          </Button>
          <Button disabled={!draft || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            <FloppyDisk />
            {saveMutation.isPending ? "Saving…" : rule ? "Save changes" : "Create rule"}
          </Button>
        </div>

        {preview && <RulePreview preview={preview} />}
      </div>
    </Sheet>
  );
}

function RulePreview({ preview }: { preview: ClassificationPreview }) {
  return (
    <section className="rounded-xl border bg-muted/20 p-4">
      <h3 className="text-sm font-semibold">
        {preview.matchCount} {preview.matchCount === 1 ? "match" : "matches"} ·{" "}
        {preview.changeCount} would change
      </h3>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
        {preview.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No current transactions match this rule.</p>
        ) : (
          preview.items.map((item) => (
            <div key={item.transactionId} className="rounded-lg border bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.narration}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(item.occurredAt).toLocaleDateString("en-NG")}
                  </p>
                </div>
                <p className="font-tabular shrink-0 text-sm">
                  {formatMoney(item.amountMinor, item.currency)}
                </p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {item.wouldChange ? "Classification would change." : "Already has this result."}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
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

function RuleBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
      {children}
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

function emptyRuleForm(): RuleForm {
  return {
    name: "",
    kind: "exact",
    priority: "0",
    enabled: true,
    conditions: [emptyCondition()],
    categoryId: "",
    counterpartyId: "",
    transactionType: "",
    scope: "",
  };
}

function emptyCondition(): ConditionForm {
  return {
    key: crypto.randomUUID(),
    field: "narration",
    operator: "equals",
    value: "",
    minimum: "",
    maximum: "",
  };
}

function formFromRule(rule: ClassificationRule): RuleForm {
  return {
    name: rule.name,
    kind: rule.kind,
    priority: String(rule.priority),
    enabled: rule.enabled,
    conditions: rule.conditions.map((condition) => conditionForm(condition)),
    categoryId: rule.action.categoryId ?? "",
    counterpartyId: rule.action.counterpartyId ?? "",
    transactionType: rule.action.transactionType ?? "",
    scope: rule.action.scope ?? "",
  };
}

function conditionForm(condition: ClassificationCondition): ConditionForm {
  if (condition.operator === "amount_range") {
    return {
      key: crypto.randomUUID(),
      field: condition.field,
      operator: condition.operator,
      value: "",
      minimum: condition.minimum === undefined ? "" : minorToInput(condition.minimum),
      maximum: condition.maximum === undefined ? "" : minorToInput(condition.maximum),
    };
  }
  if (condition.operator === "one_of") {
    return {
      key: crypto.randomUUID(),
      field: condition.field,
      operator: condition.operator,
      value: condition.values
        .map((value) => (condition.field === "amount_minor" ? minorToInput(Number(value)) : value))
        .join(", "),
      minimum: "",
      maximum: "",
    };
  }
  return {
    key: crypto.randomUUID(),
    field: condition.field,
    operator: condition.operator,
    value:
      condition.field === "amount_minor"
        ? minorToInput(Number(condition.value))
        : String(condition.value),
    minimum: "",
    maximum: "",
  };
}

function draftFromForm(form: RuleForm): ClassificationRuleDraft {
  const action = {
    ...(form.categoryId ? { categoryId: form.categoryId } : {}),
    ...(form.counterpartyId ? { counterpartyId: form.counterpartyId } : {}),
    ...(form.transactionType ? { transactionType: form.transactionType } : {}),
    ...(form.scope ? { scope: form.scope } : {}),
  };
  if (Object.keys(action).length === 0) throw new Error("Choose at least one action.");
  return {
    name: form.name.trim(),
    kind: form.kind,
    priority: Number(form.priority),
    enabled: form.enabled,
    conditions: form.conditions.map(toCondition),
    action,
  };
}

function toCondition(condition: ConditionForm): ClassificationCondition {
  if (condition.operator === "amount_range") {
    return {
      field: "amount_minor",
      operator: "amount_range",
      ...(condition.minimum ? { minimum: parseMoneyInput(condition.minimum) } : {}),
      ...(condition.maximum ? { maximum: parseMoneyInput(condition.maximum) } : {}),
    };
  }
  if (
    condition.operator === "greater_than" ||
    condition.operator === "greater_than_or_equal" ||
    condition.operator === "less_than" ||
    condition.operator === "less_than_or_equal"
  ) {
    return {
      field: "amount_minor",
      operator: condition.operator,
      value: parseMoneyInput(condition.value),
    };
  }
  if (condition.operator === "one_of") {
    return {
      field: condition.field,
      operator: "one_of",
      values: condition.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (condition.field === "amount_minor" ? parseMoneyInput(value) : value)),
    };
  }
  return {
    field: condition.field,
    operator: condition.operator,
    value:
      condition.field === "amount_minor"
        ? String(parseMoneyInput(condition.value))
        : condition.value.trim(),
  };
}

function describeRule(rule: ClassificationRule): string {
  return rule.conditions
    .slice(0, 2)
    .map(
      ({ field, operator }) =>
        `${fieldLabels[field]} ${operatorLabels[operator].toLocaleLowerCase()}`,
    )
    .join(" and ");
}

function parseMoneyInput(value: string): number {
  const normalized = value.replaceAll(",", "").trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error("Enter a valid amount.");
  const [major = "0", fraction = ""] = normalized.split(".");
  return Number(major) * 100 + Number(fraction.padEnd(2, "0"));
}

function minorToInput(value: number): string {
  return (value / 100).toFixed(2);
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amountMinor / 100);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "The action could not be completed.";
}
