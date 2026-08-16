import { CalendarBlank, X } from "@phosphor-icons/react";
import { format } from "date-fns";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serializeDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface DatePickerProps {
  "aria-label"?: string;
  className?: string;
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  max?: string;
  min?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value?: string;
}

function DatePicker({
  "aria-label": ariaLabel,
  className,
  clearable = true,
  disabled,
  id,
  max,
  min,
  onChange,
  placeholder = "Pick a date",
  value,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseDate(value);
  const minimumDate = parseDate(min);
  const maximumDate = parseDate(max);
  const disabledDates = [
    ...(minimumDate ? [{ before: minimumDate }] : []),
    ...(maximumDate ? [{ after: maximumDate }] : []),
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className={cn(
            "h-10 w-full justify-start gap-2.5 px-3 text-left font-normal",
            !selected && "text-muted-foreground",
            className,
          )}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
        >
          <CalendarBlank className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{selected ? format(selected, "dd MMM yyyy") : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          {...(selected ? { defaultMonth: selected } : maximumDate ? { defaultMonth: maximumDate } : {})}
          disabled={disabledDates}
          {...(maximumDate ? { endMonth: maximumDate } : {})}
          mode="single"
          onSelect={(date) => {
            if (!date) return;
            onChange(serializeDate(date));
            setOpen(false);
          }}
          {...(selected ? { selected } : {})}
          {...(minimumDate ? { startMonth: minimumDate } : {})}
        />
        {clearable && selected && (
          <div className="border-t border-border p-2">
            <Button
              className="w-full justify-start"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
              Clear date
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker };
