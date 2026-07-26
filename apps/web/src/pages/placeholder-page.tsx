import type { Icon } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";

export function PlaceholderPage({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: Icon;
  title: string;
}) {
  return (
    <Card>
      <CardContent className="grid min-h-[420px] place-items-center p-8">
        <div className="max-w-md text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl bg-primary/8 text-primary">
            <Icon className="size-5" weight="regular" />
          </span>
          <h2 className="mt-4 text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          <p className="mt-5 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            Ready for its roadmap section
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
