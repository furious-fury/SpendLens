import type { ImportDeduplicationSummary, ImportPreview } from "@spendlens/contracts";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  FileArrowUp,
  FilePdf,
  WarningCircle,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError, api } from "@/lib/api";
import { formatMoney } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

type DecisionAction = "confirm_duplicate" | "keep_separate" | "skip";
type AttentionItem = ImportDeduplicationSummary["attentionItems"][number];

export function ImportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summary, setSummary] = useState<ImportDeduplicationSummary | null>(null);
  const [decisions, setDecisions] = useState<Record<string, DecisionAction>>({});
  const [confirmUnreconciled, setConfirmUnreconciled] = useState(false);
  const [busy, setBusy] = useState<"upload" | "analyze" | "decide" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const committed = summary?.status === "committed";
  const stage = committed ? 4 : summary ? 3 : preview ? 2 : 1;

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setSummary(null);
    setDecisions({});
    setConfirmUnreconciled(false);
    setError(null);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF statement to continue.");
      return;
    }
    setBusy("upload");
    setError(null);
    try {
      setPreview(await api.createImportPreview(file));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (!preview) return;
    setBusy("analyze");
    setError(null);
    try {
      const result = await api.analyzeImport(preview.id);
      setSummary(result);
      setDecisions(
        Object.fromEntries(
          result.attentionItems
            .filter((item) => item.decision !== "pending")
            .map((item) => [item.decisionId, decisionToAction(item.decision)]),
        ),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function saveDecisions() {
    if (!preview || !summary) return;
    const selected = summary.attentionItems.flatMap((item) => {
      const action = decisions[item.decisionId];
      return action ? [{ decisionId: item.decisionId, action }] : [];
    });
    if (selected.length !== summary.attentionItems.length) {
      setError("Choose an action for every possible duplicate or conflict.");
      return;
    }
    setBusy("decide");
    setError(null);
    try {
      setSummary(await api.decideImport(preview.id, selected));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview || !summary) return;
    if (summary.pendingDecisionCount > 0) {
      setError("Resolve every duplicate decision before importing the statement.");
      return;
    }
    if (preview.requiresConfirmation && !confirmUnreconciled) {
      setError("Confirm the statement total mismatch before importing.");
      return;
    }
    setBusy("commit");
    setError(null);
    try {
      const result = await api.commitImport(preview.id, confirmUnreconciled);
      setSummary(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    chooseFile(null);
  }

  return (
    <div className="space-y-5">
      <ImportSteps stage={stage} />

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/8 p-4 text-sm" role="alert">
          <WarningCircle className="mt-0.5 size-5 shrink-0 text-danger" weight="fill" />
          <p>{error}</p>
        </div>
      )}

      {!preview && (
        <Card>
          <CardHeader>
            <CardTitle>Choose a bank statement</CardTitle>
            <CardDescription>
              PalmPay and OPay PDF statements are supported. The source file is parsed locally and removed after preview.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(event) => void upload(event)}>
              <label className="flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-primary/35 bg-primary/5 p-6 text-center transition-colors hover:bg-primary/8">
                <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  <FileArrowUp className="size-6" weight="bold" />
                </span>
                <span className="mt-4 font-semibold">Select a PDF statement</span>
                <span className="mt-1 text-sm text-muted-foreground">Use a searchable PDF downloaded from your bank.</span>
                <input
                  className="sr-only"
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                />
              </label>
              {file && (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <FilePdf className="size-5 shrink-0 text-primary" weight="bold" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                    </div>
                  </div>
                  <Button type="submit" disabled={busy === "upload"}>
                    {busy === "upload" ? "Reading statement…" : "Create preview"}
                    <ArrowRight />
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {preview && !committed && (
        <PreviewCard preview={preview} summary={summary} onAnalyze={() => void analyze()} busy={busy} />
      )}

      {summary && preview && !committed && (
        <Card>
          <CardHeader>
            <CardTitle>Duplicate review</CardTitle>
            <CardDescription>
              SpendLens found {summary.counts.new} new and {summary.counts.duplicate} exact duplicate transactions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SummaryCounts summary={summary} />
            {summary.attentionItems.length > 0 && (
              <div className="space-y-3">
                {summary.attentionItems.map((item) => (
                  <AttentionDecision
                    key={item.decisionId}
                    item={item}
                    value={decisions[item.decisionId]}
                    onChange={(action) =>
                      setDecisions((current) => ({ ...current, [item.decisionId]: action }))
                    }
                  />
                ))}
                <div className="flex justify-end">
                  <Button onClick={() => void saveDecisions()} disabled={busy === "decide"}>
                    {busy === "decide" ? "Saving decisions…" : "Save duplicate decisions"}
                  </Button>
                </div>
              </div>
            )}

            {preview.requiresConfirmation && (
              <label className="flex items-start gap-3 rounded-xl border border-attention/35 bg-attention/8 p-4 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={confirmUnreconciled}
                  onCheckedChange={(checked) => setConfirmUnreconciled(checked === true)}
                />
                <span>
                  <strong className="block font-medium">Confirm unmatched statement totals</strong>
                  <span className="mt-1 block text-muted-foreground">
                    Parsed inflow or outflow does not match the total declared by the statement.
                  </span>
                </span>
              </label>
            )}

            <div className="flex justify-end border-t border-border pt-4">
              <Button
                onClick={() => void commit()}
                disabled={busy === "commit" || summary.pendingDecisionCount > 0}
              >
                {busy === "commit" ? "Importing…" : "Import statement"}
                <ArrowRight />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {committed && summary.commitResult && (
        <Card className="border-success/35">
          <CardContent className="grid min-h-80 place-items-center p-8 text-center">
            <div className="max-w-lg">
              <span className="mx-auto grid size-14 place-items-center rounded-full bg-success/12 text-success">
                <CheckCircle className="size-8" weight="fill" />
              </span>
              <h2 className="mt-5 text-xl font-semibold">Statement imported</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Created {summary.commitResult.canonicalTransactionsCreated} transactions, linked {summary.commitResult.duplicateSourcesLinked} duplicate sources, and skipped {summary.commitResult.skippedSources} rows.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Button asChild><Link to="/transactions">View transactions <ArrowRight /></Link></Button>
                <Button variant="outline" onClick={reset}><ArrowClockwise />Import another</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ImportSteps({ stage }: { stage: number }) {
  const completedSteps = stage === 4 ? 4 : Math.max(0, stage - 1);

  return (
    <ol
      className="import-steps-progress relative isolate grid overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)] sm:grid-cols-4"
      aria-label="Import progress"
      style={{ "--import-progress": `${completedSteps * 25}%` } as CSSProperties}
    >
      {["Upload", "Preview", "Review", "Complete"].map((label, index) => {
        const step = index + 1;
        const completed = step <= completedSteps;
        const active = step === stage && !completed;

        return (
          <li key={label} className={cn("relative z-10 flex items-center gap-3 border-border px-4 py-3 text-sm sm:border-r sm:last:border-r-0", completed ? "border-primary-foreground/20 text-primary-foreground" : step <= stage ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("grid size-7 place-items-center rounded-full border text-xs font-semibold", completed && "border-primary bg-primary text-primary-foreground", active && "border-primary text-primary")}>
              {completed ? <CheckCircle className="size-4" weight="fill" /> : step}
            </span>
            <span className={cn((active || completed) && "font-semibold")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PreviewCard({ preview, summary, onAnalyze, busy }: { preview: ImportPreview; summary: ImportDeduplicationSummary | null; onAnalyze: () => void; busy: string | null }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle>{preview.institution} statement</CardTitle><CardDescription>{formatDate(preview.statementPeriod.start)} – {formatDate(preview.statementPeriod.end)} · {preview.maskedAccountNumber ?? "Account number unavailable"}</CardDescription></div>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", preview.reconciliation.status === "matched" ? "bg-success/12 text-success" : "bg-attention/12 text-attention")}>{preview.reconciliation.status === "matched" ? "Totals matched" : "Totals differ"}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Fact label="Transactions" value={String(preview.transactionCount)} />
          <Fact label="Money in" value={formatMoney(preview.totals.inflowMinor, preview.totals.currency)} />
          <Fact label="Money out" value={formatMoney(preview.totals.outflowMinor, preview.totals.currency)} />
        </dl>
        {!summary && <div className="flex justify-end"><Button onClick={onAnalyze} disabled={busy === "analyze"}>{busy === "analyze" ? "Checking duplicates…" : "Check for duplicates"}<ArrowRight /></Button></div>}
      </CardContent>
    </Card>
  );
}

function SummaryCounts({ summary }: { summary: ImportDeduplicationSummary }) {
  const counts = [["New", summary.counts.new], ["Duplicates", summary.counts.duplicate], ["Needs review", summary.counts.possibleDuplicate + summary.counts.conflict], ["Skipped", summary.counts.skipped]] as const;
  return <dl className="grid gap-3 sm:grid-cols-4">{counts.map(([label, value]) => <Fact key={label} label={label} value={String(value)} />)}</dl>;
}

function AttentionDecision({ item, value, onChange }: { item: AttentionItem; value: DecisionAction | undefined; onChange: (value: DecisionAction) => void }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="grid gap-3 lg:grid-cols-2"><TransactionSnapshot label="Statement row" item={item.source} /><TransactionSnapshot label="Possible match" item={item.candidate} /></div>
      <div className="mt-4 flex flex-wrap gap-2">
        <DecisionButton selected={value === "confirm_duplicate"} onClick={() => onChange("confirm_duplicate")}>Same transaction</DecisionButton>
        <DecisionButton selected={value === "keep_separate"} onClick={() => onChange("keep_separate")}>Keep separate</DecisionButton>
        <DecisionButton selected={value === "skip"} onClick={() => onChange("skip")}>Skip row</DecisionButton>
      </div>
    </div>
  );
}

function DecisionButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" size="sm" variant={selected ? "default" : "outline"} onClick={onClick}>{children}</Button>;
}

function TransactionSnapshot({ label, item }: { label: string; item: AttentionItem["source"] }) {
  return <div className="rounded-lg bg-muted/45 p-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 truncate text-sm font-medium">{item.narration}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(item.occurredAt)} · {formatMoney(item.amountMinor, item.currency)}</p></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-muted/25 p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-tabular text-sm font-semibold">{value}</dd></div>;
}

function decisionToAction(decision: AttentionItem["decision"]): DecisionAction {
  if (decision === "confirmed") return "confirm_duplicate";
  if (decision === "rejected") return "keep_separate";
  return "skip";
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "The statement could not be imported.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatFileSize(bytes: number): string {
  return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}
