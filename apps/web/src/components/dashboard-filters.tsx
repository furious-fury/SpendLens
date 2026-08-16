import {
  ArrowsCounterClockwise,
  CalendarBlank,
  CaretDown,
  FunnelSimple,
  Wallet,
} from "@phosphor-icons/react";
import type { Account, AnalyticsComparisonQuery, TransactionScope } from "@spendlens/contracts";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface DashboardFiltersValue {
  startDate: string;
  endDate: string;
  currency: string;
  accountIds: string[];
  scopes: TransactionScope[];
  comparison: AnalyticsComparisonQuery;
}

interface DashboardFiltersProps {
  accounts: Account[];
  value: DashboardFiltersValue;
  onChange: (value: DashboardFiltersValue) => void;
  showRangePresets?: boolean;
  disabled?: boolean;
  className?: string;
}

export function DashboardFilters({
  accounts,
  value,
  onChange,
  showRangePresets = false,
  disabled,
  className,
}: DashboardFiltersProps) {
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const selectedAccounts = accounts.filter((account) => value.accountIds.includes(account.id));
  const accountLabel =
    selectedAccounts.length === accounts.length
      ? "All accounts"
      : selectedAccounts.length === 1
        ? selectedAccounts[0]?.displayName
        : `${selectedAccounts.length} accounts`;
  const comparisonMode = value.comparison.mode;
  const selectedRange: DateRangePreset | "custom" = showRangePresets
    ? customRangeOpen
      ? "custom"
      : rangePresetFor(value.startDate, value.endDate)
    : "custom";

  function update(changes: Partial<DashboardFiltersValue>) {
    onChange({ ...value, ...changes });
  }

  function setAccount(accountId: string, checked: boolean) {
    const accountIds = checked
      ? [...new Set([...value.accountIds, accountId])]
      : value.accountIds.filter((id) => id !== accountId);
    if (accountIds.length > 0) update({ accountIds });
  }

  function setScope(selection: string) {
    update({
      scopes: selection === "all" ? ["personal", "business"] : [selection as TransactionScope],
    });
  }

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-card)]",
        className,
      )}
      aria-label="Dashboard filters"
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium md:hidden">
        <FunnelSimple className="size-4 text-primary" />
        Dashboard filters
      </div>
      <div
        className={cn(
          "grid gap-2.5 sm:grid-cols-2",
          showRangePresets
            ? cn(
                "xl:grid-cols-[150px_minmax(250px,1.2fr)_minmax(180px,.85fr)_130px_minmax(180px,.9fr)]",
              )
            : "xl:grid-cols-[minmax(250px,1.2fr)_minmax(180px,.85fr)_110px_130px_minmax(180px,.9fr)]",
        )}
      >
        {showRangePresets ? (
          <FilterField label="Range" icon={<CalendarBlank />}>
            <Select
              value={selectedRange}
              disabled={disabled}
              onChange={(event) => {
                const preset = event.target.value as DateRangePreset | "custom";
                if (preset === "custom") {
                  setCustomRangeOpen(true);
                  return;
                }
                setCustomRangeOpen(false);
                update(dateRangeForPreset(preset, value.endDate));
              }}
              aria-label="Dashboard date range preset"
            >
              <option value="one_month">1 month</option>
              <option value="three_months">3 months</option>
              <option value="year_to_date">Year to date</option>
              <option value="one_year">1 year</option>
              <option value="all_time">All time</option>
              <option value="custom">Custom range</option>
            </Select>
          </FilterField>
        ) : null}
        <FilterField label="Accounts" icon={<Wallet />}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full justify-between px-3 font-normal"
                disabled={disabled}
              >
                <span className="truncate">{accountLabel}</span>
                <CaretDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Include accounts</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={value.accountIds.length === accounts.length}
                onCheckedChange={(checked) => {
                  if (checked) update({ accountIds: accounts.map(({ id }) => id) });
                }}
              >
                All accounts
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {accounts.map((account) => {
                const checked = value.accountIds.includes(account.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={account.id}
                    checked={checked}
                    disabled={checked && value.accountIds.length === 1}
                    onCheckedChange={(next) => setAccount(account.id, next === true)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{account.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {account.institutionName} · {account.baseCurrency}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </FilterField>

        <FilterField label="Currency">
          <Select
            value={value.currency}
            disabled={disabled}
            onChange={(event) => update({ currency: event.target.value })}
            aria-label="Dashboard currency"
          >
            {[...new Set(accounts.map(({ baseCurrency }) => baseCurrency))].map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Scope">
          <Select
            value={value.scopes.length === 2 ? "all" : value.scopes[0]}
            disabled={disabled}
            onChange={(event) => setScope(event.target.value)}
            aria-label="Transaction scope"
          >
            <option value="all">All activity</option>
            <option value="personal">Personal</option>
            <option value="business">Business</option>
          </Select>
        </FilterField>

        <FilterField label="Compare" icon={<ArrowsCounterClockwise />}>
          <Select
            value={comparisonMode}
            disabled={disabled}
            onChange={(event) => {
              const mode = event.target.value;
              update({
                comparison:
                  mode === "none"
                    ? { mode: "none" }
                    : mode === "custom"
                      ? {
                          mode: "custom",
                          startDate: previousPeriod(value.startDate, value.endDate).startDate,
                          endDate: previousPeriod(value.startDate, value.endDate).endDate,
                        }
                      : { mode: "previous_period" },
              });
            }}
            aria-label="Comparison period"
          >
            <option value="previous_period">Previous period</option>
            <option value="custom">Custom period</option>
            <option value="none">No comparison</option>
          </Select>
        </FilterField>
      </div>

      {selectedRange === "custom" ? (
        <fieldset className="mt-3 grid max-w-xl grid-cols-2 gap-2 border-t border-border pt-3" disabled={disabled}>
          <legend className="sr-only">Date range</legend>
          <FilterField label="From" icon={<CalendarBlank />}>
            <DatePicker
              value={value.startDate}
              max={value.endDate}
              disabled={disabled}
              clearable={false}
              onChange={(startDate) => update({ startDate })}
              aria-label="Dashboard start date"
            />
          </FilterField>
          <FilterField label="To">
            <DatePicker
              value={value.endDate}
              min={value.startDate}
              disabled={disabled}
              clearable={false}
              onChange={(endDate) => update({ endDate })}
              aria-label="Dashboard end date"
            />
          </FilterField>
        </fieldset>
      ) : null}

      {value.comparison.mode === "custom" && (
        <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <FilterField label="Comparison from">
            <DatePicker
              value={value.comparison.startDate}
              max={value.comparison.endDate}
              disabled={disabled}
              clearable={false}
              onChange={(startDate) => {
                if (value.comparison.mode !== "custom") return;
                update({
                  comparison: {
                    mode: "custom",
                    startDate,
                    endDate: value.comparison.endDate,
                  },
                });
              }}
            />
          </FilterField>
          <FilterField label="Comparison to">
            <DatePicker
              value={value.comparison.endDate}
              min={value.comparison.startDate}
              disabled={disabled}
              clearable={false}
              onChange={(endDate) => {
                if (value.comparison.mode !== "custom") return;
                update({
                  comparison: {
                    mode: "custom",
                    startDate: value.comparison.startDate,
                    endDate,
                  },
                });
              }}
            />
          </FilterField>
          <p className="pb-2 text-xs text-muted-foreground">KPI changes use these exact dates.</p>
        </div>
      )}
    </section>
  );
}

function FilterField({
  children,
  icon,
  label,
}: {
  children: ReactNode;
  icon?: ReactNode;
  label: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="flex h-4 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon && <span className="[&_svg]:size-3.5">{icon}</span>}
        {label}
      </Label>
      {children}
    </div>
  );
}

export function initialDashboardDates(reference = new Date()): {
  startDate: string;
  endDate: string;
} {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  return {
    startDate: localIsoDate(new Date(year, month, 1)),
    endDate: localIsoDate(new Date(year, month + 1, 0)),
  };
}

export function datesForLatestTransaction(occurredAt: string): {
  startDate: string;
  endDate: string;
} {
  return initialDashboardDates(new Date(occurredAt));
}

type DateRangePreset = "one_month" | "three_months" | "year_to_date" | "one_year" | "all_time";

function dateRangeForPreset(
  preset: DateRangePreset,
  endDate: string,
): { startDate: string; endDate: string } {
  const end = new Date(`${endDate}T00:00:00`);
  const year = end.getFullYear();
  const month = end.getMonth();
  const start =
    preset === "one_month"
      ? new Date(year, month, 1)
      : preset === "three_months"
        ? new Date(year, month - 2, 1)
        : preset === "year_to_date"
          ? new Date(year, 0, 1)
          : preset === "one_year"
            ? new Date(year, month - 11, 1)
            : new Date(1970, 0, 1);
  return { startDate: localIsoDate(start), endDate };
}

function rangePresetFor(startDate: string, endDate: string): DateRangePreset | "custom" {
  return (["one_month", "three_months", "year_to_date", "one_year", "all_time"] as const).find(
    (preset) => dateRangeForPreset(preset, endDate).startDate === startDate,
  ) ?? "custom";
}

export function previousPeriod(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const day = 86_400_000;
  const count = Math.round((end - start) / day) + 1;
  return {
    startDate: new Date(start - count * day).toISOString().slice(0, 10),
    endDate: new Date(start - day).toISOString().slice(0, 10),
  };
}

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
