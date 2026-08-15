import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";
import { overlayLayers } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({
  align = "center",
  className,
  sideOffset = 6,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        className={cn(
          "w-72 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none",
          className,
        )}
        sideOffset={sideOffset}
        style={{ zIndex: overlayLayers.floating, ...style }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
