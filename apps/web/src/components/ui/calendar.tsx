import { CaretDown, CaretLeft, CaretRight, CaretUp } from "@phosphor-icons/react";
import * as React from "react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { cn } from "@/lib/utils";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      className={cn("p-3", className)}
      classNames={{
        root: cn(defaultClassNames.root, "relative"),
        months: cn(defaultClassNames.months, "flex flex-col gap-4 sm:flex-row"),
        month: cn(defaultClassNames.month, "space-y-3"),
        month_caption: cn(
          defaultClassNames.month_caption,
          "flex h-9 items-center justify-center px-9",
        ),
        caption_label: cn(defaultClassNames.caption_label, "text-sm font-semibold"),
        nav: cn(
          defaultClassNames.nav,
          "absolute inset-x-3 top-3 flex items-center justify-between",
        ),
        button_previous: cn(
          defaultClassNames.button_previous,
          "grid size-9 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40",
        ),
        button_next: cn(
          defaultClassNames.button_next,
          "grid size-9 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40",
        ),
        month_grid: cn(defaultClassNames.month_grid, "w-full border-collapse"),
        weekdays: cn(defaultClassNames.weekdays, "flex"),
        weekday: cn(
          defaultClassNames.weekday,
          "w-9 rounded-md text-center text-[0.72rem] font-medium text-muted-foreground",
        ),
        week: cn(defaultClassNames.week, "mt-1 flex w-full"),
        day: cn(defaultClassNames.day, "relative size-9 p-0 text-center text-sm"),
        day_button: cn(
          defaultClassNames.day_button,
          "grid size-9 place-items-center rounded-md font-normal outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30",
        ),
        selected: cn(
          defaultClassNames.selected,
          "[&>button]:bg-primary [&>button]:font-semibold [&>button]:text-primary-foreground [&>button]:hover:bg-primary",
        ),
        today: cn(
          defaultClassNames.today,
          "[&>button]:border [&>button]:border-primary/35 [&>button]:font-semibold",
        ),
        outside: cn(defaultClassNames.outside, "text-muted-foreground opacity-45"),
        disabled: cn(
          defaultClassNames.disabled,
          "pointer-events-none text-muted-foreground opacity-35",
        ),
        hidden: cn(defaultClassNames.hidden, "invisible"),
        ...classNames,
      }}
      components={{
        Chevron: ({ className: chevronClassName, orientation }) => {
          const Icon =
            orientation === "left"
              ? CaretLeft
              : orientation === "right"
                ? CaretRight
                : orientation === "up"
                  ? CaretUp
                  : CaretDown;
          return <Icon className={cn("size-4", chevronClassName)} weight="bold" />;
        },
      }}
      showOutsideDays={showOutsideDays}
      {...props}
    />
  );
}

export { Calendar };
