import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";
import { overlayLayers } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

const EMPTY_VALUE = "__spendlens_empty_value__";

const SelectRoot = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-[var(--shadow-card)] outline-none transition-[border-color,box-shadow] data-[placeholder]:text-muted-foreground hover:border-primary/30 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <CaretDown className="size-4 shrink-0 text-muted-foreground" weight="bold" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <CaretUp className="size-4" weight="bold" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <CaretDown className="size-4" weight="bold" />
    </SelectPrimitive.ScrollDownButton>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn(
          "relative max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-32 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        style={{ zIndex: overlayLayers.floating, ...style }}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-md py-2 pr-8 pl-2 text-sm outline-none focus:bg-muted focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" weight="bold" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

type NativeOption = {
  disabled: boolean;
  key: React.Key;
  label: React.ReactNode;
  value: string;
};

function optionList(children: React.ReactNode): NativeOption[] {
  const options: NativeOption[] = [];

  function visit(nodes: React.ReactNode) {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;

      if (child.type === React.Fragment || child.type === "optgroup") {
        visit((child.props as { children?: React.ReactNode }).children);
        return;
      }

      if (child.type !== "option") return;
      const props = child.props as React.ComponentProps<"option">;
      const value = String(props.value ?? props.children ?? "");
      options.push({
        disabled: Boolean(props.disabled),
        key: child.key ?? value,
        label: props.children,
        value,
      });
    });
  }

  visit(children);
  return options;
}

type SelectProps = Omit<React.ComponentProps<"select">, "onChange" | "value" | "defaultValue"> & {
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  onValueChange?: (value: string) => void;
  value?: string;
};

/**
 * Backwards-compatible shadcn Select. Existing native option children are
 * translated into Radix items so every current form gets the accessible
 * interaction model without changing its business logic.
 */
function Select({
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  children,
  className,
  defaultValue,
  disabled,
  id,
  onBlur,
  onChange,
  onFocus,
  onValueChange,
  value,
}: SelectProps) {
  const options = React.useMemo(() => optionList(children), [children]);
  const toRadixValue = (nextValue: string | undefined) =>
    nextValue === "" ? EMPTY_VALUE : nextValue;
  const fromRadixValue = (nextValue: string) =>
    nextValue === EMPTY_VALUE ? "" : nextValue;

  function changeValue(nextValue: string) {
    const normalizedValue = fromRadixValue(nextValue);
    onValueChange?.(normalizedValue);
    onChange?.({
      currentTarget: { value: normalizedValue },
      target: { value: normalizedValue },
    } as React.ChangeEvent<HTMLSelectElement>);
  }

  const rootProps: React.ComponentProps<typeof SelectPrimitive.Root> = {
    onValueChange: changeValue,
  };
  if (defaultValue !== undefined) rootProps.defaultValue = toRadixValue(defaultValue) ?? EMPTY_VALUE;
  if (disabled !== undefined) rootProps.disabled = disabled;
  if (value !== undefined) rootProps.value = toRadixValue(value) ?? EMPTY_VALUE;

  return (
    <SelectRoot {...rootProps}>
      <SelectTrigger
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={className}
        id={id}
        onBlur={onBlur as unknown as React.FocusEventHandler<HTMLButtonElement>}
        onFocus={onFocus as unknown as React.FocusEventHandler<HTMLButtonElement>}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            disabled={option.disabled}
            key={option.key}
            value={option.value === "" ? EMPTY_VALUE : option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
