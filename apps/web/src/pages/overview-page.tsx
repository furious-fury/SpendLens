import { ArrowLineDown, ArrowLineUp, ArrowsLeftRight, Question } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const metrics = [
  { label: "Total inflow", icon: ArrowLineDown },
  { label: "Total outflow", icon: ArrowLineUp },
  { label: "Net cash flow", icon: ArrowsLeftRight },
  { label: "Closing balance", icon: Question },
];

export function OverviewPage() {
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Cash-flow summary">
        {metrics.map(({ label, icon: Icon }) => (
          <Card key={label}>
            <CardHeader className="flex-row items-start justify-between gap-4 pb-3">
              <div>
                <CardDescription>{label}</CardDescription>
                <CardTitle className="mt-2 font-tabular text-2xl">₦—</CardTitle>
              </div>
              <span className="grid size-9 place-items-center rounded-lg bg-primary/8 text-primary">
                <Icon className="size-[18px]" weight="regular" />
              </span>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Waiting for your first statement</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
        <Card className="min-h-[360px]">
          <CardHeader className="border-b border-border">
            <CardTitle>Money movement</CardTitle>
            <CardDescription>Inflow and outflow will appear here after an import.</CardDescription>
          </CardHeader>
          <CardContent className="grid min-h-[276px] place-items-center">
            <EmptyState
              title="No financial history yet"
              description="Import a PalmPay statement to build your private financial timeline."
            />
          </CardContent>
        </Card>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <Card>
            <CardHeader>
              <CardDescription>Classification quality</CardDescription>
              <CardTitle className="font-tabular text-2xl">—</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-0 bg-primary" />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Review coverage will appear after classification.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Needs attention</CardDescription>
              <CardTitle className="font-tabular text-2xl">0 items</CardTitle>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" className="w-full">
                <Link to="/review">Open review queue</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ description, title }: { description: string; title: string }) {
  return (
    <div className="max-w-sm text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
        <ArrowsLeftRight className="size-5" weight="regular" />
      </span>
      <h2 className="mt-4 font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
      <Button asChild className="mt-5">
        <Link to="/imports">Import a statement</Link>
      </Button>
    </div>
  );
}
