import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { overlayLayers } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          "rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md",
          className,
        )}
        sideOffset={sideOffset}
        style={{ zIndex: overlayLayers.floating, ...style }}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
